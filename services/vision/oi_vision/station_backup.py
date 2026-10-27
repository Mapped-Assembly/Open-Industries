"""Copy and verify complete offline station state; callers must stop all station/MCP units first."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

from .demo_host import DemoError, DirectoryLock, read_json, write_json
from .station_evidence import require, timestamp


def inventory(directory: Path) -> dict[str, str]:
    """Hash every state file, refusing symlinks and omitting only the ephemeral lock inode."""
    files = {}
    for path in sorted(directory.rglob("*")):
        require(not path.is_symlink(), "BACKUP_SYMLINK_REFUSED")
        if path.is_file() and path.name != ".host.lock":
            files[str(path.relative_to(directory))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


def check_databases(directory: Path) -> None:
    """Check all three independent SQLite stores, including any committed WAL content."""
    for name in ("runtime.sqlite", "observations.sqlite"):
        require((directory / name).is_file(), "BACKUP_MISSING_DATABASE")
    for path in directory.glob("*.sqlite"):
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
        try:
            require(connection.execute("PRAGMA quick_check").fetchall() == [("ok",)], "BACKUP_CORRUPT_DATABASE")
        finally:
            connection.close()


def commit(root: Path) -> str:
    """Record the exact release needed to restore the saved root binding."""
    return subprocess.check_output(["git", "-c", f"safe.directory={root}", "-C", str(root), "rev-parse", "HEAD"],
                                   text=True).strip()


def backup(directory: Path, destination: Path) -> None:
    """Back up stopped state plus its release identity; never copy a running multi-store station."""
    directory, destination = directory.resolve(), destination.resolve()
    require(not destination.is_relative_to(directory), "BACKUP_INSIDE_STATE_REFUSED")
    require(not destination.exists(), "BACKUP_DESTINATION_EXISTS")
    lock = DirectoryLock(directory)
    lock.acquire()
    try:
        require(read_json(directory / "ready.json").get("status") == "stopped", "STOP_STATION_BEFORE_BACKUP")
        state = read_json(directory / "host.json")
        inventory(directory)
        check_databases(directory)
        destination.mkdir(mode=0o700, parents=True)
        shutil.copytree(directory, destination / "state", ignore=shutil.ignore_patterns(".host.lock"))
        check_databases(destination / "state")
        write_json(destination / "manifest.json", {"schema": "oi-station-backup/1", "created_at": timestamp(),
                   "state_path": str(directory), "root": state["root"], "commit": commit(Path(state["root"])),
                   "files": inventory(destination / "state")})
    finally:
        lock.release()


def restore(archive: Path, directory: Path) -> None:
    """Restore a verified complete archive to its original, absent path and matching release."""
    archive, directory = archive.resolve(), directory.resolve()
    manifest = read_json(archive / "manifest.json")
    require(manifest.get("schema") == "oi-station-backup/1", "BACKUP_SCHEMA_MISMATCH")
    require(str(directory) == manifest["state_path"], "RESTORE_PATH_BINDING_MISMATCH")
    require(not directory.exists(), "RESTORE_DESTINATION_EXISTS")
    require(commit(Path(manifest["root"])) == manifest["commit"], "RESTORE_RELEASE_MISMATCH")
    require(inventory(archive / "state") == manifest["files"], "BACKUP_HASH_MISMATCH")
    require(read_json(archive / "state/host.json")["root"] == manifest["root"], "RESTORE_ROOT_MISMATCH")
    shutil.copytree(archive / "state", directory)
    directory.chmod(0o700)
    check_databases(directory)


def main() -> None:
    """Run offline backup/restore under the operator's exclusive maintenance lock."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("backup", "restore"))
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/oi-station/state"))
    parser.add_argument("--archive", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.operation == "backup":
            backup(args.state_dir, args.archive)
        else:
            restore(args.archive, args.state_dir)
        print(json.dumps({"status": "passed", "operation": args.operation}))
    except Exception as exc:
        code = str(exc) if isinstance(exc, DemoError) else "STATION_BACKUP_FAILED"
        print(json.dumps({"error": {"code": code}}), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
