"""Exercise durable robot authority and policy boundaries without a paid model."""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from uuid import uuid4

import numpy as np

from oi_embodied.model import RobotModel
from oi_embodied.policy import Policy
from oi_embodied.runtime import Runtime

FIXTURE = Path(__file__).resolve().parents[3] / 'benchmarks/embodied'


class DelayedPolicy(Policy):
    """An injected deterministic proposal tests races; it is not live-model evidence."""

    def __init__(self, result: dict) -> None:
        """Hold inference until a test releases it."""
        self.mode = 'test-double'
        self.result = result
        self.entered = threading.Event()
        self.release = threading.Event()

    def decide(self, text: str, selected: str | None, manifest: dict) -> dict:
        """Return the scripted proposal after Stop can overtake inference."""
        self.entered.set()
        self.release.wait(5)
        return self.result


class RuntimeTests(unittest.TestCase):
    """Use real SQLite/worker/IK while keeping provider requests deterministic."""

    def setUp(self) -> None:
        """Create an isolated state directory and enter Run mode explicitly."""
        self.directory = tempfile.TemporaryDirectory()
        self.runtime = Runtime(Path(self.directory.name), FIXTURE)
        self.send('run')

    def tearDown(self) -> None:
        """Close every live worker and its file lease."""
        self.runtime.close()
        self.directory.cleanup()

    def body(self, action: str, text: str = '', selected: str | None = None) -> dict:
        """Create a fresh correlated intent against the current scene pin."""
        state = self.runtime.snapshot()
        return {'task_id': state['task']['id'] if state['task'] else None, 'request_id': str(uuid4()), 'run_id': state['run_id'], 'action': action,
                'text': text, 'selected_id': selected, 'scene_revision': state['scene_revision']}

    def send(self, action: str, text: str = '', selected: str | None = None) -> dict:
        """Submit an authorized in-process intent through normal request validation."""
        return self.runtime.request(self.body(action, text, selected))

    def wait_stage(self, *stages: str) -> dict:
        """Bound all worker waits so a stalled controller fails the test."""
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            state = self.runtime.snapshot()
            if state['task'] and state['task']['stage'] in stages:
                return state
            time.sleep(.02)
        self.fail(f'Task did not reach {stages}: {self.runtime.snapshot()["task"]}')

    def test_motion_receipt_pause_restart_and_no_object_teleport(self) -> None:
        """A live job resumes exactly once, with observed postconditions and unchanged objects."""
        original = self.runtime.snapshot()
        body = self.body('chat', 'approach selected', 'red-block')
        receipt = self.runtime.request(body)
        self.assertEqual(receipt, self.runtime.request(body))
        self.wait_stage('running')
        time.sleep(.15)
        start = time.monotonic()
        self.send('stop')
        self.assertLess(time.monotonic() - start, .25)
        paused = self.runtime.snapshot()
        time.sleep(.15)
        self.assertEqual(paused['q'], self.runtime.snapshot()['q'])
        self.runtime.close()
        self.runtime = Runtime(Path(self.directory.name), FIXTURE)
        recovered = self.runtime.snapshot()
        self.assertEqual(recovered['run_id'], original['run_id'])
        self.assertEqual(recovered['q'], paused['q'])
        self.assertEqual(recovered['task']['id'], receipt['task_id'])
        self.assertEqual(self.runtime.request(body), receipt)
        self.send('resume')
        done = self.wait_stage('completed', 'needs_review')
        self.assertEqual(done['task']['stage'], 'completed', done['task'])
        self.assertEqual(done['objects'], original['objects'])
        self.assertTrue(done['task']['result']['motion_completed'])
        self.assertFalse(done['task']['result']['contact_validated'])
        self.assertLess(done['task']['result']['tcp_error_m_or_home_joint_error_rad'], .003)
        self.assertEqual(done['task']['id'], receipt['task_id'])
        self.assertTrue(done['task']['before_observation'])
        self.assertTrue(done['task']['after_observation'])

    def test_missing_selection_and_unsupported_request_do_not_move(self) -> None:
        """Manual grammar never pretends to be natural language or invents a target."""
        original = self.runtime.snapshot()['q']
        self.send('chat', 'approach selected')
        self.assertIn('CLARIFICATION', self.wait_stage('needs_review')['task']['reason'])
        self.send('chat', 'pick up the block and place it')
        self.assertIn('MANUAL_MODE', self.wait_stage('needs_review')['task']['reason'])
        self.assertEqual(original, self.runtime.snapshot()['q'])

    def test_stop_overtakes_model_and_cancel_allows_new_goal(self) -> None:
        """A delayed proposal cannot start motion after controller Stop acknowledgement."""
        policy = DelayedPolicy({'skill': 'approach', 'target_id': 'red-block'})
        self.runtime.policy = policy
        self.send('chat', 'approach selected', 'red-block')
        self.assertTrue(policy.entered.wait(2))
        original = self.runtime.snapshot()['q']
        self.send('stop')
        policy.release.set()
        time.sleep(.3)
        self.assertEqual(self.runtime.snapshot()['task']['stage'], 'paused')
        self.assertEqual(self.runtime.snapshot()['q'], original)
        self.send('cancel')
        self.runtime.policy = Policy()
        self.send('chat', 'inspect red-block')
        self.wait_stage('completed')

    def test_model_cannot_override_grounding_or_manipulation_boundary(self) -> None:
        """Even well-formed model proposals cannot choose another object or fake pick/place."""
        for text, proposal, reason in [
            ('approach selected', {'skill': 'approach', 'target_id': 'blue-block'}, 'GROUNDING_MISMATCH'),
            ('put this in the marked area', {'skill': 'approach', 'target_id': 'red-block'}, 'UNSUPPORTED_MANIPULATION'),
            ('approach selected', {'skill': 'teleport', 'target_id': 'red-block'}, 'UNSUPPORTED_SKILL'),
        ]:
            policy = DelayedPolicy(proposal)
            policy.release.set()
            self.runtime.policy = policy
            self.send('chat', text, 'red-block')
            self.assertIn(reason, self.wait_stage('needs_review')['task']['reason'])

    def test_edit_run_boundary_cross_run_and_request_reuse(self) -> None:
        """Explicit edits create new scene revisions; old requests and foreign runs are refused."""
        with self.assertRaisesRegex(ValueError, 'EDIT_MODE_REQUIRED'):
            self.send('edit_object', '[0.2,0,0.015]', 'red-block')
        stale = self.body('chat', 'approach red-block')
        self.send('edit')
        self.send('edit_object', '[0.2,0,0.015]', 'red-block')
        self.send('run')
        with self.assertRaisesRegex(ValueError, 'SCENE_CHANGED'):
            self.runtime.request(stale)
        body = self.body('status')
        self.runtime.request(body)
        body['text'] = 'different'
        with self.assertRaisesRegex(ValueError, 'REQUEST_ID_REUSED'):
            self.runtime.request(body)
        body = self.body('status')
        body['run_id'] = str(uuid4())
        with self.assertRaisesRegex(ValueError, 'RUN_NOT_AVAILABLE'):
            self.runtime.request(body)

    def test_receipt_capacity_does_not_disable_stop(self) -> None:
        """Budget exhaustion refuses new goals while preserving direct Stop and Cancel."""
        policy = DelayedPolicy({'skill': 'approach', 'target_id': 'red-block'})
        self.runtime.policy = policy
        self.send('chat', 'approach selected', 'red-block')
        self.assertTrue(policy.entered.wait(2))
        try:
            with self.runtime.lock:
                self.runtime.db.executemany('INSERT INTO receipts VALUES(?,?,?)', [(str(uuid4()), '{}', '{}') for _ in range(512)])
                self.runtime.db.commit()
            self.send('stop')
            self.assertEqual(self.runtime.snapshot()['task']['stage'], 'paused')
            with self.runtime.lock:
                count = self.runtime.db.execute('SELECT count(*) FROM receipts').fetchone()[0]
            self.send('stop')
            with self.runtime.lock:
                self.assertEqual(count, self.runtime.db.execute('SELECT count(*) FROM receipts').fetchone()[0])
            self.send('cancel')
        finally:
            policy.release.set()

    def test_three_target_poses_and_unreachable_rejection(self) -> None:
        """IK uses actual targets and joint limits, not a stored demonstration route."""
        model = RobotModel(FIXTURE)
        for point in ([.15, -.05, .015], [.17, .05, .015], [.2, 0, .015]):
            goal = model.approach(model.home.tolist(), point)
            self.assertLess(np.linalg.norm(model.tcp(goal) - (np.array(point) + [0, 0, .1])), .003)
            self.assertTrue(np.all(np.array(goal) >= model.lower))
            self.assertTrue(np.all(np.array(goal) <= model.upper))
        with self.assertRaisesRegex(ValueError, 'UNREACHABLE_TARGET'):
            model.approach(model.home.tolist(), [2, 0, .015])

    def test_state_change_while_planning_requires_review(self) -> None:
        """A stale target proposal cannot dispatch even if the provider returns valid JSON."""
        policy = DelayedPolicy({'skill': 'approach', 'target_id': 'red-block'})
        self.runtime.policy = policy
        self.send('chat', 'approach selected', 'red-block')
        self.assertTrue(policy.entered.wait(2))
        with self.runtime.lock:
            self.runtime.state['objects'][0]['position_m'][0] += .01
        policy.release.set()
        self.assertIn('STATE_CHANGED', self.wait_stage('needs_review')['task']['reason'])


if __name__ == '__main__':
    unittest.main()
