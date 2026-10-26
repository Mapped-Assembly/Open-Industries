"""Durable, append-only frames, observations and idempotent request receipts."""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

from .contracts import Json, VisionError, canonical, digest


class ObservationStore:
    """Keep exact image evidence and results together in one bounded SQLite database."""

    def __init__(self, path: Path, max_bytes: int = 64 * 1024 * 1024,
                 max_records: int = 8192) -> None:
        """Open a dedicated versioned database, refusing unrelated or newer schemas."""
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not path.exists():
            path.touch(mode=0o600)
        self.connection = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=5)
        application_id = self.connection.execute("PRAGMA application_id").fetchone()[0]
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        existing = self.connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
        if (application_id not in (0, 0x4F495649) or version not in (0, 1)
                or (existing and (application_id != 0x4F495649 or version != 1))):
            self.connection.close()
            raise VisionError("STORE_INCOMPATIBLE", 503)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self.connection.executescript("""
            BEGIN IMMEDIATE;
            CREATE TABLE IF NOT EXISTS frames (
              id TEXT PRIMARY KEY, camera_id TEXT NOT NULL, record TEXT NOT NULL, image BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS observations (
              id TEXT PRIMARY KEY, camera_id TEXT NOT NULL,
              frame_id TEXT NOT NULL REFERENCES frames(id), record TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS observations_camera ON observations(camera_id);
            CREATE TABLE IF NOT EXISTS receipts (
              principal TEXT NOT NULL, request_id TEXT NOT NULL,
              fingerprint TEXT NOT NULL, result TEXT NOT NULL,
              PRIMARY KEY (principal, request_id)
            );
            PRAGMA application_id=1330206281;
            PRAGMA user_version=1;
            COMMIT;
        """)
        self.lock = threading.RLock()
        self.max_bytes = max_bytes
        self.max_records = max_records

    def close(self) -> None:
        """Close the connection after active requests have completed."""
        with self.lock:
            self.connection.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Serialize local threads and independent SQLite writers atomically."""
        with self.lock:
            self.connection.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.connection.execute("COMMIT")
            except BaseException:
                self.connection.execute("ROLLBACK")
                raise

    def execute(self, principal: str, request_id: str, request: Json,
                operation: Callable[[], Json]) -> Json:
        """Commit one result once; a lost response can be retried with the same payload."""
        with self.transaction():
            fingerprint = digest(request)
            previous = self.connection.execute(
                "SELECT fingerprint,result FROM receipts WHERE principal=? AND request_id=?",
                (principal, request_id)).fetchone()
            if previous:
                if previous[0] != fingerprint:
                    raise VisionError("REQUEST_ID_REUSED", 409)
                return json.loads(previous[1])
            count = self.connection.execute("SELECT count(*) FROM receipts").fetchone()[0]
            if count >= self.max_records:
                raise VisionError("STORAGE_LIMIT", 507)
            result = operation()
            self.connection.execute("INSERT INTO receipts VALUES (?,?,?,?)",
                                    (principal, request_id, fingerprint, canonical(result)))
            return result

    def add_frame(self, record: Json, image: bytes) -> None:
        """Insert a frame inside an existing transaction without evicting old evidence."""
        size, count = self.connection.execute(
            "SELECT coalesce(sum(length(image)),0),count(*) FROM frames").fetchone()
        if size + len(image) > self.max_bytes or count >= 1024:
            raise VisionError("STORAGE_LIMIT", 507)
        self.connection.execute("INSERT INTO frames VALUES (?,?,?,?)",
                                (record["frame_id"], record["camera_id"], canonical(record), image))

    def frame(self, frame_id: str) -> tuple[Json, bytes]:
        """Read immutable metadata and original source bytes."""
        with self.lock:
            row = self.connection.execute("SELECT record,image FROM frames WHERE id=?", (frame_id,)).fetchone()
        if not row:
            raise VisionError("NOT_FOUND", 404)
        return json.loads(row[0]), row[1]

    def add_observation(self, record: Json) -> None:
        """Insert a detector result inside the receipt transaction."""
        self.connection.execute("INSERT INTO observations VALUES (?,?,?,?)",
                                (record["observation_id"], record["camera_id"],
                                 record["frame_id"], canonical(record)))

    def observation(self, observation_id: str) -> Json:
        """Read a previously committed result without re-running the detector."""
        with self.lock:
            row = self.connection.execute("SELECT record FROM observations WHERE id=?", (observation_id,)).fetchone()
        if not row:
            raise VisionError("NOT_FOUND", 404)
        return json.loads(row[0])

    def observations(self, camera_id: str, limit: int) -> list[Json]:
        """Read bounded recent history for one authorized camera."""
        with self.lock:
            rows = self.connection.execute(
                "SELECT record FROM observations WHERE camera_id=? ORDER BY rowid DESC LIMIT ?",
                (camera_id, limit)).fetchall()
        return [json.loads(row[0]) for row in rows]
