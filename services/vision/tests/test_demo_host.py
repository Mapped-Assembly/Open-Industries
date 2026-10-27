"""Exercise the persistent launcher and exported MCP command as independent processes."""

from __future__ import annotations

import json
import os
import queue
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
from unittest.mock import patch
from uuid import uuid4

from oi_vision.contracts import Json
from oi_vision.demo_host import DemoError, PersistentDemo, read_json
from oi_vision.station_backup import backup, restore
from oi_vision.station_evidence import exercise, verify

ROOT = Path(__file__).resolve().parents[3]


class ExportedMcpClient:
    """Connect using only the generated host definition, from an unrelated working directory."""

    def __init__(self, definition: Json, cwd: Path) -> None:
        """Start the exact exported command without inheriting service credentials from a test."""
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(("OI_", "ASTRA_"))}
        self.process = subprocess.Popen([definition["command"], *definition["args"]], cwd=cwd,
                                        env=environment, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.messages: queue.Queue[bytes] = queue.Queue()
        self.counter = 0

        def consume() -> None:
            """Keep one bounded JSON-RPC reply per queue item."""
            assert self.process.stdout is not None
            for line in self.process.stdout:
                self.messages.put(line)

        self.reader = threading.Thread(target=consume, daemon=True)
        self.reader.start()
        try:
            self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "persistent-demo-test", "version": "1"}})
        except BaseException:
            self.close()
            raise

    def rpc(self, method: str, params: Json) -> Json:
        """Send one real MCP request with a bounded response deadline."""
        self.counter += 1
        assert self.process.stdin is not None
        self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": self.counter,
                                             "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        value = json.loads(self.messages.get(timeout=35))
        if value.get("id") != self.counter or "error" in value:
            raise AssertionError("Invalid MCP response")
        return value["result"]

    def call(self, name: str, arguments: Json) -> Json:
        """Require a successful structured result without logging private transport state."""
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        if result.get("isError"):
            raise AssertionError(result.get("structuredContent", {}).get("error", {}).get("code"))
        return result["structuredContent"]

    def close(self) -> None:
        """Disconnect the MCP client while leaving its independent services alone."""
        if self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=10)
        self.reader.join(timeout=2)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream:
                stream.close()


@unittest.skipUnless(os.name == "posix" and os.getenv("OI_VISION_MCP_TESTS") == "1",
                     "Enable real POSIX service integration with OI_VISION_MCP_TESTS=1")
