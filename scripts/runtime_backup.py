"""Create a private, consistent SQLite backup without overwriting existing files."""
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import sys
import time


def backup_database(source: Path, destination: Path) -> int:
    """Use SQLite online backup, verify integrity, and return the schema version.

    The destination must be new. The source can be live, including WAL mode.
    A 30-second deadline bounds lock waits; failed output is removed. Keep the
    source database, WAL and SHM together on its local filesystem throughout.
    """
    source = source.resolve(strict=True)
    destination = destination.absolute()
    if not source.is_file():
        raise ValueError("Source must be a database file")
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    deadline = time.monotonic() + 30

    def progress(status: int, remaining: int, total: int) -> None:
        """Abort a stalled backup rather than waiting indefinitely for a lock."""
        if time.monotonic() > deadline:
            raise TimeoutError("SQLite backup exceeded 30 seconds")

    try:
        with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=5)) as reader:
            with closing(sqlite3.connect(destination, timeout=5)) as writer:
                reader.backup(writer, pages=256, progress=progress, sleep=0.1)
                if writer.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                    raise ValueError("Backup integrity check failed")
                version = int(writer.execute("PRAGMA user_version").fetchone()[0])
                # Publish a standalone database, with no destination WAL dependency.
                writer.execute("PRAGMA journal_mode=DELETE")
        with destination.open("rb") as result:
            os.fsync(result.fileno())
        directory_fd = os.open(destination.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return version
    except BaseException:
        destination.unlink(missing_ok=True)
        for suffix in ("-wal", "-shm", "-journal"):
            Path(str(destination) + suffix).unlink(missing_ok=True)
        raise


def main() -> int:
    """Back up one complete database to a new path; never copy individual tables."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        version = backup_database(args.source, args.destination)
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"Backup failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"event": "runtime_backup", "schema_version": version}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
