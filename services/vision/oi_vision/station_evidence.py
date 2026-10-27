"""Verify a running synthetic station through its exported MCP entry point, without an LLM."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener
from uuid import uuid4

import cv2

from .agent_transport import McpClient
from .contracts import Json
from .demo_host import DemoError, check_services, read_json, write_json


def timestamp() -> str:
    """Return an explicit UTC observation timestamp."""
    return datetime.now(timezone.utc).isoformat()


def require(condition: bool, code: str) -> None:
    """Fail verification explicitly, including when Python assertions are disabled."""
    if not condition:
        raise DemoError(code)


def health(directory: Path, wait: float = 0) -> Json:
    """Wait only for live scheduler, vision and camera readiness, with a bounded deadline."""
    deadline = time.monotonic() + wait
    while True:
        try:
            return check_services(directory)
        except Exception:
            if time.monotonic() >= deadline:
                raise DemoError("STATION_UNHEALTHY") from None
            time.sleep(0.5)


def aws_identity() -> Json:
    """Read only allowlisted EC2 identity fields using IMDSv2; never export its token."""
    opener = build_opener(ProxyHandler({}))
    base = "http://169.254.169.254/latest/"
    with opener.open(Request(base + "api/token", method="PUT",
                     headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"}), timeout=2) as response:
        token = response.read(1024).decode()
    with opener.open(Request(base + "dynamic/instance-identity/document",
                     headers={"X-aws-ec2-metadata-token": token}), timeout=2) as response:
        value = json.loads(response.read(16384))
    return {key: value[key] for key in ("instanceId", "instanceType", "region", "availabilityZone", "imageId", "architecture")}


def identity(directory: Path) -> Json:
    """Read stable public bindings and a digest of private identity, excluding renewable sessions."""
    state = read_json(directory / "host.json")
    stable = {key: state[key] for key in ("root", "binding", "ports", "vision_token")}
    stable["accounts"] = {role: {key: account[key] for key in ("username", "password")}
                          for role, account in state["accounts"].items()}
    digest = hashlib.sha256(json.dumps(stable, sort_keys=True).encode()).hexdigest()
    return {"binding": state["binding"], "ports": state["ports"], "root": state["root"],
            "identity_sha256": digest}


def metadata(directory: Path, on_aws: bool) -> Json:
    """Record actual versions, checkout identity and boot ID, not inferred cloud success."""
    root = Path(read_json(directory / "host.json")["root"])
    def git(*args: str) -> str:
        """Read checkout provenance without including remote credentials or source diffs."""
        return subprocess.check_output(["git", "-c", f"safe.directory={root}", "-C", str(root), *args], text=True).strip()
    return {"recorded_at": timestamp(), "application_commit": git("rev-parse", "HEAD"),
            "checkout_dirty": bool(git("status", "--porcelain")),
            "python": platform.python_version(), "node": subprocess.check_output(["node", "--version"], text=True).strip(),
            "opencv": cv2.__version__, "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "aws": aws_identity() if on_aws else None, "execution": "deterministic MCP verification; no model invoked",
            "camera": "synthetic runtime-rendered pixels", "movement": "simulated; no physical actuation"}


def public_write(path: Path, value: Json, directory: Path) -> None:
    """Reject accidental private credential disclosure before writing an evidence JSON file."""
    state = read_json(directory / "host.json")
    secrets = [state["vision_token"]]
    for account in state["accounts"].values():
        secrets.extend([account["password"], account.get("session", {}).get("token", "")])
    text = json.dumps(value, indent=2, allow_nan=False)
    require(not any(secret and secret in text for secret in secrets), "EVIDENCE_CONTAINS_SECRET")
    write_json(path, value)


class Recorder:
    """Use the same exported stdio command as an agent and retain only sanitized tool summaries."""

    def __init__(self, directory: Path, wrapper: Path | None = None) -> None:
        """Read non-secret host configuration; credentials are loaded by the MCP entry point."""
        self.directory = directory
        self.root = Path(read_json(directory / "host.json")["root"])
        definition = read_json(directory / "mcp.json")["mcpServers"]["open-industries-demo"]
        self.command = [str(wrapper)] if wrapper else [definition["command"], *definition["args"]]
        self.trace: list[Json] = []
        self.client: McpClient | None = None

    def connect(self) -> None:
        """Connect without copying service credentials into this verifier's environment."""
        self.client = McpClient(self.root, command=self.command)
        self.trace.append({"at": timestamp(), "event": "MCP_CONNECTED"})

    def close(self) -> None:
        """Disconnect the agent transport without stopping the independent station."""
        if self.client:
            self.client.close()
            self.client = None
            self.trace.append({"at": timestamp(), "event": "MCP_DISCONNECTED"})

    def call(self, name: str, arguments: Json) -> Json:
        """Record public tool names, arguments and bounded stage/identity summaries."""
        require(self.client is not None, "MCP_NOT_CONNECTED")
        result = self.client.call(name, arguments)  # type: ignore[union-attr]
        record = result.get("inspection", {})
        summary = {key: record[key] for key in ("run_id", "stage", "reason", "revision", "job_id") if key in record}
        self.trace.append({"at": timestamp(), "tool": name, "arguments": arguments, "result": summary})
        return result

    def inspect(self, run_id: str, read: bool = False) -> Json:
        """Advance or read one canonical run UUID through the public agent tool."""
        return self.call("astra.agent_read_inspection" if read else "astra.agent_inspect_robot",
                         {"binding_id": "demo-inspection", "run_id": run_id})["inspection"]

    def finish(self, run_id: str) -> Json:
        """Bound policy polling; runtime movement is never edited or fast-forwarded."""
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            result = self.inspect(run_id)
            if result["stage"] in ("completed", "needs_review"):
                return result
            time.sleep(0.25)
        raise DemoError("INSPECTION_TIMEOUT")

    def snapshot(self, match_id: str) -> Json:
        """Read the authorized real game worker state through MCP."""
        return self.call("astra.game_read_match", {"version": 5, "match_id": match_id})["snapshot"]

    def images(self, inspection: Json, output: Path) -> Json:
        """Export hash-checked MCP JPEG previews, explicitly distinct from source PNG hashes."""
        images: Json = {}
        for phase in ("before", "after"):
            require(self.client is not None, "MCP_NOT_CONNECTED")
            arguments = {"frame_id": inspection[phase]["frame_id"]}
            # MCP intentionally separates image content from structured metadata.
            result = self.client.rpc("tools/call", {"name": "astra.vision_read_frame", "arguments": arguments})
            require(not result.get("isError"), "FRAME_READ_FAILED")
            preview = result["structuredContent"]["preview"]
            content = [item for item in result["content"] if item["type"] == "image"]
            require(len(content) == 1 and content[0]["mimeType"] == "image/jpeg", "INVALID_PREVIEW")
            data = base64.b64decode(content[0]["data"], validate=True)
            require(hashlib.sha256(data).hexdigest() == preview["sha256"], "PREVIEW_HASH_MISMATCH")
            self.trace.append({"at": timestamp(), "tool": "astra.vision_read_frame", "arguments": arguments,
                               "result": {"preview_sha256": preview["sha256"]}})
            path = output / f"{phase}.jpg"
            with path.open("xb") as stream:
                stream.write(data)
            images[phase] = {"file": path.name, "preview_sha256": preview["sha256"],
                             "source_png_sha256": inspection[phase]["frame_sha256"]}
        return images


