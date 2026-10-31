"""Loopback HTTP bridge and local launcher for the embodied workbench."""
from __future__ import annotations

import argparse
import hashlib
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import secrets
import signal
import threading
from typing import Any
from urllib.parse import urlparse
import xml.etree.ElementTree as ET

import numpy as np
from scipy.spatial.transform import Rotation

from .runtime import Runtime, canonical


def assets(source: Path, fixture: Path) -> tuple[dict[str, Any], dict[str, Path]]:
    """Verify every immutable source byte before exposing upstream robot visuals."""
    lock = json.loads((fixture / 'source-lock.json').read_text())
    for name, expected in lock['files'].items():
        data = (source / name).read_bytes()
        if len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
            raise ValueError('SO101_SOURCE_HASH_MISMATCH: checkout the documented upstream commit')
    robot = ET.parse(source / lock['urdf']).getroot()
    manifest: dict[str, Any] = {'source_commit': lock['commit'], 'links': {}}
    files = {}
    for link in robot.findall('link'):
        visuals = []
        for visual in link.findall('visual'):
            mesh = visual.find('geometry/mesh')
            if mesh is None:
                continue
            filename = mesh.attrib['filename']
            path = (source / lock['urdf']).parent / filename
            path = path.resolve()
            if not path.is_relative_to(source.resolve()) or path.relative_to(source.resolve()).as_posix() not in lock['files']:
                raise ValueError('UNPINNED_MESH')
            key = path.name
            files['/robot-assets/' + key] = path
            origin = visual.find('origin')
            matrix = np.eye(4)
            if origin is not None:
                matrix[:3, 3] = [float(v) for v in origin.attrib.get('xyz', '0 0 0').split()]
                matrix[:3, :3] = Rotation.from_euler('xyz', [float(v) for v in origin.attrib.get('rpy', '0 0 0').split()]).as_matrix()
            visuals.append({'url': '/robot-assets/' + key, 'origin': matrix.tolist(),
                            'scale': [float(v) for v in mesh.attrib.get('scale', '1 1 1').split()]})
        manifest['links'][link.attrib['name']] = visuals
    return manifest, files


class Server(ThreadingHTTPServer):
    """Serve one private local station with fixed origin and explicit session boundary."""

    daemon_threads = True

    def __init__(self, port: int, runtime: Runtime, web: Path, source: Path, fixture: Path, token: str) -> None:
        """Bind loopback only; model credentials never become browser configuration."""
        self.runtime, self.web, self.token = runtime, web.resolve(), token
        self.manifest, self.files = assets(source, fixture)
        super().__init__(('127.0.0.1', port), Handler)
        self.origin = f'http://127.0.0.1:{self.server_port}'