class PersistentDemoTests(unittest.TestCase):
    """Verify persistent identity, external connections, process lifecycle and private output."""

    def setUp(self) -> None:
        """Give each independent host its own empty directory and subprocess registry."""
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "station"
        self.processes: list[subprocess.Popen[str]] = []
        self.clients: list[ExportedMcpClient] = []
        self.clean_environment = {key: value for key, value in os.environ.items()
                                  if not key.startswith(("OI_", "ASTRA_"))}

    def tearDown(self) -> None:
        """Stop clients and real services even when an assertion fails."""
        for client in self.clients:
            client.close()
        for process in self.processes:
            if process.poll() is None:
                process.terminate()
            try:
                process.communicate(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate(timeout=5)
        self.temporary.cleanup()

    def command(self, operation: str, *arguments: str) -> list[str]:
        """Use the documented module command with explicit absolute paths."""
        return [sys.executable, "-m", "oi_vision.demo_cli", operation,
                "--state-dir", str(self.directory), *arguments]

    def cli(self, operation: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        """Run an independent operator command with bounded lifetime."""
        return subprocess.run(self.command(operation, *arguments), cwd=self.temporary.name,
                              env=self.clean_environment, capture_output=True, text=True, timeout=25)

    def start(self) -> tuple[subprocess.Popen[str], Json]:
        """Wait for readiness from the actual launcher process, not from file existence."""
        process = subprocess.Popen(self.command("serve", "--root", str(ROOT)),
                                   cwd=self.temporary.name, env=self.clean_environment,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.processes.append(process)
        messages: queue.Queue[str] = queue.Queue()

        def first_line() -> None:
            """Read one startup line without hanging the test after a failed child."""
            assert process.stdout is not None
            messages.put(process.stdout.readline())

        reader = threading.Thread(target=first_line, daemon=True)
        reader.start()
        line = messages.get(timeout=25)
        reader.join(timeout=1)
        self.assertTrue(line, "Launcher exited before becoming ready")
        ready = json.loads(line)
        self.assertEqual(ready["status"], "ready")
        self.assertTrue(ready["services_healthy"])
        return process, ready

    def stop(self, process: subprocess.Popen[str], ready: Json) -> None:
        """SIGTERM must flush state, close every listening socket and exit successfully."""
        process.terminate()
        stdout, stderr = process.communicate(timeout=20)
        self.assertEqual(process.returncode, 0, stderr)
        self.assertEqual(json.loads(stdout)["status"], "stopped")
        self.assertEqual(read_json(self.directory / "ready.json")["status"], "stopped")
        for name in ("game_url", "vision_url", "camera_url"):
            with socket.socket() as connection:
                self.assertNotEqual(connection.connect_ex(("127.0.0.1", urlsplit(ready[name]).port)), 0)

    def client(self) -> ExportedMcpClient:
        """Use the generated generic MCP configuration exactly as a host would."""
        definition = read_json(self.directory / "mcp.json")["mcpServers"]["open-industries-demo"]
        client = ExportedMcpClient(definition, Path(self.temporary.name))
        self.clients.append(client)
        return client

    def finish(self, client: ExportedMcpClient, run_id: str) -> Json:
        """Advance the same durable intent until terminal, allowing the real worker to move."""
        deadline = time.monotonic() + 50
        while time.monotonic() < deadline:
            result = client.call("astra.agent_inspect_robot", {"binding_id": "demo-inspection", "run_id": run_id})["inspection"]
            if result["stage"] in ("completed", "needs_review"):
                return result
            time.sleep(0.2)
        self.fail("Inspection did not finish")

    def test_agent_disconnect_restart_and_pixel_control(self) -> None:
        """An exported MCP client changes real work; restart preserves one command and its evidence."""
        process, ready = self.start()
        with urlopen(ready["game_url"] + "/health") as response:
            self.assertFalse(json.load(response)["registration_enabled"])
        client = self.client()
        self.assertEqual(self.cli("marker", "hide").returncode, 0)
        missing = self.finish(client, str(uuid4()))
        self.assertEqual((missing["stage"], missing["reason"]), ("needs_review", "TARGET_NOT_OBSERVED"))
        snapshot = client.call("astra.game_read_match", {"version": 5, "match_id": ready["match_id"]})["snapshot"]
        self.assertEqual(snapshot["field"]["jobs"], [])
        self.assertEqual(self.cli("marker", "show").returncode, 0)
        run_id = str(uuid4())
        arguments = {"binding_id": "demo-inspection", "run_id": run_id}
        self.assertEqual(client.call("astra.agent_inspect_robot", arguments)["inspection"]["stage"], "ready")
        running = client.call("astra.agent_inspect_robot", arguments)["inspection"]
        self.assertEqual(running["stage"], "running")
        command_id = running["command"]["command_id"]
        client.close()
        self.assertEqual(self.cli("status").returncode, 0)
        self.assertIsNone(process.poll(), "MCP disconnect must not stop the services")
        self.stop(process, ready)

        # Revoke the saved session through the real API after restarting below; this
        # first restart must otherwise keep exact endpoints and authorization scope.
        restarted, resumed_ready = self.start()
        for key in ("match_id", "robot_id", "game_url", "vision_url", "camera_url"):
            self.assertEqual(resumed_ready[key], ready[key])
        reconnected = self.client()
        saved = reconnected.call("astra.agent_read_inspection", arguments)["inspection"]
        self.assertEqual(saved["command"]["command_id"], command_id)
        self.assertEqual(saved["before"], running["before"])
        done = self.finish(reconnected, run_id)
        self.assertEqual(done["stage"], "completed", done["reason"])
        self.assertTrue(done["verification"]["robot_moved"])
        self.assertFalse(done["verification"]["physical_motion_verified"])
        snapshot = reconnected.call("astra.game_read_match", {"version": 5, "match_id": ready["match_id"]})["snapshot"]
        self.assertEqual(len(snapshot["field"]["jobs"]), 1)
        self.assertEqual(reconnected.call("astra.agent_inspect_robot", arguments)["inspection"], done)
        self.assertNotEqual(done["before"]["frame_sha256"], done["after"]["frame_sha256"])
        reconnected.call("astra.vision_read_frame", {"frame_id": done["before"]["frame_id"]})

        state = read_json(self.directory / "host.json")
        definition = (self.directory / "mcp.json").read_text()
        for private in (state["vision_token"], state["accounts"]["owner"]["password"],
                        state["accounts"]["owner"]["session"]["token"]):
            for public in (json.dumps(ready), json.dumps(done), definition):
                self.assertNotIn(private, public)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
        for name in ("host.json", "connection.json", "mcp.json", "agent.json", "vision.json"):
            self.assertEqual((self.directory / name).stat().st_mode & 0o777, 0o600)
        reconnected.close()

        session = state["accounts"]["owner"]["session"]["token"]
        request = Request(ready["game_url"] + "/auth/logout", data=b"{}",
                          headers={"Content-Type": "application/json", "Authorization": "Bearer " + session})
        with urlopen(request) as response:
            self.assertFalse(json.load(response)["authenticated"])
        self.stop(restarted, resumed_ready)
        final_process, final_ready = self.start()
        self.assertEqual(final_ready["match_id"], ready["match_id"])
        new_session = read_json(self.directory / "host.json")["accounts"]["owner"]["session"]["token"]
        self.assertNotEqual(new_session, session)
        final_client = self.client()
        self.assertEqual(final_client.call("astra.agent_read_inspection", arguments)["inspection"], done)
        final_client.close()
        self.stop(final_process, final_ready)

    def test_duplicate_launcher_and_worker_failure_cleanup(self) -> None:
        """A second host cannot own the fixture; losing the real worker closes dependent services."""
        process, ready = self.start()
        duplicate = self.cli("serve", "--root", str(ROOT))
        self.assertEqual(duplicate.returncode, 1)
        self.assertEqual(json.loads(duplicate.stderr)["error"]["code"], "DEMO_ALREADY_RUNNING")
        self.assertEqual(self.cli("status").returncode, 0)
        os.kill(ready["runtime_pid"], signal.SIGTERM)
        stdout, stderr = process.communicate(timeout=20)
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(stderr)["error"]["code"], "DEMO_SERVICE_EXITED")
        self.assertEqual(stdout, "")
        self.assertNotEqual(self.cli("status").returncode, 0)
        restarted, resumed = self.start()
        self.assertEqual(resumed["match_id"], ready["match_id"])
        self.stop(restarted, resumed)

    def test_deployment_evidence_and_complete_offline_restore(self) -> None:
        """The shipped verifier uses exported MCP, then proves a complete three-store restore."""
        process, ready = self.start()
        output = Path(self.temporary.name) / "public-evidence"
        archive = Path(self.temporary.name) / "private-backup"
        result = exercise(self.directory, output)
        self.assertTrue(all(result["checks"].values()))
        self.assertIsNone(result["metadata"]["aws"])
        self.assertNotEqual((output / "before.jpg").read_bytes(), (output / "after.jpg").read_bytes())
        with self.assertRaisesRegex(DemoError, "DEMO_ALREADY_RUNNING"):
            backup(self.directory, archive)
        self.stop(process, ready)
        backup(self.directory, archive)
        for name in ("runtime.sqlite", "observations.sqlite", "inspections.sqlite", "host.json", "connection.json"):
            self.assertTrue((archive / "state" / name).is_file())
        with self.assertRaisesRegex(DemoError, "RESTORE_DESTINATION_EXISTS"):
            restore(archive, self.directory)
        self.directory.rename(Path(self.temporary.name) / "quarantine")
        restore(archive, self.directory)
        restarted, resumed = self.start()
        persisted = verify(self.directory, output, "restore")
        self.assertTrue(persisted["same_identity_and_credentials"])
        self.assertTrue(persisted["same_checkpoints_and_images"])
        with self.assertRaisesRegex(DemoError, "HOST_NOT_REBOOTED"):
            verify(self.directory, output, "reboot")
        self.stop(restarted, resumed)

    def test_occupied_saved_port_does_not_replace_fixture(self) -> None:
        """A port conflict fails cleanly, retaining identities and releasing the partial runtime."""
        process, ready = self.start()
        self.stop(process, ready)
        with socket.socket() as occupied:
            occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            occupied.bind(("127.0.0.1", urlsplit(ready["camera_url"]).port))
            occupied.listen()
            failed = self.cli("serve", "--root", str(ROOT))
            self.assertEqual(failed.returncode, 1)
            self.assertEqual(failed.stdout, "")
            with socket.socket() as runtime:
                self.assertNotEqual(runtime.connect_ex(("127.0.0.1", urlsplit(ready["game_url"]).port)), 0)
        restarted, resumed = self.start()
        self.assertEqual(resumed["match_id"], ready["match_id"])
        self.assertEqual(resumed["camera_url"], ready["camera_url"])
        self.stop(restarted, resumed)

    def test_interrupted_provisioning_reuses_committed_match(self) -> None:
        """Losing a join reply during setup must not create another match on restart."""
        host = PersistentDemo(ROOT, self.directory)
        original = host.post

        def lose_reply(route: str, body: Json, token: str | None = None) -> Json:
            """Discard only a successful real join response after its transaction commits."""
            result = original(route, body, token)
            if body.get("name") == "astra.game_join_match":
                raise DemoError("TEST_LOST_SETUP_REPLY")
            return result

        with patch.object(host, "post", side_effect=lose_reply):
            with self.assertRaisesRegex(DemoError, "TEST_LOST_SETUP_REPLY"):
                host.__enter__()
        committed_match = host.match_id
        self.assertNotIn("binding", read_json(self.directory / "host.json"))
        restarted, ready = self.start()
        self.assertEqual(ready["match_id"], committed_match)
        self.assertEqual(self.cli("status").returncode, 0)
        self.stop(restarted, ready)


if __name__ == "__main__":
    unittest.main()