def exercise(directory: Path, output: Path, on_aws: bool = False, wrapper: Path | None = None) -> Json:
    """Verify review, action, idempotency and agent-disconnect continuity on a fresh station."""
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    initial = health(directory)
    meta = metadata(directory, on_aws)
    recorder = Recorder(directory, wrapper)
    try:
        recorder.connect()
        before = recorder.snapshot(initial["match_id"])
        # A repeat demonstration needs return_robot or a separate station. Never reset state.
        require(not before["field"]["jobs"], "USE_FRESH_STATION_FOR_EVIDENCE")
        write_json(directory / "marker.json", {"visible": False})
        review_id, run_id = str(uuid4()), str(uuid4())
        review = recorder.finish(review_id)
        require(review["stage"] == "needs_review" and review["reason"] == "TARGET_NOT_OBSERVED"
                and "command" not in review, "REVIEW_CASE_FAILED")
        require(not recorder.snapshot(initial["match_id"])["field"]["jobs"], "REVIEW_ISSUED_COMMAND")
        require(recorder.inspect(review_id) == review, "REVIEW_RETRY_CHANGED")
        write_json(directory / "marker.json", {"visible": True})
        require(recorder.inspect(review_id) == review, "TERMINAL_REVIEW_CHANGED")
        require(recorder.inspect(run_id)["stage"] == "ready", "MARKER_DID_NOT_PERMIT_SURVEY")
        running = recorder.inspect(run_id)
        require(running["stage"] == "running", "SURVEY_NOT_ACCEPTED")
        recorder.close()
        disconnected_health = health(directory)
        time.sleep(2)
        recorder.connect()
        saved = recorder.inspect(run_id, read=True)
        require(saved["command"] == running["command"] and saved["job_id"] == running["job_id"], "DISCONNECT_LOST_INTENT")
        completed = recorder.finish(run_id)
        require(completed["stage"] == "completed" and completed["verification"]["robot_moved"]
                and completed["verification"]["image_changed"]
                and completed["runtime_job"]["state"] == "completed", "ACTION_CASE_FAILED")
        require(recorder.inspect(run_id) == completed, "ACTION_RETRY_CHANGED")
        snapshot = recorder.snapshot(initial["match_id"])
        require(len(snapshot["field"]["jobs"]) == 1, "DUPLICATE_RUNTIME_JOB")
        images = recorder.images(completed, output)
        result = {"schema": "oi-station-evidence/1", "metadata": meta, "identity": identity(directory),
                  "initial_health": initial, "disconnected_health": disconnected_health,
                  "review": review, "inspection": completed, "images": images,
                  "checks": {"review_without_command": True, "authorized_survey_completed": True,
                             "same_uuid_idempotent": True, "agent_disconnect_continuity": True},
                  "persistence": "Run verify after service restart and host reboot; not yet verified."}
        public_write(output / "exercise.json", result, directory)
        return result
    finally:
        recorder.close()
        public_write(output / "tool-trace.json", {"execution": "deterministic MCP; no LLM", "events": recorder.trace}, directory)


