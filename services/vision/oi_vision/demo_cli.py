"""Serve a persistent simulated inspection station or connect a local stdio MCP agent."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import sys
import threading
from pathlib import Path
from types import FrameType

from .demo_host import DemoError, PersistentDemo, check_services, read_json, write_json


def serve(root: Path, directory: Path) -> None:
    """Keep services alive until SIGINT/SIGTERM, independently of any agent connection."""
    stopped = threading.Event()

    def stop(signum: int, frame: FrameType | None) -> None:
        """Schedule orderly cleanup outside the signal handler."""
        stopped.set()

    previous = {signum: signal.signal(signum, stop) for signum in (signal.SIGINT, signal.SIGTERM)}
    old_umask = os.umask(0o077)
    try:
        with PersistentDemo(root, directory) as host:
            print(json.dumps(check_services(directory)), flush=True)
            while not stopped.wait(5):
                host.maintain()
        print(json.dumps({"status": "stopped", "state_dir": str(directory)}), flush=True)
    finally:
        os.umask(old_umask)
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def connect_mcp(directory: Path) -> None:
    """Replace this process with the existing Node MCP host; stdout remains exclusively MCP."""
    check_services(directory)
    connection = read_json(directory / "connection.json")
    root = Path(connection["root"])
    environment = connection["environment"]
    node = shutil.which("node")
    if node is None or not root.is_absolute() or not (root / "server/astra-mcp.mjs").is_file():
        raise DemoError("DEMO_INVALID_ROOT_OR_NODE_MISSING")
    if not isinstance(environment, dict) or any(not isinstance(value, str) for value in environment.values()):
        raise DemoError("DEMO_INVALID_CONNECTION")
    os.chdir(root)
    os.umask(0o077)
    os.execvpe(node, [node, str(root / "server/astra-mcp.mjs")],
               {**os.environ, **environment, "ASTRA_ROOT": str(root)})


def main() -> None:
    """Expose service hosting, live status, operator marker control and stdio attachment."""
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    for operation in ("serve", "status", "marker", "mcp"):
        command = subparsers.add_parser(operation)
        command.add_argument("--state-dir", type=Path, default=Path(".astra/vision-agent-live"))
        if operation == "serve":
            command.add_argument("--root", type=Path, default=Path.cwd())
        if operation == "marker":
            command.add_argument("visibility", choices=("show", "hide"))
    args = parser.parse_args()
    directory = args.state_dir.resolve()
    try:
        if args.operation == "serve":
            serve(args.root.resolve(), directory)
        elif args.operation == "mcp":
            connect_mcp(directory)
        elif args.operation == "status":
            print(json.dumps(check_services(directory)), flush=True)
        else:
            state = read_json(directory / "host.json")
            if state.get("version") != 1:
                raise DemoError("DEMO_INCOMPATIBLE_STATE")
            visible = args.visibility == "show"
            write_json(directory / "marker.json", {"visible": visible})
            print(json.dumps({"marker_visible": visible, "state_dir": str(directory)}), flush=True)
    except Exception as exc:
        # Do not forward exception strings, which can contain auth bodies or local secrets.
        code = str(exc) if isinstance(exc, DemoError) else "DEMO_UNAVAILABLE"
        print(json.dumps({"error": {"code": code}}), file=sys.stderr, flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
