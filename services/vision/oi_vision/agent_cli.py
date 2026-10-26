"""Start or resume a configured simulation inspection through the existing MCP host."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

from .agent_store import InspectionStore
from .agent_transport import McpClient
from .contracts import VisionError
from .inspection import InspectionAgent, load_bindings


def main() -> None:
    """Print one bounded structured checkpoint; credentials stay in the environment."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("advance", "read"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--binding", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    client: McpClient | None = None
    store: InspectionStore | None = None
    try:
        binding = load_bindings(args.config).get(args.binding)
        if binding is None:
            raise VisionError("NOT_FOUND", 404)
        store = InspectionStore(args.database)
        client = McpClient(args.root.resolve())
        agent = InspectionAgent(client, store, binding)
        result = agent.advance(args.run_id) if args.operation == "advance" else agent.read(args.run_id)
        print(json.dumps({"inspection": result}, allow_nan=False))
    except VisionError as exc:
        print(json.dumps({"error": {"code": exc.code}}))
    except (OSError, sqlite3.Error, ValueError, KeyError, TypeError):
        print(json.dumps({"error": {"code": "UNAVAILABLE"}}))
    finally:
        if client is not None:
            client.close()
        if store is not None:
            store.close()


if __name__ == "__main__":
    main()