def verify(directory: Path, output: Path, kind: str, wrapper: Path | None = None) -> Json:
    """Verify historical evidence and identities after an externally performed restart/reboot/restore."""
    baseline = json.loads((output / "exercise.json").read_text())
    current = health(directory, 60)
    meta = metadata(directory, baseline["metadata"]["aws"] is not None)
    require(identity(directory) == baseline["identity"], "STATION_IDENTITY_CHANGED")
    require(meta["application_commit"] == baseline["metadata"]["application_commit"], "RELEASE_CHANGED")
    if kind == "reboot":
        require(meta["boot_id"] != baseline["metadata"]["boot_id"], "HOST_NOT_REBOOTED")
    else:
        require(current["runtime_pid"] != baseline["initial_health"]["runtime_pid"], "WORKER_NOT_RESTARTED")
    if meta["aws"] is not None:
        require(meta["aws"] == baseline["metadata"]["aws"], "AWS_HOST_CHANGED")
    recorder = Recorder(directory, wrapper)
    try:
        recorder.connect()
        for field in ("review", "inspection"):
            expected = baseline[field]
            require(recorder.inspect(expected["run_id"], read=True) == expected, "CHECKPOINT_CHANGED")
            require(recorder.inspect(expected["run_id"]) == expected, "RETRY_CHANGED_AFTER_RESTART")
        snapshot = recorder.snapshot(current["match_id"])
        require(len(snapshot["field"]["jobs"]) == 1, "DUPLICATE_RUNTIME_JOB")
        for phase in ("before", "after"):
            image = recorder.call("astra.vision_read_frame", {"frame_id": baseline["inspection"][phase]["frame_id"]})
            require(image["preview"]["sha256"] == baseline["images"][phase]["preview_sha256"], "STORED_IMAGE_CHANGED")
        result = {"kind": kind, "verified_at": timestamp(), "metadata": meta, "health": current,
                  "same_identity_and_credentials": True, "same_checkpoints_and_images": True,
                  "one_runtime_job": True, "trace": recorder.trace}
        public_write(output / f"verified-{kind}.json", result, directory)
        return result
    finally:
        recorder.close()


def main() -> None:
    """Expose readiness, repeatable MCP exercise and externally initiated recovery verification."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("health", "exercise", "verify"))
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/oi-station/state"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--wait", type=float, default=0)
    parser.add_argument("--aws", action="store_true", help="Require observed IMDSv2 instance identity")
    parser.add_argument("--kind", choices=("restart", "reboot", "restore"), default="restart")
    parser.add_argument("--mcp-wrapper", type=Path, help="Operator-selected stdio executable, e.g. /usr/local/bin/oi-station-mcp")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.operation == "health":
            result = health(args.state_dir, args.wait)
        else:
            require(args.output is not None, "OUTPUT_REQUIRED")
            result = (exercise(args.state_dir, args.output, args.aws, args.mcp_wrapper) if args.operation == "exercise"
                      else verify(args.state_dir, args.output, args.kind, args.mcp_wrapper))
        print(json.dumps({"status": "passed", "operation": args.operation,
                          "services_healthy": result.get("services_healthy"), "at": timestamp()}))
    except Exception as exc:
        code = str(exc) if isinstance(exc, DemoError) else "STATION_VERIFICATION_FAILED"
        print(json.dumps({"error": {"code": code}}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
