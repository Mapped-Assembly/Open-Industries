"""Serve the sample-farm adapter or connect its authenticated stdio MCP client."""

from __future__ import annotations

import argparse
import base64
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import threading
from typing import Any

from .demo_host import read_json, write_json
from .farm import FarmError, FarmRuntime, SOURCE_COMMIT, require, analyze_pov


def handler_for(runtime: FarmRuntime, token: str, source: Path) -> type[BaseHTTPRequestHandler]:
    """Expose authenticated agent operations and a read-only loopback 3D viewer."""
    scene: Any = None
    demo_token = secrets.token_hex(32)

    class Handler(BaseHTTPRequestHandler):
        """Keep credentials and raw exception messages out of HTTP logs/responses."""

        def reply(self, status: int, value: Any, mime: str = "application/json") -> None:
            """Write one bounded response, tolerating disconnected viewers."""
            payload = json.dumps(value).encode() if mime == "application/json" else value
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_POST(self) -> None:
            """Dispatch only known agent operations after bearer authorization."""
            browser = self.path in ("/api/control", "/api/pov-analysis")
            host = self.headers.get("Host", "")
            browser_authorized = (bool(re.fullmatch(r"(127\.0\.0\.1|localhost):[0-9]+", host))
                and self.headers.get("Origin") == "http://" + host
                and hmac.compare_digest(self.headers.get("X-Farm-Demo", ""), demo_token))
            if (browser and not browser_authorized) or (not browser and (self.headers.get("Origin") or not hmac.compare_digest(
                    self.headers.get("Authorization", ""), "Bearer " + token))):
                self.reply(401, {"error": {"code": "AUTH_REQUIRED"}})
                return
            self.connection.settimeout(10)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                require(0 < length <= (220000 if self.path == "/api/pov-analysis" else 4096), "INVALID_REQUEST")
                request = json.loads(self.rfile.read(length))
                require(isinstance(request, dict), "INVALID_REQUEST")
                if self.path == "/api/pov-analysis":
                    require(set(request) == {"rgba"} and isinstance(request["rgba"], str), "INVALID_REQUEST")
                    self.reply(200, analyze_pov(base64.b64decode(request["rgba"], validate=True)))
                    return
                with runtime.lock, runtime.db:
                    if browser:
                        result = {"receipt": runtime.demo_command(request)}
                    elif self.path == "/command":
                        result = {"receipt": runtime.command(request)}
                    elif self.path == "/capture":
                        require(set(request) == {"bed"}, "INVALID_REQUEST")
                        result = {"observation": runtime.capture(request["bed"])}
                    elif self.path == "/job":
                        require(set(request) == {"command_id"}, "INVALID_REQUEST")
                        result = {"job": runtime.job(request["command_id"])}
                    elif self.path == "/frame":
                        require(set(request) == {"observation_id"}, "INVALID_REQUEST")
                        observation, png = runtime.frame(request["observation_id"])
                        result = {"observation": observation,
                                  "preview": {"mime_type": "image/png", "data": base64.b64encode(png).decode()}}
                    elif self.path == "/status":
                        require(not request, "INVALID_REQUEST")
                        result = {"farm": runtime.status()}
                    else:
                        raise FarmError("NOT_FOUND")
                self.reply(200, result)
            except (ValueError, KeyError, TypeError) as exc:
                code = str(exc) if isinstance(exc, FarmError) else "INVALID_REQUEST"
                self.reply(400, {"error": {"code": code}})
            except Exception:
                self.reply(503, {"error": {"code": "FARM_UNAVAILABLE"}})

        def do_GET(self) -> None:
            """Serve only scene data and explicit static assets; visiting never starts motion."""
            nonlocal scene
            if self.headers.get("Sec-Fetch-Site") == "cross-site" or not re.fullmatch(
                    r"(127\.0\.0\.1|localhost):[0-9]+", self.headers.get("Host", "")):
                self.reply(403, {"error": {"code": "AUTH_REQUIRED"}})
                return
            try:
                path = self.path.split("?", 1)[0]
                if path == "/health":
                    self.reply(200 if not runtime.failure else 503, {"healthy": not runtime.failure})
                elif path == "/":
                    page = (Path(__file__).parent / "farm_viewer.html").read_text().replace("__DEMO_TOKEN__", demo_token)
                    self.reply(200, page.encode(), "text/html; charset=utf-8")
                elif path == "/api/evidence":
                    self.reply(200, runtime.evidence())
                elif path.startswith("/api/frame/"):
                    self.reply(200, runtime.frame(path.removeprefix("/api/frame/"))[1], "image/png")
                elif path in ("/vendor/three.module.min.js", "/vendor/OrbitControls.js"):
                    self.reply(200, (source / "simulation" / path.lstrip("/")).read_bytes(), "text/javascript")
                elif path in ("/api/scene", "/api/state") or re.fullmatch(r"/assets/mesh/\d+\.bin", path):
                    with runtime.lock:
                        if scene is None:
                            from simulation.browser_scene import BrowserScene
                            scene = BrowserScene(runtime.model, runtime.data)
                        if path == "/api/scene":
                            self.reply(200, scene.document)
                        elif path == "/api/state":
                            self.reply(200, {**runtime.status(), "transforms": scene.poses(runtime.data)})
                        else:
                            mesh_id = int(path.rsplit("/", 1)[1].split(".")[0])
                            self.reply(200, scene.meshes[mesh_id], "application/octet-stream")
                else:
                    self.reply(404, {"error": {"code": "NOT_FOUND"}})
            except Exception:
                self.reply(503, {"error": {"code": "FARM_UNAVAILABLE"}})

        def log_message(self, format: str, *args: Any) -> None:
            """Suppress URL/header logging for the private operator service."""

    return Handler


