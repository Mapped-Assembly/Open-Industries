"""Optimistically updated workflow checkpoints; the runtime still owns robot state."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .contracts import Json, VisionError, canonical


class InspectionStore:
    """Persist bounded inspection traces and exact prepared command arguments."""

    def __init__(self, path: Path) -> None:
        """Open a dedicated database, refusing other applications and newer schemas."""
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not path.exists():
            path.touch(mode=0o600)
        self.db = sqlite3.connect(path, isolation_level=None, timeout=5)
        application = self.db.execute("PRAGMA application_id").fetchone()[0]
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        tables = self.db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        if application not in (0, 1330200903) or version not in (0, 1) or (tables and (application, version) != (1330200903, 1)):
            self.db.close()
            raise VisionError("STORE_INCOMPATIBLE", 503)
        # Policy workers are short-lived processes. A rollback journal keeps their
        # small checkpoints in one database without a shared-memory/WAL lifecycle.
        self.db.execute("PRAGMA journal_mode=DELETE")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS inspections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, record TEXT NOT NULL);
            PRAGMA application_id=1330200903;
            PRAGMA user_version=1;
            COMMIT;
        """)

    def close(self) -> None:
        """Release the checkpoint database connection."""
        self.db.close()

    def read(self, run_id: str) -> Json | None:
        """Read one checkpoint without interpreting it as current machine state."""
        row = self.db.execute("SELECT record FROM inspections WHERE id=?", (run_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def create(self, record: Json) -> Json:
        """Create once, preserving an existing run and enforcing a finite run quota."""
        self.db.execute("BEGIN IMMEDIATE")
        try:
            previous = self.read(record["run_id"])
            if previous is not None:
                self.db.execute("COMMIT")
                return previous
            if self.db.execute("SELECT count(*) FROM inspections").fetchone()[0] >= 256:
                raise VisionError("STORAGE_LIMIT", 507)
            self.db.execute("INSERT INTO inspections VALUES (?,?,?)",
                            (record["run_id"], record["revision"], canonical(record)))
            self.db.execute("COMMIT")
            return record
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def replace(self, previous: Json, updated: Json) -> Json:
        """Commit only if this run has not advanced in a competing process."""
        updated["revision"] = previous["revision"] + 1
        serialized = canonical(updated)
        if len(serialized.encode()) > 128 * 1024:
            raise VisionError("STORAGE_LIMIT", 507)
        changed = self.db.execute("UPDATE inspections SET revision=?,record=? WHERE id=? AND revision=?",
                                  (updated["revision"], serialized, previous["run_id"], previous["revision"])).rowcount
        if not changed:
            raise VisionError("RUN_CONFLICT", 409)
        return updated
