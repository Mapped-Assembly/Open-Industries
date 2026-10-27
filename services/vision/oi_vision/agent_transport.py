"""A bounded stdio client for the existing Open Industries MCP tools."""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import threading
from pathlib import Path
from typing import Any, Protocol

from .contracts import Json, VisionError


class ToolClient(Protocol):
    """The inspection policy depends on typed tool calls, not a model provider."""

    def call(self, name: str, arguments: Json) -> Json:
        """Return structured tool output or a sanitized VisionError."""
        ...


class McpClient:
    """Execute the repository's real stdio host with inherited service credentials."""

    def __init__(self, root: Path, timeout_seconds: float = 35, allow_agent_tools: bool = False,
                 *, command: list[str] | None = None) -> None:
        """Start a host or an operator-supplied stdio entry point; never a tool-supplied command."""
        self.timeout = timeout_seconds
        self.counter = 0
        self.messages: queue.Queue[bytes | None] = queue.Queue(maxsize=8)
        self.process = subprocess.Popen(
            command or ["node", str(root / "server/astra-mcp.mjs")], cwd=root,
            env=({key: value for key, value in os.environ.items() if not key.startswith(("OI_", "ASTRA_"))}
                 if command else {**os.environ, "ASTRA_ROOT": str(root),
                 "OI_AGENT_ENABLED": os.environ.get("OI_AGENT_ENABLED", "false") if allow_agent_tools else "false"}),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.reader = threading.Thread(target=self._consume, daemon=True)
        self.reader.start()
        try:
            self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                    "clientInfo": {"name": "oi-inspection-policy", "version": "1"}})
        except BaseException:
            self.close()
            raise

    def _consume(self) -> None:
        """Bound individual replies before parsing them or placing them in memory."""
        assert self.process.stdout is not None
        try:
            while True:
                line = self.process.stdout.readline(1024 * 1024 + 1)
                if not line or len(line) > 1024 * 1024:
                    self.messages.put(None, timeout=self.timeout)
                    return
                self.messages.put(line, timeout=self.timeout)
        except (OSError, ValueError, queue.Full):
            return

    def rpc(self, method: str, params: Json) -> Json:
        """Send one sequential request and reject mismatched or malformed replies."""
        self.counter += 1
        try:
            assert self.process.stdin is not None
            self.process.stdin.write((json.dumps({"jsonrpc": "2.0", "id": self.counter,
                                                 "method": method, "params": params}) + "\n").encode())
            self.process.stdin.flush()
            line = self.messages.get(timeout=self.timeout)
            result = json.loads(line) if line else None
            if not isinstance(result, dict) or result.get("id") != self.counter or "error" in result:
                raise ValueError()
            return result["result"]
        except (OSError, ValueError, KeyError, queue.Empty) as exc:
            raise VisionError("OUTCOME_UNKNOWN", 503) from exc

    def call(self, name: str, arguments: Json) -> Json:
        """Use structuredContent only; raw host errors never enter workflow traces."""
        result = self.rpc("tools/call", {"name": name, "arguments": arguments})
        value: Any = result.get("structuredContent")
        if result.get("isError"):
            code = value.get("error", {}).get("code") if isinstance(value, dict) else None
            raise VisionError(code if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,64}", code)
                              else "UNAVAILABLE", 503)
        if not isinstance(value, dict):
            raise VisionError("INVALID_RESULT", 503)
        return value

    def close(self) -> None:
        """Stop the private transport without stopping either independent service."""
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.reader.join(timeout=1)
        for pipe in (self.process.stdin, self.process.stdout):
            if pipe:
                pipe.close()
