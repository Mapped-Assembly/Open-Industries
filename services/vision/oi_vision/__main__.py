"""Start the optional Open Industries Python vision service."""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

from .contracts import VisionError
from .http_server import VisionHttpServer
from .service import VisionService
from .store import ObservationStore


def main() -> None:
    """Load operator configuration and serve until interrupted."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--database", type=Path, default=Path(".astra/vision/observations.sqlite"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8792)
    args = parser.parse_args()
    store: ObservationStore | None = None
    try:
        store = ObservationStore(args.database)
        service = VisionService(args.config.resolve(), store)
        with VisionHttpServer((args.host, args.port), service) as server:
            print(f"Open Industries vision listening on {args.host}:{server.server_port}; OpenCV {service.opencv_version}",
                  file=sys.stderr, flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass
    except VisionError as exc:
        parser.exit(1, f"Vision service could not start: {exc.code}\n")
    except (OSError, sqlite3.Error):
        parser.exit(1, "Vision service could not start: UNAVAILABLE\n")
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    main()
