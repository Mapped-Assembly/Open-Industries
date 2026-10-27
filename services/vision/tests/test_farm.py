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

from oi_vision.farm import FarmError, FarmRuntime, analyze_pixels, analyze_pov
from oi_vision.farm_cli import handler_for


class FarmPixelTests(unittest.TestCase):
    """Color evidence must come from the pickup pixels, not a crop label."""

    def test_live_pov_contours_follow_pixels(self) -> None:
        """Live boxes come from image contours and disappear when color disappears."""
        pixels = np.zeros((160, 256, 4), dtype=np.uint8)
        self.assertEqual(analyze_pov(pixels.tobytes())["boxes"], [])
        pixels[40:60, 70:100, :3] = (255, 0, 0)
        result = analyze_pov(pixels.tobytes())
        self.assertEqual(result["boxes"][0]["label"], "red")
        self.assertEqual(result["boxes"][0]["box"], [70, 40, 30, 20])
        with self.assertRaisesRegex(FarmError, "INVALID_REQUEST"):
            analyze_pov(b"bad")

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
                base = f"http://127.0.0.1:{server.server_port}"
                with urlopen(base, timeout=5) as response:
                    page = response.read().decode()
                import re
                capability = re.search(r"'X-Farm-Demo':'([a-f0-9]+)'", page)[1]
                self.assertNotIn("test-token", page)
                control = json.dumps(self.request("new_run")).encode()
                for headers in ({}, {"Origin": base, "X-Farm-Demo": "wrong"},
                                {"Origin": "https://example.com", "X-Farm-Demo": capability}):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(Request(base+"/api/control", data=control, headers=headers), timeout=5)
                    self.assertEqual(error.exception.code, 401)
                self.complete()
                control = json.dumps(self.request("new_run")).encode()
                with urlopen(Request(base+"/api/control", data=control,
                                    headers={"Origin": base, "X-Farm-Demo": capability}), timeout=5) as response:
                    self.assertEqual(json.load(response)["receipt"]["action"], "new_run")
            finally:
                server.shutdown()
                thread.join(timeout=5)

    def test_demo_controller_restart_and_preserved_runs(self) -> None:
        """A browser-started route survives pause/restart and a reset retains original evidence."""
        self.runtime.demo_command(self.request("start"))
        self.time += .25
        self.runtime.tick()
        self.runtime.demo_command(self.request("pause"))
        elapsed = self.runtime.status()["elapsed"]
        self.runtime.close()
        self.runtime = FarmRuntime(self.source, self.directory, lambda: self.time)
        self.time += 10
        self.runtime.tick()
        self.assertEqual(elapsed, self.runtime.status()["elapsed"])
        self.runtime.demo_command(self.request("resume"))
        for _ in range(400):
            self.time += .25
            self.runtime.tick()
        self.assertEqual(self.runtime.status()["controller"], "completed")
        evidence = self.runtime.evidence()
        self.assertEqual(len(evidence["frames"]), 6)
        self.assertEqual(len(evidence["jobs"]), 7)
        old_run = self.runtime.status()["run_id"]
        reset = self.request("new_run")
        receipt = self.runtime.demo_command(reset)
        self.assertEqual(receipt, self.runtime.demo_command(reset))
        self.assertNotEqual(old_run, receipt["run_id"])
        self.assertEqual(self.runtime.status()["deposited"], [])
        self.assertEqual(self.runtime.evidence()["jobs"], [])
        self.assertEqual(self.runtime.evidence()["history"][0]["run_id"], old_run)
        for frame in evidence["frames"]:
            self.assertEqual(self.runtime.frame(frame["observation_id"])[0], frame)
        with self.assertRaisesRegex(FarmError, "REVISION_CONFLICT"):
            self.runtime.demo_command({**reset, "command_id": str(uuid4())})
