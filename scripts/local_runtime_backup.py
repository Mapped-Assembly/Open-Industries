"""Back up or restore a complete local FIELD-LAB station into a NEW directory."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys

from runtime_backup import backup_database

FILES = ('operator.json', 'client.json', 'session.json')
ASSETS = ('field-lab-pipette.form.json', 'field-lab.oi.json', 'pipette-motion.json')


def copy_station(source: Path, destination: Path) -> None:
    """Snapshot SQLite online and copy immutable identity/assets; refuse partial sources.

    Credentials/assets must not be rotated during backup. Use a stopped service for
    credential changes. Never copy source WAL/SHM files or overwrite a destination.
    Restore uses this same validated operation and does not start any worker.
    """
    source = source.resolve(strict=True)
    for name in (*FILES, *(f'assets/{name}' for name in ASSETS)):
        if not (source / name).is_file():
            raise ValueError(f'Incomplete station: missing {name}')
    operator = json.loads((source / 'operator.json').read_text())
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    try:
        version = backup_database(source / 'lab.sqlite', destination / 'lab.sqlite')
        if version != 101:
            raise ValueError('Expected FIELD-LAB schema 101; use a compatible release')
        with sqlite3.connect(destination / 'lab.sqlite') as db:
            if not db.execute('SELECT 1 FROM labs WHERE id=?', (operator['instanceId'],)).fetchone():
                raise ValueError('Saved instance is absent; refusing replacement initialization')
        (destination / 'assets').mkdir(mode=0o700)
        for name in (*FILES, *(f'assets/{name}' for name in ASSETS)):
            target = destination / name
            shutil.copyfile(source / name, target)
            target.chmod(0o600)
        (destination / 'backup.json').write_text(json.dumps({'version': 1, 'schema': version, 'instance_id': operator['instanceId']}))
        (destination / 'backup.json').chmod(0o600)
    except BaseException:
        shutil.rmtree(destination)
        raise


def main() -> int:
    """Validate and copy a live backup or offline restore without losing identity."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        copy_station(args.source, args.destination)
    except (OSError, ValueError, KeyError, sqlite3.Error, TimeoutError) as error:
        print(f'Local station copy failed: {error}', file=sys.stderr)
        return 1
    print('Complete local station copied; keep the backup private (it includes credentials).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
