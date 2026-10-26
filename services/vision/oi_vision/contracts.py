"""Shared validation, identifiers and JSON contracts; no machine actuation."""

from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Mapping, TypedDict

Json = dict[str, Any]
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_PIXELS = 8_000_000
MAX_IMAGE_SIDE = 4096
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")


class VisionError(Exception):
    """Expose a stable error code, never source URLs, paths or credentials."""

    def __init__(self, code: str, status: int = 400) -> None:
        """Initialize a public failure code and corresponding HTTP status."""
        super().__init__(code)
        self.code = code
        self.status = status


class FrameRecord(TypedDict):
    """Immutable acquisition evidence; acquisition time is not exposure time."""

    version: int
    frame_id: str
    camera_id: str
    machine_id: str
    evidence_kind: str
    adapter: str
    acquired_at_ms: int
    source_modified_at_ms: int | None
    sha256: str
    byte_length: int
    media_type: str
    width: int
    height: int


@dataclass(frozen=True)
class Principal:
    """Operator-configured principal restricted to explicit machine identities."""

    principal_id: str
    machines: frozenset[str]
    token_digest: bytes


def now_ms() -> int:
    """Return the service wall-clock timestamp in milliseconds."""
    return time.time_ns() // 1_000_000


def canonical(value: Any) -> str:
    """Encode finite JSON consistently for records and request fingerprints."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    """Hash a JSON value without including secrets in public records."""
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def identifier(value: Any) -> str:
    """Validate a machine, camera, profile, request or record identifier."""
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise VisionError("INVALID_REQUEST")
    return value


def object_fields(value: Any, required: set[str], optional: set[str] | None = None) -> Json:
    """Reject missing and unexpected fields at a JSON boundary."""
    if not isinstance(value, dict) or not required <= value.keys():
        raise VisionError("INVALID_REQUEST")
    if value.keys() - required - (optional or set()):
        raise VisionError("INVALID_REQUEST")
    return value


def integer(value: Any, minimum: int, maximum: int) -> int:
    """Validate a bounded integer, explicitly excluding JSON booleans."""
    if type(value) is not int or not minimum <= value <= maximum:
        raise VisionError("INVALID_REQUEST")
    return value


def public_camera(config: Mapping[str, Any]) -> Json:
    """Project camera identity and provenance without source configuration."""
    return {key: config[key] for key in ("camera_id", "machine_id", "adapter", "evidence_kind")}