class Handler(BaseHTTPRequestHandler):
    """Use same-origin HttpOnly sessions; support private bearer clients without CORS."""

    server: Server

    def log_message(self, format: str, *args: Any) -> None:
        """Avoid logging request bodies, credentials and private state."""
        return

    def send(self, status: int, value: Any) -> None:
        """Return bounded JSON with no caching or raw exception details."""
        data = canonical(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        self.wfile.write(data)

    def authorized(self, mutation: bool = False) -> bool:
        """Reject foreign Host/Origin and cross-site requests before checking the session."""
        if self.headers.get('Host') != self.server.origin.removeprefix('http://'):
            return False
        origin = self.headers.get('Origin')
        if origin not in (None, self.server.origin) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return False
        if self.headers.get('Authorization') == 'Bearer ' + self.server.token and origin is None:
            return True
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
            value = cookie.get('oi_embodied')
            return bool(value and secrets.compare_digest(value.value, self.server.token) and (not mutation or origin == self.server.origin))
        except Exception:
            return False

    def do_GET(self) -> None:
        """Bootstrap a local operator session, then serve authenticated state and pinned assets."""
        path = urlparse(self.path).path
        if self.headers.get('Host') != self.server.origin.removeprefix('http://') or self.headers.get('Origin') not in (None, self.server.origin) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return self.send(403, {'error': 'LOCAL_ORIGIN_REQUIRED'})
        if path == '/health':
            return self.send(503 if self.server.runtime.failure else 200, {'version': 1, 'scheduler_healthy': self.server.runtime.failure is None})
        if path.startswith('/api/'):
            if not self.authorized():
                return self.send(401, {'error': 'AUTH_REQUIRED'})
            if path == '/api/embodied/run':
                return self.send(200, self.server.runtime.snapshot())
            if path == '/api/embodied/model':
                return self.send(200, self.server.manifest)
            return self.send(404, {'error': 'NOT_FOUND'})
        file = self.server.files.get(path)
        if file is None:
            file = (self.server.web / (path.lstrip('/') or 'index.html')).resolve()
            if not file.is_relative_to(self.server.web):
                return self.send(404, {'error': 'NOT_FOUND'})
        if not file.is_file():
            return self.send(404, {'error': 'NOT_FOUND'})
        data = file.read_bytes()
        self.send_response(200)
        if path in ('/', '/index.html'):
            self.send_header('Set-Cookie', f'oi_embodied={self.server.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400')
        self.send_header('Content-Type', mimetypes.guess_type(file.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Content-Security-Policy', "frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        """Submit a validated intent; receipts make uncertain retries safe."""
        if not self.authorized(mutation=True):
            return self.send(403, {'error': 'AUTH_OR_ORIGIN_REQUIRED'})
        if self.path != '/api/embodied/request':
            return self.send(404, {'error': 'NOT_FOUND'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 1 or size > 8192 or self.headers.get('Content-Type') != 'application/json':
                return self.send(400, {'error': 'INVALID_REQUEST'})
            self.connection.settimeout(5)
            body = json.loads(self.rfile.read(size))
            return self.send(200, self.server.runtime.request(body))
        except ValueError as error:
            return self.send(409, {'error': str(error)[:250]})
        except Exception:
            return self.send(503, {'error': 'UNAVAILABLE: reconnect and retry the same request ID'})


def main() -> None:
    """Launch the existing workbench build with one persistent simulated controller."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='Pinned SO-ARM100 checkout')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.local/share/open-industries/embodied')
    parser.add_argument('--port', type=int, default=4197)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    fixture, web = root / 'benchmarks/embodied', root / 'dist'
    if not (web / 'index.html').is_file():
        parser.error('Run npm run build first')
    os.umask(0o077)
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    token_file = args.state_dir / 'client-token'
    if token_file.exists() and not (args.state_dir / 'station.sqlite').is_file():
        parser.error('Saved station database missing. Restore the complete state directory; refusing to replace the run.')
    # Validate before opening state so missing assets cannot partially initialize a station.
    assets(args.source, fixture)
    runtime = Runtime(args.state_dir, fixture)
    if not token_file.exists():
        temporary = args.state_dir / 'client-token.tmp'
        with temporary.open('w') as output:
            temporary.chmod(0o600)
            output.write(secrets.token_hex(32))
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(token_file)
    token = token_file.read_text().strip()
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        runtime.close()
        parser.error('Invalid saved client token; restore the complete station backup.')
    server = Server(args.port, runtime, web, args.source, fixture, token)
    def shutdown(signum: int, frame: Any) -> None:
        """Stop accepting requests without deadlocking the HTTP serving thread."""
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    def monitor() -> None:
        """Exit a failed authority so an external local supervisor can recover it."""
        runtime.stop_event.wait()
        if runtime.failure:
            server.shutdown()
    threading.Thread(target=monitor, daemon=True).start()
    print(f'Embodied workbench: {server.origin}/?run=so101', flush=True)
    print(f'Private state: {args.state_dir}; mode: {runtime.policy.mode}', flush=True)
    try:
        server.serve_forever(poll_interval=.1)
    finally:
        server.server_close()
        runtime.close()
    if runtime.failure:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
