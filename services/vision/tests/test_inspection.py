"""Prove visual evidence drives existing robot commands through real MCP and services."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import runpy
import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from unittest.mock import patch
from uuid import uuid4

from oi_vision.agent_store import InspectionStore
from oi_vision.agent_transport import McpClient, ToolClient
from oi_vision.contracts import Json, VisionError, now_ms
from oi_vision.inspection import InspectionAgent, InspectionBinding, TERMINAL

ROOT = Path(__file__).resolve().parents[3]
DEMO = runpy.run_path(str(ROOT / "services/vision/examples/run_agent_demo.py"))


class LostReplyClient:
    """Discard one real committed command response to exercise uncertain-outcome recovery."""

    def __init__(self, client: ToolClient) -> None:
        """Wrap a production MCP transport without replacing its services or results."""
        self.client = client
        self.commands: list[Json] = []
        self.lose_reply = True

    def call(self, name: str, arguments: Json) -> Json:
        """Record exact command arguments and simulate loss only after the runtime commits."""
        result = self.client.call(name, arguments)
        if name == "astra.game_command":
            self.commands.append(copy.deepcopy(arguments))
            if self.lose_reply:
                self.lose_reply = False
                raise VisionError("OUTCOME_UNKNOWN", 503)
        return result


@unittest.skipUnless(os.getenv("OI_VISION_MCP_TESTS") == "1", "Enable real service integration with OI_VISION_MCP_TESTS=1")
class InspectionIntegrationTests(unittest.TestCase):
    """Exercise production runtime, pixel processing, workflow persistence and tool discovery."""

    def setUp(self) -> None:
        """Create an isolated two-account match and a camera rendered from authorized state."""
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.demo: Any = DEMO["DemoEnvironment"](ROOT, self.directory)
        self.demo.__enter__()
        self.client = McpClient(ROOT, allow_agent_tools=True)
        self.store = InspectionStore(self.directory / "direct-inspections.sqlite")
        self.binding = InspectionBinding.parse(self.demo.binding)
        self.agent = InspectionAgent(self.client, self.store, self.binding)

    def tearDown(self) -> None:
        """Close clients before services and leave no worker running after a test."""
        self.store.close()
        self.client.close()
        self.demo.close()
        self.temporary.cleanup()

    def settle(self, agent: InspectionAgent, run_id: str) -> Json:
        """Wait on real worker time with a bounded deadline and a stable workflow ID."""
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline:
            result = agent.advance(run_id)
            if result["stage"] in TERMINAL:
                return result
            time.sleep(0.2)
        self.fail("Inspection did not settle")

    def assert_error(self, code: str, operation: Any) -> None:
        """Require stable sanitized failures rather than accidental Python exceptions."""
        with self.assertRaises(VisionError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)

    def test_public_mcp_tools_branch_on_pixels_and_move_robot(self) -> None:
        """Missing marker requests review; visible marker causes actual runtime movement and reinspection."""
        tools = self.client.rpc("tools/list", {})["tools"]
        self.assertIn("astra.agent_inspect_robot", [tool["name"] for tool in tools])
        before_position = self.demo.snapshot()["field"]["robots"][0]["position"]
        self.demo.marker_visible = False
        missing = DEMO["finish_run"](self.client, self.binding.binding_id, str(uuid4()))
        self.assertEqual((missing["stage"], missing["reason"]), ("needs_review", "TARGET_NOT_OBSERVED"))
        self.assertEqual(len(missing["rejected_observations"]), 2)
        self.assertEqual(self.demo.snapshot()["field"]["jobs"], [])
        self.demo.marker_visible = True
        run_id = str(uuid4())
        done = DEMO["finish_run"](self.client, self.binding.binding_id, run_id)
        self.assertEqual(done["stage"], "completed", done)
        self.assertTrue(done["verification"]["robot_moved"])
        self.assertFalse(done["verification"]["physical_motion_verified"])
        self.assertNotEqual(done["before"]["frame_sha256"], done["after"]["frame_sha256"])
        self.assertEqual(done["decision_observation_id"], done["before"]["observation_id"])
        self.assertEqual(done["before"]["opencv_version"].split(".")[0], "5")
        snapshot = self.demo.snapshot()
        self.assertNotEqual(before_position, snapshot["field"]["robots"][0]["position"])
        self.assertEqual(len(snapshot["field"]["jobs"]), 1)
        self.assertEqual(snapshot["field"]["jobs"][0]["state"], "completed")
        for tool in ("astra.agent_read_inspection", "astra.agent_inspect_robot"):
            replay = self.client.call(tool, {"binding_id": self.binding.binding_id, "run_id": run_id})["inspection"]
            self.assertEqual(replay, done)
        self.assertEqual(len(self.demo.snapshot()["field"]["jobs"]), 1)
        serialized = json.dumps(done)
        for private in (self.demo.game_token, self.demo.vision_token, str(self.directory)):
            self.assertNotIn(private, serialized)
        with sqlite3.connect(self.directory / "inspections.sqlite") as database:
            self.assertEqual(database.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_committed_command_lost_reply_and_restart(self) -> None:
        """Retry a prepared command after reopening the policy and transport, without a second job."""
        wrapper = LostReplyClient(self.client)
        agent = InspectionAgent(wrapper, self.store, self.binding)
        run_id = str(uuid4())
        self.assertEqual(agent.advance(run_id)["stage"], "ready")
        pending = agent.advance(run_id)
        self.assertEqual(pending["stage"], "dispatching", pending)
        self.assertTrue(pending["retryable"])
        original = copy.deepcopy(pending["command"])
        self.store.close()
        self.store = InspectionStore(self.directory / "direct-inspections.sqlite")
        self.client.close()
        self.client = McpClient(ROOT)
        wrapper.client = self.client
        resumed = InspectionAgent(wrapper, self.store, self.binding)
        result = self.settle(resumed, run_id)
        self.assertEqual(result["stage"], "completed", result)
        self.assertEqual(wrapper.commands, [original, original])
        self.assertEqual(len(self.demo.snapshot()["field"]["jobs"]), 1)

    def test_stale_camera_scope_and_physical_binding(self) -> None:
        """Reject stale sources and unauthorized or physical robot-camera combinations before any action."""
        self.demo.last_modified = "Thu, 01 Jan 1970 00:00:01 GMT"
        run_id = str(uuid4())
        record = self.agent.advance(run_id)
        self.assertEqual((record["stage"], record["reason"]), ("needs_review", "STALE_FRAME"))
        self.assertEqual(self.demo.snapshot()["field"]["jobs"], [])
        with patch.dict(os.environ, {"ASTRA_GAME_SESSION": self.demo.other_token}):
            other = McpClient(ROOT)
            try:
                unauthorized = InspectionAgent(other, self.store, self.binding)
                self.assert_error("NOT_FOUND", lambda: unauthorized.read(run_id))
                self.assert_error("NOT_FOUND", lambda: unauthorized.advance(str(uuid4())))
            finally:
                other.close()
        self.demo.vision.service.cameras["demo-camera"]["evidence_kind"] = "physical"
        self.assert_error("SIMULATION_REQUIRED", lambda: self.agent.advance(str(uuid4())))

    def test_expired_uncertain_command_requires_reconciliation(self) -> None:
        """An old lost response must never cause a new dispatch or imply cancellation."""
        wrapper = LostReplyClient(self.client)
        agent = InspectionAgent(wrapper, self.store, self.binding)
        run_id = str(uuid4())
        agent.advance(run_id)
        pending = agent.advance(run_id)
        self.assertEqual(pending["stage"], "dispatching")
        expired = InspectionAgent(wrapper, self.store, self.binding, lambda: now_ms() + 120001)
        result = expired.advance(run_id)
        self.assertEqual((result["stage"], result["reason"]), ("needs_review", "UNCERTAIN_COMMAND_EXPIRED"))
        self.assertEqual(expired.advance(run_id), result)
        self.assertEqual(len(wrapper.commands), 1)
        self.assertEqual(len(self.demo.snapshot()["field"]["jobs"]), 1)

    def test_known_revision_conflict_rechecks_before_new_command(self) -> None:
        """An intervening command rejects the old revision; retry revalidates before dispatch."""
        delegate = self.client
        commands: list[Json] = []

        class InterveningCommandClient:
            """Create a real revision conflict by returning the other owned robot home."""

            def call(self, name: str, arguments: Json) -> Json:
                """Exercise the runtime's actual conflict response without changing the prepared payload."""
                if name == "astra.game_command":
                    commands.append(copy.deepcopy(arguments))
                    if len(commands) == 1:
                        snapshot = delegate.call("astra.game_read_match", {
                            "version": 5, "match_id": arguments["match_id"]})["snapshot"]
                        other = next(robot for robot in snapshot["field"]["robots"] if robot["id"] != arguments["robot_id"])
                        delegate.call("astra.game_command", {"version": 5, "command_id": str(uuid4()),
                            "match_id": arguments["match_id"], "expected_revision": snapshot["revision"],
                            "action": "return_robot", "robot_id": other["id"]})
                return delegate.call(name, arguments)

        agent = InspectionAgent(InterveningCommandClient(), self.store, self.binding)
        run_id = str(uuid4())
        agent.advance(run_id)
        conflict = agent.advance(run_id)
        self.assertEqual((conflict["stage"], conflict["reason"]), ("ready", "REVISION_CONFLICT_RECHECK_REQUIRED"))
        result = self.settle(agent, run_id)
        self.assertEqual(result["stage"], "completed", result)
        self.assertNotEqual(commands[0]["command_id"], commands[1]["command_id"])
        self.assertEqual(result["rejected_commands"], commands[:-1])
        own_jobs = [job for job in self.demo.snapshot()["field"]["jobs"] if job["robot_id"] == self.binding.robot_id]
        self.assertEqual(len(own_jobs), 1)

    def test_new_robot_command_blocks_followup_verification(self) -> None:
        """Manual reassignment after the job finishes cannot be attributed to this inspection."""
        run_id = str(uuid4())
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            record = self.agent.advance(run_id)
            if record["stage"] == "verifying":
                break
            self.assertNotIn(record["stage"], TERMINAL)
            time.sleep(0.2)
        self.assertEqual(record["stage"], "verifying")
        snapshot = self.demo.snapshot()
        self.client.call("astra.game_command", {"version": 5, "command_id": str(uuid4()),
            "match_id": self.binding.match_id, "expected_revision": snapshot["revision"],
            "action": "return_robot", "robot_id": self.binding.robot_id})
        result = self.agent.advance(run_id)
        self.assertEqual((result["stage"], result["reason"]), ("needs_review", "ROBOT_MOVED_DURING_VERIFICATION"))

    def test_stale_decision_and_unchanged_followup(self) -> None:
        """Freshness is rechecked before dispatch; completion cannot be inferred from a frozen image."""
        run_id = str(uuid4())
        self.agent.advance(run_id)
        stale = InspectionAgent(self.client, self.store, self.binding, lambda: now_ms() + 120001)
        result = stale.advance(run_id)
        self.assertEqual((result["stage"], result["reason"]), ("needs_review", "STALE_FRAME"))
        self.assertEqual(self.demo.snapshot()["field"]["jobs"], [])
        self.demo.frozen_image = self.demo.image()
        frozen = self.settle(self.agent, str(uuid4()))
        self.assertEqual((frozen["stage"], frozen["reason"]), ("needs_review", "POST_ACTION_UNCHANGED_IMAGE"))
        self.assertEqual(self.demo.snapshot()["field"]["jobs"][0]["state"], "completed")

    def test_parallel_retries_and_binding_changes(self) -> None:
        """Two workers share one intent and durable command; reconfiguration cannot redirect it."""
        run_id = str(uuid4())

        def advance(_: int) -> Json:
            """Give each worker independent transport and SQLite connections."""
            client = McpClient(ROOT)
            store = InspectionStore(self.directory / "direct-inspections.sqlite")
            try:
                return InspectionAgent(client, store, self.binding).advance(run_id)
            finally:
                client.close()
                store.close()

        with ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(advance, range(2)))
            list(executor.map(advance, range(2)))
        result = self.settle(self.agent, run_id)
        self.assertEqual(result["stage"], "completed", result)
        self.assertEqual(len(self.demo.snapshot()["field"]["jobs"]), 1)
        changed = InspectionBinding.parse({**self.demo.binding, "min_luma": 2})
        self.assert_error("RUN_CONFIGURATION_CHANGED", lambda: InspectionAgent(self.client, self.store, changed).advance(run_id))
        self.assertEqual(self.store.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")


if __name__ == "__main__":
    unittest.main()
