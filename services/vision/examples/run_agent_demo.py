"""Run a pixel-to-command inspection using real local services and a declared simulation camera."""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import secrets
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import cv2
import numpy as np

from oi_vision.agent_transport import McpClient
from oi_vision.contracts import Json, VisionError
from oi_vision.http_server import VisionHttpServer
from oi_vision.inspection import TERMINAL
from oi_vision.service import VisionService
from oi_vision.store import ObservationStore


class DemoEnvironment:
    """Use the real game worker, HTTP camera, OpenCV service and public MCP tools."""

    def __init__(self, root: Path, directory: Path) -> None:
        """Prepare resource handles; starting the context provisions a private local fixture."""
        self.root, self.directory = root, directory
        self.worker: subprocess.Popen[str] | None = None
        self.camera: ThreadingHTTPServer | None = None
        self.vision: VisionHttpServer | None = None
        self.vision_store: ObservationStore | None = None
        self.threads: list[threading.Thread] = []
        self.previous_environment: dict[str, str | None] = {}
        self.marker_visible = True
        self.frozen_image: bytes | None = None
        self.last_modified: str | None = None

    def post(self, route: str, body: Json, token: str | None = None) -> Json:
        """Use authenticated production HTTP routes, never direct database manipulation."""
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        request = Request(self.game_url + route, data=json.dumps(body).encode(), headers=headers)
        try:
            with urlopen(request, timeout=10) as response:
                return json.load(response)
        except HTTPError as exc:
            raise VisionError(json.load(exc)["error"]["code"]) from exc

    def snapshot(self) -> Json:
        """Read the configured account's current authorized runtime projection."""
        return self.post("/game", {"name": "astra.game_read_match", "arguments": {
            "version": 5, "match_id": self.match_id}}, self.game_token)["snapshot"]

    def image(self) -> bytes:
        """Render current runtime positions and one synthetic inspection marker into pixels."""
        if self.frozen_image is not None:
            return self.frozen_image
        snapshot = self.snapshot()
        image = np.full((224, 384, 3), 32, dtype=np.uint8)
        for obstacle in snapshot["world"]["obstacles"]:
            x, y = obstacle["x"] * 4, obstacle["y"] * 4
            cv2.rectangle(image, (x, y), (x + obstacle["width"] * 4, y + obstacle["height"] * 4), (75, 75, 75), -1)
        for target in snapshot["world"]["deposits"]:
            x, y = target["position"]["x"] * 4, target["position"]["y"] * 4
            color = (0, 255, 255) if self.marker_visible and target["id"] == self.target_id else (70, 70, 70)
            cv2.rectangle(image, (x - 6, y - 6), (x + 6, y + 6), color, -1)
        for robot in snapshot["field"]["robots"]:
            center = (robot["position"]["x"] * 4, robot["position"]["y"] * 4)
            cv2.circle(image, center, 4, (245, 245, 245), -1)
        success, data = cv2.imencode(".png", image)
        if not success:
            raise VisionError("PROCESSING_FAILED")
        return data.tobytes()

    def __enter__(self) -> DemoEnvironment:
        """Start an isolated match and camera with fresh credentials retained only in memory."""
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.worker = subprocess.Popen(["node", "server/game-service.mjs"], cwd=self.root,
                env={**os.environ, "ASTRA_GAME_DB": str(self.directory / "runtime.sqlite"),
                     "ASTRA_GAME_PORT": "0", "ASTRA_GAME_ALLOW_SIGNUP": "true"},
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            lines: queue.Queue[str] = queue.Queue()

            def startup_line() -> None:
                """Read the bounded startup message without blocking the caller indefinitely."""
                assert self.worker is not None and self.worker.stdout is not None
                lines.put(self.worker.stdout.readline(4096))

            startup = threading.Thread(target=startup_line, daemon=True)
            startup.start()
            match = re.search(r"http://127\.0\.0\.1:\d+", lines.get(timeout=15))
            if match is None:
                raise RuntimeError("Runtime startup failed")
            self.game_url = match[0]
            suffix = secrets.token_hex(5)
            self.game_token = self.post("/auth/register", {"username": "agent-" + suffix, "password": secrets.token_hex(24)})["token"]
            self.other_token = self.post("/auth/register", {"username": "peer-" + suffix, "password": secrets.token_hex(24)})["token"]
            created = self.post("/game", {"name": "astra.game_create_match", "arguments": {
                "version": 5, "command_id": str(uuid4())}}, self.game_token)
            self.match_id = created["snapshot"]["match_id"]
            self.post("/game", {"name": "astra.game_join_match", "arguments": {
                "version": 5, "command_id": str(uuid4()), "match_id": self.match_id,
                "invite_code": created["invite_code"]}}, self.other_token)
            snapshot = self.snapshot()
            self.robot_id = snapshot["field"]["robots"][0]["id"]
            self.target_id = next(item["id"] for item in snapshot["world"]["deposits"] if item["home_slot"] == 1 and item["kind"] == "cable")
            owner = self

            class SnapshotHandler(BaseHTTPRequestHandler):
                """Serve only a synthetic image; no runtime state or credentials in the response."""

                def do_GET(self) -> None:
                    """Return freshly rendered pixels unless a failure case deliberately freezes them."""
                    try:
                        if self.path != "/snapshot.png":
                            self.send_error(404)
                            return
                        data = owner.image()
                        self.send_response(200)
                        self.send_header("Content-Type", "image/png")
                        self.send_header("Content-Length", str(len(data)))
                        if owner.last_modified:
                            self.send_header("Last-Modified", owner.last_modified)
                        self.end_headers()
                        self.wfile.write(data)
                    except Exception:
                        self.send_error(503)

                def log_message(self, format: str, *args: Any) -> None:
                    """Keep local demonstration access logs free of request details."""

            self.camera = ThreadingHTTPServer(("127.0.0.1", 0), SnapshotHandler)
            thread = threading.Thread(target=self.camera.serve_forever)
            thread.start()
            self.threads.append(thread)
            self.vision_token = secrets.token_hex(32)
            environment = {"OI_VISION_TOKEN": self.vision_token, "OI_VISION_ENABLED": "true",
                "ASTRA_GAME_TOOLS_ENABLED": "true", "ASTRA_GAME_SESSION": self.game_token,
                "ASTRA_GAME_SERVICE_URL": self.game_url, "OI_AGENT_ENABLED": "true",
                "OI_AGENT_PYTHON": sys.executable, "OI_AGENT_CONFIG": str(self.directory / "agent.json"),
                "OI_AGENT_DATABASE": str(self.directory / "inspections.sqlite")}
            self.previous_environment = {name: os.environ.get(name) for name in [*environment, "OI_VISION_SERVICE_URL"]}
            os.environ.update(environment)
            config = {"cameras": [{"camera_id": "demo-camera", "machine_id": self.robot_id,
                "adapter": "http_snapshot", "url": f"http://127.0.0.1:{self.camera.server_port}/snapshot.png", "evidence_kind": "simulation"}],
                "profiles": [{"profile_id": "marker", "type": "color_regions", "label": "inspection-marker",
                              "lower_hsv": [20, 100, 100], "upper_hsv": [40, 255, 255], "min_area_px": 20}],
                "principals": [{"principal_id": "demo-agent", "machines": [self.robot_id], "token_env": "OI_VISION_TOKEN"}]}
            config_path = self.directory / "vision.json"
            config_path.write_text(json.dumps(config))
            self.vision_store = ObservationStore(self.directory / "observations.sqlite")
            self.vision = VisionHttpServer(("127.0.0.1", 0), VisionService(config_path, self.vision_store))
            thread = threading.Thread(target=self.vision.serve_forever)
            thread.start()
            self.threads.append(thread)
            os.environ["OI_VISION_SERVICE_URL"] = f"http://127.0.0.1:{self.vision.server_port}"
            self.binding = {"binding_id": "demo-inspection", "camera_id": "demo-camera", "match_id": self.match_id,
                            "robot_id": self.robot_id, "target_id": self.target_id, "profile_id": "marker"}
            (self.directory / "agent.json").write_text(json.dumps({"bindings": [self.binding]}, indent=2) + "\n")
            return self
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        """Stop services and restore environment; the output directory preserves evidence."""
        for server in (self.vision, self.camera):
            if server:
                server.shutdown()
                server.server_close()
        for thread in self.threads:
            thread.join(timeout=5)
        if self.vision_store:
            self.vision_store.close()
        if self.worker:
            self.worker.terminate()
            try:
                self.worker.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.worker.kill()
                self.worker.wait(timeout=5)
            if self.worker.stdout:
                self.worker.stdout.close()
        for key, value in self.previous_environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def __exit__(self, *exc: object) -> None:
        """Release processes and sockets even after an assertion or interrupted demo."""
        self.close()


def finish_run(client: McpClient, binding_id: str, run_id: str) -> Json:
    """Poll the public agent tool with one stable ID until a bounded terminal result."""
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        result = client.call("astra.agent_inspect_robot", {"binding_id": binding_id, "run_id": run_id})["inspection"]
        if result["stage"] in TERMINAL:
            return result
        time.sleep(0.25)
    raise RuntimeError("Inspection did not settle within the demonstration deadline")


def main() -> None:
    """Save success and missing-marker traces plus actual before/after OpenCV input images."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument("--output", type=Path, default=Path(".astra/vision-agent-demo"))
    args = parser.parse_args()
    with DemoEnvironment(args.root.resolve(), args.output.resolve()) as demo:
        client = McpClient(demo.root, allow_agent_tools=True)
        try:
            demo.marker_visible = False
            missing = finish_run(client, "demo-inspection", str(uuid4()))
            demo.marker_visible = True
            inspected = finish_run(client, "demo-inspection", str(uuid4()))
            for name, result in (("missing-marker", missing), ("inspection", inspected)):
                (demo.directory / f"{name}.json").write_text(json.dumps(result, indent=2) + "\n")
            for phase in ("before", "after"):
                if phase in inspected and demo.vision_store:
                    data = demo.vision_store.frame(inspected[phase]["frame_id"])[1]
                    (demo.directory / f"{phase}.png").write_bytes(data)
            print(json.dumps({"missing_marker": missing["stage"], "visible_marker": inspected["stage"],
                              "reason": inspected["reason"], "verification": inspected.get("verification"),
                              "output": str(demo.directory)}, indent=2))
            if missing["stage"] != "needs_review" or inspected["stage"] != "completed":
                raise SystemExit(1)
        finally:
            client.close()


if __name__ == "__main__":
    main()
