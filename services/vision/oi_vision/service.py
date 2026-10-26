"""Authenticated camera acquisition and observation operations for machine agents."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit
from uuid import uuid4

from .cameras import CameraSource, FileCamera, HttpSnapshotCamera
from .contracts import (Json, Principal, VisionError, digest, identifier, integer,
                        now_ms, object_fields, public_camera)
from .processing import analyze_image, check_opencv, decode_image, preview_image
from .store import ObservationStore


def environment_secret(name: Any) -> str:
    """Resolve an operator-owned environment reference without returning its value."""
    if not isinstance(name, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", name):
        raise VisionError("INVALID_CONFIGURATION")
    token = os.environ.get(name, "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise VisionError("INVALID_CONFIGURATION")
    return token


def validate_profile(value: Any) -> Json:
    """Validate a fixed detector profile, with OpenCV HSV bounds and explicit labels."""
    if not isinstance(value, dict):
        raise VisionError("INVALID_CONFIGURATION")
    if value.get("type") == "image_quality":
        object_fields(value, {"profile_id", "type"})
    elif value.get("type") == "color_regions":
        object_fields(value, {"profile_id", "type", "label", "lower_hsv", "upper_hsv", "min_area_px"})
        identifier(value["label"])
        integer(value["min_area_px"], 1, 8_000_000)
        for field in ("lower_hsv", "upper_hsv"):
            bound = value[field]
            if not isinstance(bound, list) or len(bound) != 3:
                raise VisionError("INVALID_CONFIGURATION")
            for index, maximum in enumerate((179, 255, 255)):
                integer(bound[index], 0, maximum)
        if any(low > high for low, high in zip(value["lower_hsv"], value["upper_hsv"])):
            raise VisionError("INVALID_CONFIGURATION")
    else:
        raise VisionError("INVALID_CONFIGURATION")
    identifier(value["profile_id"])
    return dict(value)


class VisionService:
    """Expose scoped read/capture/analyze operations; never send robot commands."""

    def __init__(self, config_path: Path, store: ObservationStore,
                 clock: Callable[[], int] = now_ms) -> None:
        """Load fixed camera/profile configuration and explicit machine-scoped principals."""
        self.opencv_version = check_opencv()
        self.store = store
        self.clock = clock
        self.cameras: dict[str, Json] = {}
        self.sources: dict[str, CameraSource] = {}
        self.profiles: dict[str, Json] = {}
        self.principals: list[Principal] = []
        try:
            config = json.loads(config_path.read_text())
            object_fields(config, {"cameras", "principals", "profiles"})
            for name in ("cameras", "principals", "profiles"):
                if not isinstance(config[name], list) or not 1 <= len(config[name]) <= 128:
                    raise VisionError("INVALID_CONFIGURATION")
            for raw in config["cameras"]:
                base = {"camera_id", "machine_id", "adapter", "evidence_kind"}
                if raw.get("adapter") == "file":
                    object_fields(raw, base | {"path"})
                    if not isinstance(raw["path"], str) or not raw["path"]:
                        raise VisionError("INVALID_CONFIGURATION")
                    source: CameraSource = FileCamera((config_path.parent / raw["path"]).resolve())
                elif raw.get("adapter") == "http_snapshot":
                    object_fields(raw, base | {"url"}, {"bearer_token_env"})
                    url = urlsplit(raw["url"])
                    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.fragment:
                        raise VisionError("INVALID_CONFIGURATION")
                    secret = environment_secret(raw["bearer_token_env"]) if "bearer_token_env" in raw else None
                    source = HttpSnapshotCamera(raw["url"], secret)
                else:
                    raise VisionError("INVALID_CONFIGURATION")
                camera_id = identifier(raw["camera_id"])
                identifier(raw["machine_id"])
                if raw["evidence_kind"] not in ("physical", "simulation", "fixture") or camera_id in self.cameras:
                    raise VisionError("INVALID_CONFIGURATION")
                self.cameras[camera_id] = public_camera(raw)
                self.sources[camera_id] = source
            for raw in config["profiles"]:
                profile = validate_profile(raw)
                if profile["profile_id"] in self.profiles:
                    raise VisionError("INVALID_CONFIGURATION")
                self.profiles[profile["profile_id"]] = profile
            machine_ids = {item["machine_id"] for item in self.cameras.values()}
            principal_ids: set[str] = set()
            digests: set[bytes] = set()
            for raw in config["principals"]:
                object_fields(raw, {"principal_id", "machines", "token_env"})
                principal_id = identifier(raw["principal_id"])
                if not isinstance(raw["machines"], list) or not 1 <= len(raw["machines"]) <= 128:
                    raise VisionError("INVALID_CONFIGURATION")
                machines = frozenset(identifier(value) for value in raw["machines"])
                token_digest = hashlib.sha256(environment_secret(raw["token_env"]).encode()).digest()
                if principal_id in principal_ids or token_digest in digests or not machines <= machine_ids:
                    raise VisionError("INVALID_CONFIGURATION")
                principal_ids.add(principal_id)
                digests.add(token_digest)
                self.principals.append(Principal(principal_id, machines, token_digest))
        except Exception as exc:
            raise VisionError("INVALID_CONFIGURATION") from exc

    def authenticate(self, header: str | None) -> Principal:
        """Map a bearer token to its operator-granted machine scope."""
        if not header or not header.startswith("Bearer ") or len(header) > 300:
            raise VisionError("AUTH_REQUIRED", 401)
        received = hashlib.sha256(header[7:].encode()).digest()
        for principal in self.principals:
            if hmac.compare_digest(principal.token_digest, received):
                return principal
        raise VisionError("AUTH_REQUIRED", 401)

    def camera(self, principal: Principal, camera_id: str) -> Json:
        """Hide both nonexistent cameras and cameras outside the principal's scope."""
        camera = self.cameras.get(identifier(camera_id))
        if camera is None or camera["machine_id"] not in principal.machines:
            raise VisionError("NOT_FOUND", 404)
        return camera

    def authorize_record(self, principal: Principal, record: Json) -> None:
        """Recheck current camera ownership when reading historical evidence."""
        camera = self.camera(principal, record["camera_id"])
        if camera["machine_id"] != record["machine_id"]:
            raise VisionError("NOT_FOUND", 404)

    def dispatch(self, principal: Principal, route: str, raw: Any) -> Json:
        """Validate and execute one versioned service operation."""
        if route == "/v1/cameras/list":
            object_fields(raw, set())
            return {"cameras": [value for value in self.cameras.values() if value["machine_id"] in principal.machines],
                    "profiles": list(self.profiles.values())}
        if route == "/v1/frames/capture":
            args = object_fields(raw, {"camera_id", "request_id"})
            camera = self.camera(principal, args["camera_id"])

            def capture() -> Json:
                """Acquire and commit exact bytes with their provenance."""
                captured = self.sources[camera["camera_id"]].capture()
                image, media_type = decode_image(captured.data)
                record = {"version": 1, **camera, "frame_id": str(uuid4()),
                          "acquired_at_ms": self.clock(), "source_modified_at_ms": captured.source_modified_at_ms,
                          "sha256": hashlib.sha256(captured.data).hexdigest(), "byte_length": len(captured.data),
                          "media_type": media_type, "width": image.shape[1], "height": image.shape[0]}
                self.store.add_frame(record, captured.data)
                return {"frame": record}

            result = self.store.execute(principal.principal_id, identifier(args["request_id"]),
                                        {"route": route, "args": args}, capture)
            self.authorize_record(principal, result["frame"])
            return result
        if route == "/v1/frames/read":
            args = object_fields(raw, {"frame_id"})
            record, data = self.store.frame(identifier(args["frame_id"]))
            self.authorize_record(principal, record)
            return {"frame": record, "preview": preview_image(decode_image(data)[0])}
        if route == "/v1/frames/analyze":
            args = object_fields(raw, {"frame_id", "profile_id", "request_id", "max_age_ms"})
            frame, data = self.store.frame(identifier(args["frame_id"]))
            self.authorize_record(principal, frame)
            profile = self.profiles.get(identifier(args["profile_id"]))
            if profile is None:
                raise VisionError("NOT_FOUND", 404)
            max_age = integer(args["max_age_ms"], 1, 86_400_000)

            def analyze() -> Json:
                """Record a real detector run against the exact immutable input frame."""
                timestamp = self.clock()
                age = timestamp - frame["acquired_at_ms"]
                if age < 0 or age > max_age:
                    raise VisionError("STALE_FRAME", 409)
                modified = frame["source_modified_at_ms"]
                if modified is not None and (modified > timestamp + 5000 or timestamp - modified > max_age):
                    raise VisionError("STALE_FRAME", 409)
                result = analyze_image(decode_image(data)[0], profile)
                record = {"version": 1, "observation_id": str(uuid4()), "frame_id": frame["frame_id"],
                          "camera_id": frame["camera_id"], "machine_id": frame["machine_id"],
                          "evidence_kind": frame["evidence_kind"], "frame_sha256": frame["sha256"],
                          "acquired_at_ms": frame["acquired_at_ms"], "analyzed_at_ms": timestamp,
                          "source_modified_at_ms": modified, "source_age_known": modified is not None,
                          "profile": profile, "profile_sha256": digest(profile), **result}
                self.store.add_observation(record)
                return {"observation": record}

            return self.store.execute(principal.principal_id, identifier(args["request_id"]),
                                      {"route": route, "args": args}, analyze)
        if route == "/v1/observations/read":
            args = object_fields(raw, {"observation_id"})
            record = self.store.observation(identifier(args["observation_id"]))
            self.authorize_record(principal, record)
            return {"observation": record}
        if route == "/v1/observations/list":
            args = object_fields(raw, {"camera_id", "limit"})
            camera = self.camera(principal, args["camera_id"])
            records = self.store.observations(camera["camera_id"], integer(args["limit"], 1, 100))
            return {"observations": [record for record in records if record["machine_id"] == camera["machine_id"]]}
        raise VisionError("NOT_FOUND", 404)
