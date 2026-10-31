"""Hard-kill/retry coverage for the actual local HTTP launcher and persisted robot run."""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import unittest
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[3]


@unittest.skipUnless(os.environ.get('SO101_SOURCE_ROOT'), 'Pinned SO101_SOURCE_ROOT required for real launcher test')
class ProcessTests(unittest.TestCase):
    """Use pinned mesh verification and a real independently running HTTP worker."""

    def test_hard_kill_reconnect_and_exact_receipt(self) -> None:
        """A killed process recovers paused, with no replayed motion or duplicate task."""
        with tempfile.TemporaryDirectory() as directory:
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            origin = f'http://127.0.0.1:{port}'
            child: subprocess.Popen | None = None
            def start() -> subprocess.Popen:
                """Launch without a controlling browser/client and wait for bounded readiness."""
                process = subprocess.Popen([sys.executable, 'scripts/embodied_runtime.py', '--source', os.environ['SO101_SOURCE_ROOT'],
                                            '--state-dir', directory, '--port', str(port)], cwd=ROOT,
                                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        self.fail(process.stderr.read().decode())
                    try:
                        with urlopen(origin + '/health', timeout=.3) as response:
                            if response.status == 200:
                                return process
                    except (URLError, TimeoutError):
                        pass
                    time.sleep(.05)
                process.kill()
                process.wait()
                self.fail('Launcher never became ready')

            def call(path: str, body: dict | None = None) -> dict:
                """Read the private capability from disk without putting it in URLs or logs."""
                token = (Path(directory) / 'client-token').read_text().strip()
                request = Request(origin + path, data=json.dumps(body).encode() if body else None,
                                  headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                with urlopen(request, timeout=3) as response:
                    return json.load(response)

            def command(action: str, text: str = '') -> dict:
                """Bind every new intent to the current run and frozen scene revision."""
                current = call('/api/embodied/run')
                return {'task_id': current['task']['id'] if current['task'] else None, 'request_id': str(uuid4()), 'run_id': current['run_id'], 'scene_revision': current['scene_revision'],
                        'action': action, 'text': text, 'selected_id': 'red-block'}
            try:
                child = start()
                call('/api/embodied/request', command('run'))
                body = command('chat', 'approach selected')
                receipt = call('/api/embodied/request', body)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    state = call('/api/embodied/run')
                    if state['task']['stage'] == 'running' and state['task']['progress'] > .02:
                        break
                    time.sleep(.03)
                self.assertEqual(state['task']['stage'], 'running')
                child.kill()
                child.wait(timeout=3)
                child.stderr.close()
                with sqlite3.connect(Path(directory) / 'station.sqlite') as database:
                    checkpoint = json.loads(database.execute('SELECT body FROM station').fetchone()[0])
                child = start()
                restored = call('/api/embodied/run')
                self.assertEqual(restored['task']['stage'], 'paused')
                self.assertEqual(restored['q'], checkpoint['q'])
                self.assertEqual(call('/api/embodied/request', body), receipt)
                call('/api/embodied/request', command('resume'))
                # No client is connected while the accepted worker advances.
                time.sleep(6)
                finished = call('/api/embodied/run')
                self.assertEqual(finished['task']['stage'], 'completed')
                self.assertEqual(finished['task']['id'], receipt['task_id'])
                self.assertEqual(sum(m['role'] == 'user' and m['text'] == 'approach selected' for m in finished['messages']), 1)
                self.assertEqual(finished['objects'], checkpoint['objects'])
                foreign = command('status')
                foreign['run_id'] = str(uuid4())
                with self.assertRaises(HTTPError) as denied:
                    call('/api/embodied/request', foreign)
                self.assertEqual(denied.exception.code, 409)
            finally:
                if child:
                    if child.poll() is None:
                        child.terminate()
                        child.wait(timeout=5)
                    child.stderr.close()
