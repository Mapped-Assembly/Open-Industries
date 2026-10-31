"""Exercise the real configurable HTTP policy adapter with an explicitly fake model."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from typing import Any
import unittest
from unittest.mock import patch
from uuid import uuid4

from oi_embodied.policy import Policy
from oi_embodied.runtime import Runtime

FIXTURE = Path(__file__).resolve().parents[3] / 'benchmarks/embodied'


class ModelHandler(BaseHTTPRequestHandler):
    """Record a test request and return one typed action; no model quality claim."""

    captured: dict = {}
    response_text = '{"skill":"inspect","target_id":"red-block"}'

    def log_message(self, format: str, *args: Any) -> None:
        """Keep test traffic quiet and credentials out of diagnostics."""
        return

    def do_POST(self) -> None:
        """Return the same chat-completions envelope required of a configured endpoint."""
        ModelHandler.captured = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        data = json.dumps({'choices': [{'message': {'content': ModelHandler.response_text}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class PolicyHttpTests(unittest.TestCase):
    """Verify model transport, proposal validation and retained observed results."""

    def test_configured_policy_to_runtime(self) -> None:
        """A provider-shaped response traverses the actual tool/controller boundary."""
        server = ThreadingHTTPServer(('127.0.0.1', 0), ModelHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                'OI_AGENT_URL': f'http://127.0.0.1:{server.server_port}/v1/chat/completions',
                'OI_AGENT_MODEL': 'explicit-test-double', 'OI_AGENT_API_KEY': 'private-fixture-token',
            }):
                runtime = Runtime(Path(directory), FIXTURE, Policy())
                try:
                    state = runtime.snapshot()
                    def send(action: str, text: str = '') -> dict:
                        """Use the same public command envelope as the browser."""
                        return runtime.request({'task_id': None, 'request_id': str(uuid4()), 'run_id': state['run_id'], 'action': action,
                                                'text': text, 'selected_id': 'red-block', 'scene_revision': state['scene_revision']})
                    send('run')
                    send('chat', 'Tell me about this block.')
                    deadline = time.monotonic() + 3
                    while runtime.snapshot()['task']['stage'] == 'planning' and time.monotonic() < deadline:
                        time.sleep(.02)
                    result = runtime.snapshot()
                    self.assertEqual(result['task']['stage'], 'completed', result['task'])
                    self.assertEqual(result['task']['origin'], 'model')
                    self.assertTrue(result['observations'])
                    self.assertNotIn('private-fixture-token', json.dumps(result))
                    self.assertEqual(ModelHandler.captured['max_tokens'], 160)
                    payload = json.loads(ModelHandler.captured['messages'][1]['content'])
                    self.assertEqual(payload['selected_id'], 'red-block')
                    self.assertEqual(len(payload['scene']['objects']), 2)
                finally:
                    runtime.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
