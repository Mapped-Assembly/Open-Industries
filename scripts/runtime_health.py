"""Probe HTTP and the authoritative worker heartbeat without credentials."""
from __future__ import annotations

import argparse
import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import urlopen


def check_health(origin: str) -> bool:
    """Return true only for a successful, versioned, healthy runtime response."""
    try:
        with urlopen(origin.rstrip("/") + "/health", timeout=5) as response:
            payload = json.loads(response.read(16384))
            return (
                response.status == 200
                and isinstance(payload, dict)
                and payload.get("version") == 1
                and payload.get("scheduler_healthy") is True
            )
    except (HTTPError, URLError, TimeoutError, ValueError, OSError):
        return False


def main() -> int:
    """Exit nonzero on an unreachable service or an unhealthy scheduler."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("origin", help="Loopback or HTTPS runtime origin")
    args = parser.parse_args()
    healthy = check_health(args.origin)
    print(json.dumps({"event": "runtime_health", "healthy": healthy}))
    return 0 if healthy else 1


if __name__ == "__main__":
    sys.exit(main())
