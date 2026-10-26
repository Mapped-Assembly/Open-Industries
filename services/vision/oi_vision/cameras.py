"""Operator-configured camera sources shared by simulation and hardware clients."""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Protocol
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .contracts import MAX_IMAGE_BYTES, VisionError


@dataclass(frozen=True)
class CapturedImage:
    """Exact source bytes and optional source-reported modification time."""

    data: bytes
    source_modified_at_ms: int | None = None


class CameraSource(Protocol):
    """Produce bounded encoded image bytes without controlling a machine."""

    def capture(self) -> CapturedImage:
        """Acquire one image or raise a sanitized camera error."""
        ...


@dataclass(frozen=True)
class FileCamera:
    """Read an operator-selected snapshot, suitable for renderer output or replay."""

    path: Path

    def capture(self) -> CapturedImage:
        """Read a stable snapshot; producers should replace files atomically."""
        try:
            with self.path.open("rb") as stream:
                before = os.fstat(stream.fileno())
                if before.st_size > MAX_IMAGE_BYTES:
                    raise VisionError("IMAGE_TOO_LARGE", 413)
                data = stream.read(MAX_IMAGE_BYTES + 1)
                after = os.fstat(stream.fileno())
            if len(data) > MAX_IMAGE_BYTES:
                raise VisionError("IMAGE_TOO_LARGE", 413)
            if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                raise VisionError("SOURCE_CHANGED", 409)
            return CapturedImage(data, before.st_mtime_ns // 1_000_000)
        except OSError as exc:
            raise VisionError("CAMERA_UNAVAILABLE", 503) from exc


class NoRedirect(HTTPRedirectHandler):
    """Keep credentials and requests at the exact configured snapshot endpoint."""

    def redirect_request(self, req: Request, fp: object, code: int, msg: str,
                         headers: object, newurl: str) -> None:
        """Reject redirects rather than following camera-controlled locations."""
        raise HTTPError(req.full_url, code, "Redirects disabled", headers, fp)


@dataclass(frozen=True)
class HttpSnapshotCamera:
    """Fetch a trusted, fixed HTTP(S) JPEG/PNG endpoint; never an agent-supplied URL."""

    url: str
    bearer_token: str | None = None
    timeout_seconds: float = 4.0

    def capture(self) -> CapturedImage:
        """Bound response bytes and elapsed acquisition time; strip remote errors."""
        headers = {"Accept": "image/jpeg, image/png", "Cache-Control": "no-cache"}
        if self.bearer_token:
            headers["Authorization"] = f"Bearer {self.bearer_token}"
        request = Request(self.url, headers=headers)
        opener = build_opener(ProxyHandler({}), NoRedirect())
        deadline = time.monotonic() + self.timeout_seconds
        try:
            with opener.open(request, timeout=self.timeout_seconds) as response:
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_IMAGE_BYTES:
                    raise VisionError("IMAGE_TOO_LARGE", 413)
                chunks: list[bytes] = []
                size = 0
                while True:
                    if time.monotonic() > deadline:
                        raise VisionError("CAMERA_UNAVAILABLE", 503)
                    chunk = response.read1(min(65536, MAX_IMAGE_BYTES + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > MAX_IMAGE_BYTES:
                        raise VisionError("IMAGE_TOO_LARGE", 413)
                modified = response.headers.get("Last-Modified")
                timestamp = None
                if modified:
                    try:
                        timestamp = int(parsedate_to_datetime(modified).timestamp() * 1000)
                    except (ValueError, TypeError, OverflowError):
                        pass
                return CapturedImage(b"".join(chunks), timestamp)
        except VisionError:
            raise
        except Exception as exc:
            raise VisionError("CAMERA_UNAVAILABLE", 503) from exc
