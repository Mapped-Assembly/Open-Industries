"""Exercise real OpenCV, durable evidence, source adapters and the actual MCP bridge."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import queue
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import cv2
import numpy as np
from PIL import Image

from oi_vision.cameras import HttpSnapshotCamera
from oi_vision.contracts import MAX_IMAGE_BYTES, VisionError, now_ms
from oi_vision.http_server import VisionHttpServer
from oi_vision.processing import check_opencv, decode_image
from oi_vision.service import VisionService
from oi_vision.store import ObservationStore

ROOT = Path(__file__).resolve().parents[3]


def write_image(path: Path, yellow: bool = True) -> bytes:
    """Generate declared fixture pixels with independently known region positions."""
    image = np.zeros((80, 100, 3), dtype=np.uint8)
    if yellow:
        cv2.rectangle(image, (10, 12), (29, 31), (0, 255, 255), -1)
        cv2.rectangle(image, (60, 40), (75, 55), (0, 255, 255), -1)
    cv2.rectangle(image, (30, 45), (45, 60), (255, 0, 0), -1)
    success, encoded = cv2.imencode(".png", image)
    if not success:
        raise AssertionError("Fixture encoding failed")
    data = encoded.tobytes()
    path.write_bytes(data)
    return data


class VisionFixture(unittest.TestCase):
    """Prepare two machine scopes, independent tokens and real source pixels."""

    def setUp(self) -> None:
        """Create a temporary configured service backed by file-based SQLite."""
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.image = self.directory / "frame.png"
        self.bytes = write_image(self.image)
        self.clock_value = now_ms()
        self.token_a, self.token_b = secrets.token_hex(32), secrets.token_hex(32)
        self.env = patch.dict(os.environ, {"OI_TEST_A": self.token_a, "OI_TEST_B": self.token_b})
        self.env.start()
        self.config = {"cameras": [
            {"camera_id": "overhead", "machine_id": "arm-a", "adapter": "file", "path": "frame.png", "evidence_kind": "fixture"},
            {"camera_id": "private-camera", "machine_id": "arm-b", "adapter": "file", "path": "frame.png", "evidence_kind": "fixture"}],
            "principals": [
                {"principal_id": "agent-a", "machines": ["arm-a"], "token_env": "OI_TEST_A"},
                {"principal_id": "agent-b", "machines": ["arm-b"], "token_env": "OI_TEST_B"}],
            "profiles": [
                {"profile_id": "quality", "type": "image_quality"},
                {"profile_id": "yellow", "type": "color_regions", "label": "yellow-region",
                 "lower_hsv": [20, 100, 100], "upper_hsv": [40, 255, 255], "min_area_px": 20}]}
        self.config_path = self.directory / "config.json"
        self.config_path.write_text(json.dumps(self.config))
        self.database = self.directory / "vision.sqlite"
        self.store = ObservationStore(self.database)
        self.service = VisionService(self.config_path, self.store, lambda: self.clock_value)
        self.principal = self.service.authenticate(f"Bearer {self.token_a}")

    def tearDown(self) -> None:
        """Release native database handles and restore the process environment."""
        self.store.close()
        self.env.stop()
        self.temp.cleanup()

    def capture(self, request_id: str = "capture-1") -> dict[str, Any]:
        """Acquire a new fixture frame through the production dispatcher."""
        return self.service.dispatch(self.principal, "/v1/frames/capture",
                                     {"camera_id": "overhead", "request_id": request_id})["frame"]

    def analyze(self, frame_id: str, request_id: str = "analyze-1") -> dict[str, Any]:
        """Run the real HSV detector using an explicitly bounded evidence age."""
        return self.service.dispatch(self.principal, "/v1/frames/analyze",
                                     {"frame_id": frame_id, "profile_id": "yellow",
                                      "request_id": request_id, "max_age_ms": 60000})["observation"]

    def assert_error(self, code: str, operation: Any) -> None:
        """Check stable public error codes without inspecting private exception causes."""
        with self.assertRaises(VisionError) as raised:
            operation()
        self.assertEqual(raised.exception.code, code)


class EvidenceTests(VisionFixture):
    """Validate pixel-derived results and the immutable evidence lifecycle."""

    def test_pixel_pipeline_and_changed_input(self) -> None:
        """Output must change when yellow pixels disappear, preserving original evidence."""
        self.assertTrue(check_opencv().startswith("5."))
        frame = self.capture()
        self.assertEqual(frame["sha256"], hashlib.sha256(self.bytes).hexdigest())
        self.assertEqual((frame["width"], frame["height"]), (100, 80))
        observation = self.analyze(frame["frame_id"])
        self.assertEqual(observation["detection_count"], 2)
        self.assertEqual(observation["detections"][0]["bbox_px"], [10, 12, 20, 20])
        self.assertEqual(observation["detections"][1]["bbox_px"], [60, 40, 16, 16])
        self.assertEqual(observation["detections"][0]["centroid_px"], [19.5, 21.5])
        self.assertEqual(observation["frame_sha256"], frame["sha256"])
        self.assertEqual(observation["evidence_kind"], "fixture")
        write_image(self.image, yellow=False)
        changed = self.capture("capture-2")
        self.assertNotEqual(frame["sha256"], changed["sha256"])
        self.assertEqual(self.analyze(changed["frame_id"], "analyze-2")["detection_count"], 0)
        self.assertEqual(self.store.frame(frame["frame_id"])[1], self.bytes)

    def test_idempotency_restart_and_stale_receipts(self) -> None:
        """Lost-response retries survive restart and cannot silently turn into new captures."""
        frame = self.capture()
        observation = self.analyze(frame["frame_id"])
        write_image(self.image, yellow=False)
        self.store.close()
        self.store = ObservationStore(self.database)
        self.clock_value += 120000
        self.service = VisionService(self.config_path, self.store, lambda: self.clock_value)
        self.assertEqual(self.capture(), frame)
        self.assertEqual(self.analyze(frame["frame_id"]), observation)
        self.assert_error("STALE_FRAME", lambda: self.analyze(frame["frame_id"], "new-analysis"))
        self.assert_error("REQUEST_ID_REUSED", lambda: self.service.dispatch(
            self.principal, "/v1/frames/analyze", {"frame_id": frame["frame_id"], "profile_id": "quality",
                                                   "request_id": "analyze-1", "max_age_ms": 60000}))

    def test_machine_isolation_for_frames_and_history(self) -> None:
        """A second machine's token cannot enumerate or read the first machine's evidence."""
        frame = self.capture()
        observation = self.analyze(frame["frame_id"])
        other = self.service.authenticate(f"Bearer {self.token_b}")
        listed = self.service.dispatch(other, "/v1/cameras/list", {})
        self.assertEqual([camera["camera_id"] for camera in listed["cameras"]], ["private-camera"])
        for route, args in [
            ("/v1/frames/read", {"frame_id": frame["frame_id"]}),
            ("/v1/frames/analyze", {"frame_id": frame["frame_id"], "profile_id": "yellow", "request_id": "forbidden", "max_age_ms": 1000}),
            ("/v1/observations/read", {"observation_id": observation["observation_id"]}),
            ("/v1/observations/list", {"camera_id": "overhead", "limit": 10}),
        ]:
            self.assert_error("NOT_FOUND", lambda route=route, args=args: self.service.dispatch(other, route, args))
        serialized = json.dumps(listed)
        self.assertNotIn(str(self.directory), serialized)
        self.assertNotIn(self.token_b, serialized)

    def test_concurrent_duplicate_capture(self) -> None:
        """Simultaneous identical request IDs produce one persisted frame and receipt."""
        with ThreadPoolExecutor(max_workers=4) as executor:
            records = list(executor.map(lambda _: self.capture(), range(4)))
        self.assertTrue(all(record == records[0] for record in records))
        self.assertEqual(self.store.connection.execute("SELECT count(*) FROM frames").fetchone()[0], 1)

    def test_reassigned_camera_hides_historical_receipts(self) -> None:
        """Reassigning a camera and principal never re-exposes the former machine's data."""
        frame = self.capture()
        observation = self.analyze(frame["frame_id"])
        self.config["cameras"][0]["machine_id"] = "arm-b"
        self.config["principals"][0]["machines"] = ["arm-b"]
        self.config_path.write_text(json.dumps(self.config))
        self.service = VisionService(self.config_path, self.store, lambda: self.clock_value)
        self.principal = self.service.authenticate(f"Bearer {self.token_a}")
        self.assert_error("NOT_FOUND", self.capture)
        self.assert_error("NOT_FOUND", lambda: self.service.dispatch(
            self.principal, "/v1/frames/read", {"frame_id": frame["frame_id"]}))
        self.assert_error("NOT_FOUND", lambda: self.service.dispatch(
            self.principal, "/v1/observations/read", {"observation_id": observation["observation_id"]}))
        history = self.service.dispatch(self.principal, "/v1/observations/list", {"camera_id": "overhead", "limit": 10})
        self.assertEqual(history["observations"], [])
        self.assertEqual(self.capture("new-owner-capture")["machine_id"], "arm-b")

    def test_database_identity_and_newer_schema_are_preserved(self) -> None:
        """Refuse an unrelated or newer database without modifying its contents."""
        other_path = self.directory / "other.sqlite"
        with sqlite3.connect(other_path) as connection:
            connection.execute("CREATE TABLE unrelated (value TEXT)")
            connection.execute("INSERT INTO unrelated VALUES ('keep me')")
        self.assert_error("STORE_INCOMPATIBLE", lambda: ObservationStore(other_path))
        with sqlite3.connect(other_path) as connection:
            self.assertEqual(connection.execute("SELECT value FROM unrelated").fetchone()[0], "keep me")
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 0)
        newer_path = self.directory / "newer.sqlite"
        newer = ObservationStore(newer_path)
        newer.close()
        with sqlite3.connect(newer_path) as connection:
            connection.execute("PRAGMA user_version=2")
        self.assert_error("STORE_INCOMPATIBLE", lambda: ObservationStore(newer_path))
        with sqlite3.connect(newer_path) as connection:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 2)

    def test_source_age_and_clock_rollback(self) -> None:
        """A recently fetched old file is stale; a rolled-back service clock also fails."""
        old = (self.clock_value - 120000) / 1000
        os.utime(self.image, (old, old))
        frame = self.capture()
        self.assert_error("STALE_FRAME", lambda: self.analyze(frame["frame_id"]))
        self.clock_value -= 1000
        self.assert_error("STALE_FRAME", lambda: self.analyze(frame["frame_id"], "rollback"))

    def test_quota_and_invalid_image_rollback(self) -> None:
        """Failed ingestion leaves neither orphan frames nor successful receipts."""
        self.store.max_bytes = 10
        self.assert_error("STORAGE_LIMIT", self.capture)
        self.store.max_bytes = 64 * 1024 * 1024
        self.image.write_bytes(b"this is not a camera image")
        self.assert_error("INVALID_IMAGE", self.capture)
        self.assertEqual(self.store.connection.execute("SELECT count(*) FROM frames").fetchone()[0], 0)
        self.assertEqual(self.store.connection.execute("SELECT count(*) FROM receipts").fetchone()[0], 0)
        write_image(self.image)
        self.capture()

    def test_bounds_and_bad_configuration(self) -> None:
        """Reject unbounded images, boolean limits, unknown fields and duplicate credentials."""
        self.assert_error("INVALID_REQUEST", lambda: self.service.dispatch(
            self.principal, "/v1/observations/list", {"camera_id": "overhead", "limit": True}))
        self.assert_error("INVALID_REQUEST", lambda: self.service.dispatch(
            self.principal, "/v1/frames/capture", {"camera_id": "overhead", "request_id": "r", "url": "http://untrusted"}))
        self.assert_error("IMAGE_TOO_LARGE", lambda: decode_image(b"a" * (MAX_IMAGE_BYTES + 1)))
        oversized = self.directory / "large.png"
        Image.new("RGB", (4097, 1)).save(oversized)
        self.assert_error("IMAGE_TOO_LARGE", lambda: decode_image(oversized.read_bytes()))
        self.config["principals"][1]["token_env"] = "OI_TEST_A"
        self.config_path.write_text(json.dumps(self.config))
        self.assert_error("INVALID_CONFIGURATION", lambda: VisionService(self.config_path, self.store))

    def test_preview_and_history(self) -> None:
        """Evidence preview is a real image with a separate hash; history preserves provenance."""
        frame = self.capture()
        observation = self.analyze(frame["frame_id"])
        result = self.service.dispatch(self.principal, "/v1/frames/read", {"frame_id": frame["frame_id"]})
        data = base64.b64decode(result["preview"]["data"])
        self.assertEqual(hashlib.sha256(data).hexdigest(), result["preview"]["sha256"])
        self.assertEqual(decode_image(data)[0].shape, (80, 100, 3))
        history = self.service.dispatch(self.principal, "/v1/observations/list", {"camera_id": "overhead", "limit": 10})
        self.assertEqual(history["observations"], [observation])


