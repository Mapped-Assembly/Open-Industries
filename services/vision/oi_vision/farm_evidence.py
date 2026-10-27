"""Record actual MCP-driven sample-farm control and before/after OpenCV evidence."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from uuid import uuid4

from .agent_transport import McpClient
from .farm import require


def exercise(root: Path, command: list[str], output: Path) -> None:
    """Drive every bounded segment through MCP, including pause/reconnect and same-ID retry."""
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    trace: list[dict] = []
    client: McpClient | None = None

    def connect() -> McpClient:
        """Use an operator-selected stdio command such as the authenticated SSH wrapper."""
        trace.append({"event": "connected", "at_ms": int(time.time()*1000)})
        return McpClient(root, timeout_seconds=45, command=command)

    def call(name: str, args: dict) -> dict:
        """Record public tool results; images use MCP image content rather than JSON metadata."""
        result = client.call(name, args)
        trace.append({"at_ms": int(time.time()*1000), "tool": name, "arguments": args, "result": result})
        return result

    def image(observation_id: str, name: str) -> None:
        """Export the original hash-checked rendered PNG from MCP image content."""
        result = client.rpc("tools/call", {"name": "astra.farm_read_frame", "arguments": {"observation_id": observation_id}})
        require(not result.get("isError"), "FRAME_READ_FAILED")
        png = base64.b64decode(next(item["data"] for item in result["content"] if item["type"] == "image"), validate=True)
        require(hashlib.sha256(png).hexdigest() == result["structuredContent"]["observation"]["sha256"], "IMAGE_HASH_MISMATCH")
        (output / name).write_bytes(png)
        trace.append({"tool": "astra.farm_read_frame", "observation_id": observation_id, "file": name,
                      "sha256": hashlib.sha256(png).hexdigest()})

    try:
        client = connect()
        initial = call("astra.farm_read", {})["farm"]
        require(initial["boundary"] == 0 and not initial["active_job"], "FRESH_FARM_REQUIRED")
        jobs = []
        for index in range(7):
            state = call("astra.farm_read", {})["farm"]
            request = {"command_id": str(uuid4()), "action": state["next_action"], "expected_revision": state["revision"]}
            if request["action"] == "harvest":
                observation = call("astra.farm_capture", {"bed": state["next_bed"]})["observation"]
                require(observation["analysis"]["target_visible"], "TARGET_NOT_OBSERVED")
                request["observation_id"] = observation["observation_id"]
                image(observation["observation_id"], f"bed-{state['next_bed']}-before.png")
            receipt = call("astra.farm_command", request)
            require(call("astra.farm_command", request) == receipt, "IDEMPOTENCY_FAILED")
            if index == 0:
                state = call("astra.farm_read", {})["farm"]
                call("astra.farm_command", {"command_id": str(uuid4()), "action": "pause", "expected_revision": state["revision"]})
                paused = call("astra.farm_read", {})["farm"]
                time.sleep(.5)
                require(call("astra.farm_read", {})["farm"]["elapsed"] == paused["elapsed"], "PAUSE_FAILED")
                call("astra.farm_command", {"command_id": str(uuid4()), "action": "resume", "expected_revision": paused["revision"]})
                client.close()
                trace.append({"event": "disconnected_during_active_job", "at_ms": int(time.time()*1000)})
                time.sleep(2)
                client = connect()
                require(call("astra.farm_command", request) == receipt, "RECONNECT_IDEMPOTENCY_FAILED")
            deadline = time.monotonic()+90
            while True:
                job = call("astra.farm_read_job", {"command_id": request["command_id"]})["job"]
                if job["stage"] != "running":
                    break
                require(time.monotonic() < deadline, "JOB_TIMEOUT")
                time.sleep(1)
            require(job["stage"] == "completed", "JOB_NEEDS_REVIEW")
            require(call("astra.farm_command", request) == receipt, "TERMINAL_RETRY_FAILED")
            if request["action"] == "harvest":
                require(all(job["verification"].values()), "HARVEST_VERIFICATION_FAILED")
                image(job["after_observation_id"], f"bed-{job['bed']}-after.png")
            jobs.append(job)
        final = call("astra.farm_read", {})["farm"]
        require(final["deposited"] == [2, 1, 0] and final["next_action"] is None, "MISSION_INCOMPLETE")
        report = {"execution": "deterministic MCP controller; no LLM invoked", "camera": "rendered original MuJoCo farm",
                  "movement": "simulated kinematic segments; scripted produce attachment/release",
                  "application_commit": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
                  "checkout_dirty": bool(subprocess.check_output(["git", "-C", str(root), "status", "--porcelain"], text=True).strip()),
                  "initial": initial, "final": final, "jobs": jobs,
                  "checks": {"three_harvests": True, "opencv_before_after": True, "pause_resume": True,
                             "disconnect_continuity": True, "idempotency": True}}
        (output / "exercise.json").write_text(json.dumps(report, indent=2)+"\n")
        print(json.dumps({"status": "passed", "checks": report["checks"]}))
    finally:
        if client:
            client.close()
        (output / "trace.json").write_text(json.dumps(trace, indent=2)+"\n")


def main() -> None:
    """Accept only an operator-supplied executable vector; never interpolate a shell command."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--command", required=True, help="JSON array of stdio executable and arguments")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    command = json.loads(args.command)
    require(isinstance(command, list) and bool(command) and all(isinstance(v, str) for v in command), "INVALID_COMMAND")
    os.umask(0o077)
    exercise(args.root, command, args.output)


if __name__ == "__main__":
    main()
