"""Persistent local hosting for the simulated inspection fixture and its MCP clients."""

from __future__ import annotations

import json
import os
import secrets
import tempfile
from pathlib import Path
from types import TracebackType
from typing import IO
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from .contracts import Json, VisionError, now_ms
from .demo import DemoEnvironment
from .inspection import InspectionBinding


class DemoError(RuntimeError):
    """Report a stable launcher failure without including credentials or response bodies."""


def read_json(path: Path) -> Json:
    """Read one bounded operator-owned JSON object."""
    with path.open("rb") as stream:
        data = stream.read(131073)
    if len(data) > 131072:
        raise DemoError("DEMO_INVALID_STATE")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise DemoError("DEMO_INVALID_STATE")
    return value


def write_private(path: Path, text: str) -> None:
    """Atomically replace a private file, syncing both its bytes and directory entry."""
    descriptor, temporary = tempfile.mkstemp(prefix=".write-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json(path: Path, value: Json) -> None:
    """Persist private JSON without nonfinite numbers or partial writes."""
    write_private(path, json.dumps(value, indent=2, allow_nan=False) + "\n")


class DirectoryLock:
    """Hold an OS-managed exclusive lock; process exit releases it without stale PID guessing."""

    def __init__(self, directory: Path) -> None:
        """Remember the dedicated state directory without acquiring its lock."""
        self.directory = directory
        self.stream: IO[bytes] | None = None

    def acquire(self) -> None:
        """Reject a second launcher for this directory on Linux, WSL or macOS."""
        if os.name != "posix":
            raise DemoError("DEMO_REQUIRES_POSIX_USE_WSL")
        import fcntl

        self.stream = (self.directory / ".host.lock").open("a+b")
        os.fchmod(self.stream.fileno(), 0o600)
        try:
            fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self.release()
            raise DemoError("DEMO_ALREADY_RUNNING") from exc

    def release(self) -> None:
        """Release ownership without unlinking the shared lock inode."""
        if self.stream is not None:
            self.stream.close()
            self.stream = None


def get_json(url: str, token: str | None = None) -> Json:
    """Probe a local service with a deadline and without caching or printing credentials."""
    headers = {"Authorization": "Bearer " + token} if token else {}
    with urlopen(Request(url, headers=headers), timeout=5) as response:
        data = response.read(65537)
    if len(data) > 65536:
        raise DemoError("DEMO_INVALID_RESPONSE")
    value = json.loads(data)
    if not isinstance(value, dict):
        raise DemoError("DEMO_INVALID_RESPONSE")
    return value


def check_services(directory: Path) -> Json:
    """Check live health and camera pixels; a saved readiness file alone is not proof of life."""
    ready = read_json(directory / "ready.json")
    if ready.get("status") != "ready":
        raise DemoError("DEMO_NOT_RUNNING")
    game = get_json(ready["game_url"] + "/health")
    vision = get_json(ready["vision_url"] + "/health")
    if not game.get("scheduler_healthy") or vision.get("service") != "open-industries-vision":
        raise DemoError("DEMO_UNHEALTHY")
    with urlopen(ready["camera_url"], timeout=10) as response:
        if response.headers.get_content_type() != "image/png" or response.read(8) != b"\x89PNG\r\n\x1a\n":
            raise DemoError("DEMO_CAMERA_UNAVAILABLE")
    return {**ready, "opencv_version": vision["opencv_version"], "services_healthy": True}


class PersistentDemo(DemoEnvironment):
    """Keep one fixture alive independently of MCP connections and reopen it after shutdown."""

    def __init__(self, root: Path, directory: Path) -> None:
        """Use stable stored identities, endpoints and credentials under an exclusive lock."""
        super().__init__(root.resolve(), directory.resolve())
        self.lock = DirectoryLock(self.directory)
        self.state: Json = {}
        self.published = False

    def save_state(self) -> None:
        """Persist provisioning receipts and session metadata before dependent operations."""
        write_json(self.directory / "host.json", self.state)

    def save_configuration(self, path: Path, value: Json) -> None:
        """Write every generated operator configuration atomically with owner-only access."""
        write_json(path, value)

    def camera_token(self) -> str:
        """Reuse the same machine-scoped vision credential across host restarts."""
        return self.state["vision_token"]

    def marker_is_visible(self) -> bool:
        """Read an atomic operator-controlled condition; the agent cannot silently reset it."""
        marker = read_json(self.directory / "marker.json")
        if set(marker) != {"visible"} or type(marker["visible"]) is not bool:
            raise DemoError("DEMO_INVALID_MARKER")
        return marker["visible"]

    def session(self, role: str) -> Json:
        """Reuse valid sessions or authenticate the same saved account through the real API."""
        account = self.state["accounts"][role]
        session = account.get("session")
        if session and session["expires_at_ms"] > now_ms() + 300000:
            try:
                get_json(self.game_url + "/auth/session", session["token"])
                return session
            except HTTPError as exc:
                if exc.code != 401:
                    raise
        credentials = {key: account[key] for key in ("username", "password")}
        try:
            session = self.post("/auth/login", credentials)
        except VisionError as exc:
            if exc.code != "AUTH_REQUIRED" or not self.allow_signup:
                raise
            session = self.post("/auth/register", credentials)
        account["session"] = session
        self.save_state()
        return session

    def prepare_match(self) -> None:
        """Resume the saved fixture, replaying stable setup command IDs only during provisioning."""
        self.game_port = int(self.game_url.rsplit(":", 1)[1])
        self.state["ports"]["game"] = self.game_port
        self.save_state()
        self.game_token = self.session("owner")["token"]
        binding = self.state.get("binding")
        if binding is None:
            self.other_token = self.session("peer")["token"]
            created = self.post("/game", {"name": "astra.game_create_match", "arguments": {
                "version": 5, "command_id": self.state["create_id"]}}, self.game_token)
            self.match_id = created["snapshot"]["match_id"]
            self.post("/game", {"name": "astra.game_join_match", "arguments": {
                "version": 5, "command_id": self.state["join_id"], "match_id": self.match_id,
                "invite_code": created["invite_code"]}}, self.other_token)
            snapshot = self.snapshot()
            binding = {"binding_id": "demo-inspection", "camera_id": "demo-camera", "profile_id": "marker",
                       "match_id": self.match_id, "robot_id": snapshot["field"]["robots"][0]["id"],
                       "target_id": next(item["id"] for item in snapshot["world"]["deposits"]
                                         if item["home_slot"] == 1 and item["kind"] == "cable")}
            self.state["binding"] = binding
            self.save_state()
        parsed = InspectionBinding.parse(binding)
        self.match_id, self.robot_id, self.target_id = parsed.match_id, parsed.robot_id, parsed.target_id
        snapshot = self.snapshot()
        if not any(robot["id"] == self.robot_id for robot in snapshot["field"]["robots"]):
            raise DemoError("DEMO_BINDING_UNAVAILABLE")
        if self.allow_signup:
            # Provisioning is complete: reopen the same database with signup disabled.
            self.stop_worker()
            self.allow_signup = False
            self.start_worker()

    def publish_connection(self) -> None:
        """Write private service credentials separately from the portable stdio host definition."""
        write_json(self.directory / "connection.json", {"root": str(self.root), "environment": self.environment})
        write_json(self.directory / "mcp.json", {"mcpServers": {"open-industries-demo": {
            "command": self.environment["OI_AGENT_PYTHON"],
            "args": ["-m", "oi_vision.demo_cli", "mcp", "--state-dir", str(self.directory)]}}})

    def maintain(self) -> None:
        """Detect failed services and refresh the camera/next MCP connection before session expiry."""
        if self.worker is None or self.worker.poll() is not None or not all(thread.is_alive() for thread in self.threads):
            raise DemoError("DEMO_SERVICE_EXITED")
        session = self.session("owner")
        if session["token"] != self.game_token:
            self.game_token = session["token"]
            self.environment["ASTRA_GAME_SESSION"] = self.game_token
            os.environ["ASTRA_GAME_SESSION"] = self.game_token
            self.publish_connection()
        check_services(self.directory)

    def __enter__(self) -> PersistentDemo:
        """Acquire one host lease, start all three services, then publish verified connection files."""
        if os.name != "posix":
            raise DemoError("DEMO_REQUIRES_POSIX_USE_WSL")
        if not (self.root / "server/game-service.mjs").is_file():
            raise DemoError("DEMO_INVALID_ROOT")
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.lock.acquire()
        try:
            path = self.directory / "host.json"
            if path.exists():
                self.state = read_json(path)
                if self.state.get("version") != 1 or self.state.get("root") != str(self.root):
                    raise DemoError("DEMO_INCOMPATIBLE_STATE")
                if not (self.directory / "runtime.sqlite").is_file() and self.state.get("binding"):
                    raise DemoError("DEMO_RUNTIME_DATABASE_MISSING")
            else:
                if any(item.name not in {".host.lock", ".gitignore"} for item in self.directory.iterdir()):
                    raise DemoError("DEMO_DIRECTORY_NOT_EMPTY")
                self.state = {"version": 1, "root": str(self.root), "ports": {"game": 0, "camera": 0, "vision": 0},
                              "vision_token": secrets.token_hex(32), "create_id": str(uuid4()), "join_id": str(uuid4()),
                              "accounts": {role: {"username": role + "-" + secrets.token_hex(5),
                                                   "password": secrets.token_hex(24)} for role in ("owner", "peer")}}
                self.save_state()
            if not (self.directory / "marker.json").exists() and self.state.get("binding") is None:
                write_json(self.directory / "marker.json", {"visible": True})
            write_private(self.directory / ".gitignore", "*\n")
            ports = self.state["ports"]
            if set(ports) != {"game", "camera", "vision"} or any(type(port) is not int or not 0 <= port <= 65535 for port in ports.values()):
                raise DemoError("DEMO_INVALID_STATE")
            self.game_port, self.camera_port, self.vision_port = ports["game"], ports["camera"], ports["vision"]
            self.allow_signup = self.state.get("binding") is None
            super().__enter__()
            assert self.camera is not None and self.vision is not None and self.worker is not None
            self.state["ports"] = {"game": self.game_port, "camera": self.camera.server_port, "vision": self.vision.server_port}
            self.save_state()
            self.publish_connection()
            ready = {"status": "ready", "evidence_kind": "simulation", "binding_id": "demo-inspection",
                     "match_id": self.match_id, "robot_id": self.robot_id, "runtime_pid": self.worker.pid,
                     "game_url": self.game_url, "vision_url": self.environment["OI_VISION_SERVICE_URL"],
                     "camera_url": f"http://127.0.0.1:{self.camera.server_port}/snapshot.png",
                     "state_dir": str(self.directory), "mcp_config": str(self.directory / "mcp.json")}
            write_json(self.directory / "ready.json", ready)
            self.published = True
            self.maintain()
            return self
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        """Checkpoint the real worker, stop HTTP threads, and release the directory for reuse."""
        try:
            super().close()
        finally:
            try:
                if self.published:
                    ready = read_json(self.directory / "ready.json")
                    write_json(self.directory / "ready.json", {**ready, "status": "stopped"})
                    self.published = False
            finally:
                self.lock.release()

    def __exit__(self, exc_type: type[BaseException] | None, exc: BaseException | None,
                 traceback: TracebackType | None) -> None:
        """Release services after normal shutdown, startup failure or an operator interrupt."""
        self.close()