class HttpTests(VisionFixture):
    """Verify the real HTTP boundary and trusted remote camera adapter."""

    def setUp(self) -> None:
        """Run a production HTTP server on an ephemeral loopback port."""
        super().setUp()
        self.server = VisionHttpServer(("127.0.0.1", 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self) -> None:
        """Wait for HTTP handlers before closing their SQLite connection."""
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        super().tearDown()

    def post(self, path: str, args: Any, token: str | None = None,
             extra_headers: dict[str, str] | None = None) -> tuple[int, dict[str, Any]]:
        """Make an actual JSON request and retain only structured response data."""
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        headers.update(extra_headers or {})
        request = Request(self.base + path, data=json.dumps(args).encode(), headers=headers)
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except HTTPError as exc:
            return exc.code, json.load(exc)

    def test_http_auth_validation_and_pixels(self) -> None:
        """Authentication, origin checks and image capture hold at the network boundary."""
        self.assertEqual(self.post("/v1/cameras/list", {})[0], 401)
        self.assertEqual(self.post("/v1/cameras/list", {}, self.token_a, {"Origin": "https://untrusted.test"})[0], 403)
        status, captured = self.post("/v1/frames/capture", {"camera_id": "overhead", "request_id": "http-1"}, self.token_a)
        self.assertEqual(status, 200)
        status, result = self.post("/v1/frames/analyze", {"frame_id": captured["frame"]["frame_id"],
            "profile_id": "yellow", "request_id": "http-2", "max_age_ms": 60000}, self.token_a)
        self.assertEqual(status, 200)
        self.assertEqual(result["observation"]["detection_count"], 2)
        self.assertEqual(self.post("/v1/cameras/list", {"extra": True}, self.token_a)[0], 400)

    def test_http_camera_redirects_and_unknown_source_time(self) -> None:
        """Read real snapshot bytes, preserve unknown exposure time and reject redirects."""
        data = self.bytes

        class SnapshotHandler(BaseHTTPRequestHandler):
            """A controlled test camera supporting success and adverse responses."""

            def do_GET(self) -> None:
                """Return the fixture or simulate an unsafe remote response."""
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/snapshot")
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(MAX_IMAGE_BYTES + 1 if self.path == "/huge" else len(data)))
                self.end_headers()
                if self.path != "/huge":
                    self.wfile.write(data)

            def log_message(self, format: str, *args: Any) -> None:
                """Keep tests quiet and avoid logging camera requests."""

        camera_server = ThreadingHTTPServer(("127.0.0.1", 0), SnapshotHandler)
        thread = threading.Thread(target=camera_server.serve_forever)
        thread.start()
        url = f"http://127.0.0.1:{camera_server.server_port}"
        try:
            captured = HttpSnapshotCamera(url + "/snapshot").capture()
            self.assertEqual(captured.data, data)
            self.assertIsNone(captured.source_modified_at_ms)
            self.assert_error("CAMERA_UNAVAILABLE", lambda: HttpSnapshotCamera(url + "/redirect").capture())
            self.assert_error("IMAGE_TOO_LARGE", lambda: HttpSnapshotCamera(url + "/huge").capture())
            self.service.sources["overhead"] = HttpSnapshotCamera(url + "/snapshot")
            frame = self.capture()
            self.assertFalse(self.analyze(frame["frame_id"])["source_age_known"])
        finally:
            camera_server.shutdown()
            camera_server.server_close()
            thread.join()

    @unittest.skipUnless(os.environ.get("OI_VISION_MCP_TESTS") == "1", "Enable actual Node MCP integration with OI_VISION_MCP_TESTS=1")
    def test_actual_mcp_capture_analyze_read_and_isolation(self) -> None:
        """Use JSON-RPC over the real astra process to drive Python OpenCV and image evidence."""
        if not shutil.which("node"):
            self.fail("Node is required for requested MCP integration")
        env = {**os.environ, "OI_VISION_ENABLED": "true", "OI_VISION_TOKEN": self.token_a,
               "OI_VISION_SERVICE_URL": self.base, "ASTRA_ROOT": str(ROOT)}
        process = subprocess.Popen(["node", "server/astra-mcp.mjs"], cwd=ROOT, env=env,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        messages: queue.Queue[str] = queue.Queue()

        def consume() -> None:
            """Collect newline-delimited replies without blocking the test thread."""
            assert process.stdout is not None
            for line in process.stdout:
                messages.put(line)

        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        counter = 0

        def rpc(method: str, params: dict[str, Any]) -> dict[str, Any]:
            """Send one MCP request and require a bounded matching response."""
            nonlocal counter
            counter += 1
            assert process.stdin is not None
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": counter, "method": method, "params": params}) + "\n")
            process.stdin.flush()
            result = json.loads(messages.get(timeout=20))
            self.assertEqual(result["id"], counter)
            return result["result"]

        def call(name: str, args: dict[str, Any]) -> dict[str, Any]:
            """Call a discovered tool through its actual machine-agent transport."""
            return rpc("tools/call", {"name": "astra.vision_" + name, "arguments": args})

        try:
            rpc("initialize", {})
            listed = rpc("tools/list", {})
            self.assertIn("astra.vision_capture", [tool["name"] for tool in listed["tools"]])
            self.assertFalse(call("describe", {})["structuredContent"]["controls_hardware"])
            cameras = call("list_cameras", {})["structuredContent"]["cameras"]
            self.assertEqual(len(cameras), 1)
            captured = call("capture", {"camera_id": "overhead", "request_id": "mcp-capture"})
            self.assertNotIn("isError", captured)
            frame = captured["structuredContent"]["frame"]
            result = call("analyze", {"frame_id": frame["frame_id"], "profile_id": "yellow",
                                       "request_id": "mcp-analyze", "max_age_ms": 60000})
            self.assertNotIn("isError", result)
            observation = result["structuredContent"]["observation"]
            self.assertEqual(observation["detection_count"], 2)
            preview = call("read_frame", {"frame_id": frame["frame_id"]})
            self.assertEqual(preview["content"][1]["type"], "image")
            self.assertNotIn("data", preview["structuredContent"]["preview"])
            self.assertEqual(call("read_observation", {"observation_id": observation["observation_id"]})["structuredContent"]["observation"], observation)
            self.assertEqual(call("list_observations", {"camera_id": "overhead", "limit": 10})["structuredContent"]["observations"], [observation])
            denied = call("capture", {"camera_id": "private-camera", "request_id": "denied"})
            self.assertTrue(denied["isError"])
            self.assertEqual(denied["structuredContent"]["error"]["code"], "NOT_FOUND")
            malformed = call("capture", {"camera_id": "overhead", "request_id": "r", "url": "http://untrusted"})
            self.assertEqual(malformed["structuredContent"]["error"]["code"], "INVALID_REQUEST")
        finally:
            process.terminate()
            process.wait(timeout=10)
            reader.join(timeout=2)
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe:
                    pipe.close()


if __name__ == "__main__":
    unittest.main()
