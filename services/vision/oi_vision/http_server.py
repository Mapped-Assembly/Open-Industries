"""Small bounded JSON transport for the independently running vision service."""

from __future__ import annotations

import json
import socket
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from . import __version__
from .contracts import VisionError, canonical
from .service import VisionService


class VisionHttpServer(ThreadingHTTPServer):
    """Limit concurrent requests and close idle clients; keep handlers non-daemonic."""

    daemon_threads = False
    block_on_close = True

    def __init__(self, address: tuple[str, int], service: VisionService) -> None:
        """Bind the service with a bounded pool of in-flight request handlers."""
        self.service = service
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, VisionHandler)

    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        """Refuse excess connections before allocating another handler thread."""
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        """Release the connection slot after success, timeout or transport failure."""
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class VisionHandler(BaseHTTPRequestHandler):
    """Serve health and authenticated versioned JSON operations without request logs."""

    server: VisionHttpServer

    def setup(self) -> None:
        """Bound idle socket time as well as the request body size."""
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format: str, *args: Any) -> None:
        """Do not put request paths or credentials into access logs."""

    def send_json(self, status: int, value: Any) -> None:
        """Send finite JSON and disable caching of private observations."""
        body = canonical(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        """Health identifies the loaded library; it does not certify camera availability."""
        if self.path == "/health":
            self.send_json(200, {"service": "open-industries-vision", "version": __version__,
                                 "contract_version": 1, "opencv_version": self.server.service.opencv_version})
        else:
            self.send_json(404, {"error": {"code": "NOT_FOUND"}})

    def do_POST(self) -> None:
        """Authenticate before processing bounded image-operation arguments."""
        try:
            if self.headers.get("Origin") is not None:
                raise VisionError("ORIGIN_NOT_ALLOWED", 403)
            principal = self.server.service.authenticate(self.headers.get("Authorization"))
            if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise VisionError("INVALID_REQUEST")
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError as exc:
                raise VisionError("INVALID_REQUEST") from exc
            if not 0 <= length <= 65536:
                raise VisionError("REQUEST_TOO_LARGE", 413)
            body = self.rfile.read(length)
            if len(body) != length:
                raise VisionError("INVALID_REQUEST")
            try:
                args = json.loads(body)
            except (ValueError, UnicodeDecodeError) as exc:
                raise VisionError("INVALID_REQUEST") from exc
            self.send_json(200, self.server.service.dispatch(principal, self.path, args))
        except VisionError as exc:
            self.send_json(exc.status, {"error": {"code": exc.code}})
        except sqlite3.OperationalError:
            self.send_json(503, {"error": {"code": "STORE_UNAVAILABLE"}})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.send_json(503, {"error": {"code": "UNAVAILABLE"}})
