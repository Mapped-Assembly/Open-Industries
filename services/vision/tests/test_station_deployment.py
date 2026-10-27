"""Check deployment boundaries and offline archive rejection without requiring AWS access."""

from __future__ import annotations

import configparser
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from oi_vision.demo_host import DemoError, write_json
from oi_vision.station_backup import inventory, restore
from oi_vision.station_evidence import public_write

ROOT = Path(__file__).resolve().parents[3]
DEPLOY = ROOT / "deploy/inspection"


class DeploymentChecks(unittest.TestCase):
    """Guard the deployment's ingress, persistent storage, identity and secret boundaries."""

    def test_private_services_and_retained_encrypted_disk(self) -> None:
        """The only inbound permission is restricted SSH; station disks survive termination."""
        template = json.loads((DEPLOY / "station.cfn.json").read_text())
        resources = template["Resources"]
        ingress = resources["SecurityGroup"]["Properties"]["SecurityGroupIngress"]
        self.assertEqual(len(ingress), 1)
        self.assertEqual((ingress[0]["FromPort"], ingress[0]["ToPort"]), (22, 22))
        self.assertEqual(ingress[0]["CidrIp"], {"Ref": "AdminCidr"})
        station = resources["Station"]["Properties"]
        self.assertEqual(station["MetadataOptions"]["HttpTokens"], "required")
        self.assertEqual(station["CreditSpecification"]["CPUCredits"], {"Ref": "CpuCredits"})
        self.assertEqual(template["Parameters"]["CpuCredits"]["AllowedValues"], ["standard", "unlimited"])
        for disk in station["BlockDeviceMappings"]:
            self.assertTrue(disk["Ebs"]["Encrypted"])
            self.assertFalse(disk["Ebs"]["DeleteOnTermination"])
        self.assertNotIn("IamInstanceProfile", station)

    def test_supervisor_and_agent_process_tree_lifecycle(self) -> None:
        """A detached runtime stays in the service cgroup, while MCP units stop with the station."""
        unit = configparser.ConfigParser(strict=False)
        unit.read(DEPLOY / "oi-station.service")
        service = unit["Service"]
        self.assertEqual(service["KillMode"], "mixed")
        self.assertEqual(service["SendSIGKILL"], "yes")
        self.assertGreater(int(unit["Unit"]["StartLimitBurst"]), 0)
        self.assertIn("demo_cli serve", service["ExecStart"])
        self.assertIn("--root /opt/oi-station/app", service["ExecStart"])
        self.assertIn("--state-dir /var/lib/oi-station/state", service["ExecStart"])
        wrapper = (DEPLOY / "mcp.sh").read_text()
        self.assertIn("--property=PartOf=oi-station.service", wrapper)
        self.assertIn("--property=Requisite=oi-station.service", wrapper)
        self.assertIn("--property=KillMode=control-group", wrapper)
        self.assertIn("flock --shared --nonblock", wrapper)

    def test_private_values_cannot_enter_evidence(self) -> None:
        """Evidence writing fails rather than exporting even an accidentally embedded token."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            write_json(directory / "host.json", {"vision_token": "private-vision-token", "accounts": {
                "owner": {"password": "private-password", "session": {"token": "private-session"}}}})
            for secret in ("private-vision-token", "private-password", "private-session"):
                with self.assertRaisesRegex(DemoError, "EVIDENCE_CONTAINS_SECRET"):
                    public_write(directory / "evidence.json", {"nested": [secret]}, directory)
            self.assertFalse((directory / "evidence.json").exists())

    def test_archive_rejects_symlinks_and_wrong_restore_path(self) -> None:
        """Private files outside the station cannot be pulled into a backup via a symlink."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "outside").symlink_to("/etc/passwd")
            with self.assertRaisesRegex(DemoError, "BACKUP_SYMLINK_REFUSED"):
                inventory(directory)
            write_json(directory / "manifest.json", {"schema": "oi-station-backup/1", "state_path": "/different/station"})
            with self.assertRaisesRegex(DemoError, "RESTORE_PATH_BINDING_MISMATCH"):
                restore(directory, directory / "state")

    def test_stdio_wrapper_preserves_input_and_cleans_up_on_disconnect(self) -> None:
        """Exercise real Bash pipe/signal handling with fake systemd, without root or cloud claims."""
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            # Only bypass root/path prerequisites; execute the shipped stdio and trap logic.
            script = (DEPLOY / "mcp.sh").read_text().replace("$EUID == 0", "1 == 1")
            script = script.replace("/run/lock/oi-station-maintenance.lock", str(directory / "lock"))
            (directory / "wrapper.sh").write_text(script)
            (directory / "systemctl").write_text('#!/bin/bash\nif [[ $1 == stop ]]; then touch "$TEST_STOPPED"; fi\n')
            (directory / "systemd-run").write_text(
                f'#!{sys.executable}\nimport sys\nfor line in sys.stdin:\n print(line.rstrip(), flush=True)\n')
            for name in ("systemctl", "systemd-run"):
                (directory / name).chmod(0o755)
            process = subprocess.Popen(["bash", str(directory / "wrapper.sh")],
                env={**os.environ, "PATH": str(directory) + os.pathsep + os.environ["PATH"],
                     "TEST_STOPPED": str(directory / "stopped")},
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                replies: queue.Queue[str] = queue.Queue()
                reader = threading.Thread(target=lambda: replies.put(process.stdout.readline()), daemon=True)
                reader.start()
                process.stdin.write('{"jsonrpc":"2.0","id":1}\n')
                process.stdin.flush()
                self.assertEqual(replies.get(timeout=5), '{"jsonrpc":"2.0","id":1}\n')
                process.terminate()
                process.communicate(timeout=5)
                reader.join(timeout=1)
                self.assertTrue((directory / "stopped").exists())
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)