def serve(source: Path, directory: Path, port: int) -> None:
    """Run one saved farm independently of agent connections, with graceful signal shutdown."""
    source, directory = source.resolve(), directory.resolve()
    commit = subprocess.check_output(["git", "-c", f"safe.directory={source}", "-C", str(source),
                                      "rev-parse", "HEAD"], text=True).strip()
    require(commit == SOURCE_COMMIT, "UNSUPPORTED_FARM_SOURCE")
    runtime = FarmRuntime(source, directory)
    config = directory / "connection.json"
    try:
        connection = read_json(config) if config.exists() else {"token": secrets.token_hex(32), "port": port}
        require(port == connection["port"], "PORT_BINDING_CHANGED")
        with ThreadingHTTPServer(("127.0.0.1", port), handler_for(runtime, connection["token"], source)) as server:
            write_json(config, {**connection, "url": f"http://127.0.0.1:{port}", "source_commit": commit})
            runtime.start()
            def watch() -> None:
                """Let systemd recover a failed worker rather than serving a dead farm forever."""
                runtime.stop.wait()
                if runtime.failure:
                    server.shutdown()
            threading.Thread(target=watch, name="farm-watch", daemon=True).start()
            def stop(signum: int, frame: Any) -> None:
                """Wake the HTTP loop outside the signal handler's execution thread."""
                threading.Thread(target=server.shutdown, daemon=True).start()
            signal.signal(signal.SIGTERM, stop)
            signal.signal(signal.SIGINT, stop)
            print(json.dumps({"ready": True, "port": port, "simulated": True}), flush=True)
            server.serve_forever(poll_interval=.2)
            require(runtime.failure is None, "RUNTIME_FAILED")
    finally:
        runtime.close()


def main() -> None:
    """Expose persistent hosting and the existing Open Industries MCP executable."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("serve", "mcp"))
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--port", type=int, default=8794)
    args = parser.parse_args()
    os.umask(0o077)
    if args.operation == "serve":
        require(args.source is not None, "SOURCE_REQUIRED")
        serve(args.source, args.state_dir, args.port)
    else:
        connection = read_json(args.state_dir / "connection.json")
        os.environ.update(OI_FARM_URL=connection["url"], OI_FARM_TOKEN=connection["token"])
        os.execvp("node", ["node", str(args.root.resolve() / "server/astra-mcp.mjs")])


if __name__ == "__main__":
    main()
