"""Test actual sample-farm vision gates, idempotency and persistent control boundaries."""

from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import threading
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import unittest
from uuid import uuid4

import numpy as np

from oi_vision.farm import FarmError, FarmRuntime, analyze_pixels
from oi_vision.farm_cli import handler_for


class FarmPixelTests(unittest.TestCase):
    """Color evidence must come from the pickup pixels, not a crop label."""

    def test_absent_target_and_target_outside_roi_do_not_pass(self) -> None:
        """Unrelated orange pixels outside the calibrated region cannot authorize harvest."""
        pixels = np.zeros((240, 320, 3), dtype=np.uint8)
        pixels[:20, :20] = (255, 100, 0)
        self.assertFalse(analyze_pixels(pixels, 2)["target_visible"])
        pixels[115:125, 155:165] = (255, 100, 0)
        self.assertTrue(analyze_pixels(pixels, 2)["target_visible"])
        self.assertFalse(analyze_pixels(pixels, 1)["target_visible"])


@unittest.skipUnless(os.environ.get("OI_FARM_SOURCE"), "Set OI_FARM_SOURCE to the pinned sample farm checkout")
class FarmControlTests(unittest.TestCase):
    """Exercise the original MuJoCo models and software-rendered OpenCV evidence."""

    def setUp(self) -> None:
        """Use an independent station and controllable test clock, never a running farm."""
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name)
        self.source = Path(os.environ["OI_FARM_SOURCE"])
        self.time = 0.
        self.runtime = FarmRuntime(self.source, self.directory, lambda: self.time)

    def tearDown(self) -> None:
        """Release SQLite and the directory lease even after assertion failures."""
        self.runtime.close()
        self.tmp.cleanup()

    def request(self, action: str, **extra: object) -> dict:
        """Construct the same bounded request as an external agent."""
        return {"command_id": str(uuid4()), "expected_revision": self.runtime.status()["revision"],
                "action": action, **extra}

    def complete(self) -> None:
        """Advance the deterministic test clock; production accepts no time/pose input."""
        for _ in range(320):
            if not self.runtime.status()["active_job"]:
                return
            self.time += .25
            self.runtime.tick()
        self.fail("bounded segment did not finish")

    def test_idle_move_pause_restart_resume_and_idempotency(self) -> None:
        """Only accepted commands move; retries and restart retain the same active job."""
        initial = self.runtime.status()
        self.time = 100
        self.runtime.tick()
        self.assertEqual(initial, self.runtime.status())
        request = self.request("move_to_next_bed")
        receipt = self.runtime.command(request)
        self.assertEqual(receipt, self.runtime.command(request))
        with self.assertRaisesRegex(FarmError, "COMMAND_ID_REUSED"):
            self.runtime.command({**request, "action": "return_home"})
        self.time += .25
        self.runtime.tick()
        self.runtime.command(self.request("pause"))
        elapsed = self.runtime.status()["elapsed"]
        self.time += 10
        self.runtime.tick()
        self.assertEqual(elapsed, self.runtime.status()["elapsed"])
        self.runtime.close()
        self.runtime = FarmRuntime(self.source, self.directory, lambda: self.time)
        self.assertEqual(receipt, self.runtime.command(request))
        self.assertTrue(self.runtime.status()["paused"])
        self.runtime.command(self.request("resume"))
        self.complete()
        self.assertEqual(self.runtime.job(request["command_id"])["stage"], "completed")
        self.assertEqual(self.runtime.status()["next_action"], "harvest")

    def test_real_pixels_gate_harvest_and_verify_deposit(self) -> None:
        """Actual rendered crop pixels authorize only the current bed/revision and show removal."""
        with self.runtime.db:
            stale = self.runtime.capture(2)
        self.runtime.command(self.request("move_to_next_bed"))
        self.complete()
        with self.assertRaisesRegex(FarmError, "EVIDENCE_MISMATCH"):
            self.runtime.command(self.request("harvest", observation_id=stale["observation_id"]))
        with self.runtime.db:
            before = self.runtime.capture(2)
        self.assertTrue(before["analysis"]["target_visible"])
        request = self.request("harvest", observation_id=before["observation_id"])
        self.runtime.command(request)
        self.complete()
        job = self.runtime.job(request["command_id"])
        self.assertEqual(job["stage"], "completed", job)
        self.assertTrue(all(job["verification"].values()))
        self.assertEqual(self.runtime.status()["deposited"], [2])
        self.assertFalse(self.runtime.frame(job["after_observation_id"])[0]["analysis"]["target_visible"])

    def test_absent_evidence_and_stale_revision_never_create_job(self) -> None:
        """Blank pixels and concurrent stale requests fail before a command is persisted."""
        old = self.request("move_to_next_bed")
        self.runtime.command(old)
        self.complete()
        with self.assertRaisesRegex(FarmError, "REVISION_CONFLICT"):
            self.runtime.command({**old, "command_id": str(uuid4())})
        with self.runtime.db:
            observation = self.runtime.capture(2)
            observation["analysis"] = analyze_pixels(np.zeros((240, 320, 3), dtype=np.uint8), 2)
            self.runtime.db.execute("UPDATE frames SET body=? WHERE id=?",
                                    (json.dumps(observation), observation["observation_id"]))
        with self.assertRaisesRegex(FarmError, "TARGET_NOT_OBSERVED"):
            self.runtime.command(self.request("harvest", observation_id=observation["observation_id"]))
        self.assertIsNone(self.runtime.status()["active_job"])
        self.assertEqual(self.runtime.db.execute("SELECT count(*) FROM jobs").fetchone()[0], 1)

    def test_http_control_requires_bearer_and_rejects_browser_origin(self) -> None:
        """Neither unauthenticated callers nor a browser origin can issue robot commands."""
        with ThreadingHTTPServer(("127.0.0.1", 0), handler_for(self.runtime, "test-token", self.source)) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/command"
                body = json.dumps(self.request("move_to_next_bed")).encode()
                for headers in ({}, {"Authorization": "Bearer wrong"},
                                {"Authorization": "Bearer test-token", "Origin": "https://example.com"}):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(Request(url, data=body, headers=headers), timeout=5)
                    self.assertEqual(error.exception.code, 401)
                self.assertIsNone(self.runtime.status()["active_job"])
                with urlopen(Request(url, data=body, headers={"Authorization": "Bearer test-token"}), timeout=5) as response:
                    self.assertTrue(json.load(response)["receipt"]["accepted"])
            finally:
                server.shutdown()
                thread.join(timeout=5)
