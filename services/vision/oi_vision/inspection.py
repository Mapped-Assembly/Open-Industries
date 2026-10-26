"""Connect OpenCV evidence to existing simulated robot commands and their receipts."""

from __future__ import annotations

import copy
import json
import math
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable
from uuid import UUID, uuid5

from .agent_store import InspectionStore
from .agent_transport import ToolClient
from .contracts import Json, VisionError, digest, identifier, integer, now_ms, object_fields

TERMINAL = {"completed", "needs_review"}


def uuid(value: str) -> str:
    """Require canonical UUIDs for runtime identities and durable run keys."""
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
    except (ValueError, AttributeError) as exc:
        raise VisionError("INVALID_REQUEST") from exc
    return value


@dataclass(frozen=True)
class InspectionBinding:
    """An operator grants one camera a fixed simulated robot and survey destination."""

    binding_id: str
    camera_id: str
    match_id: str
    robot_id: str
    target_id: str
    profile_id: str
    max_age_ms: int = 60000
    timeout_ms: int = 120000
    min_laplacian_variance: float = 1.0
    min_luma: float = 1.0
    max_luma: float = 254.0

    @classmethod
    def parse(cls, value: Json) -> InspectionBinding:
        """Validate fixed inputs; callers never supply actions, URLs or target coordinates."""
        fields = set(cls.__dataclass_fields__)
        object_fields(value, {"binding_id", "camera_id", "match_id", "robot_id", "target_id", "profile_id"}, fields)
        binding = cls(**value)
        for name in ("binding_id", "camera_id", "profile_id"):
            identifier(getattr(binding, name))
        for name in ("match_id", "robot_id", "target_id"):
            uuid(getattr(binding, name))
        integer(binding.max_age_ms, 1000, 120000)
        integer(binding.timeout_ms, 1000, 300000)
        for name in ("min_laplacian_variance", "min_luma", "max_luma"):
            number = getattr(binding, name)
            if type(number) not in (int, float) or not math.isfinite(number) or number < 0:
                raise VisionError("INVALID_CONFIGURATION")
        if not binding.min_luma < binding.max_luma <= 255:
            raise VisionError("INVALID_CONFIGURATION")
        return binding


def load_bindings(path: Path) -> dict[str, InspectionBinding]:
    """Load bounded operator bindings without reading any service credentials into records."""
    try:
        config = json.loads(path.read_text())
        object_fields(config, {"bindings"})
        if not isinstance(config["bindings"], list) or not 1 <= len(config["bindings"]) <= 128:
            raise ValueError()
        bindings = [InspectionBinding.parse(value) for value in config["bindings"]]
        if len({binding.binding_id for binding in bindings}) != len(bindings):
            raise ValueError()
        return {binding.binding_id: binding for binding in bindings}
    except Exception as exc:
        raise VisionError("INVALID_CONFIGURATION") from exc


class InspectionAgent:
    """A deterministic inspection policy; all movement remains in the existing runtime."""

    def __init__(self, client: ToolClient, store: InspectionStore, binding: InspectionBinding,
                 clock: Callable[[], int] = now_ms) -> None:
        """Bind one fixed policy to authenticated tools and a recoverable trace store."""
        self.client, self.store, self.binding, self.clock = client, store, binding, clock
        self.fingerprint = digest({"policy": "oi-inspection/1", "binding": asdict(binding),
                                   "vision_service": os.getenv("OI_VISION_SERVICE_URL", "http://127.0.0.1:8792"),
                                   "runtime_service": os.getenv("ASTRA_GAME_SERVICE_URL", "http://127.0.0.1:8790")})

    def _authorize(self) -> tuple[Json, Json]:
        """Require current access to both the camera and an owned simulated robot."""
        cameras = self.client.call("astra.vision_list_cameras", {})
        camera = next((item for item in cameras["cameras"] if item["camera_id"] == self.binding.camera_id), None)
        profile = next((item for item in cameras["profiles"] if item["profile_id"] == self.binding.profile_id), None)
        if camera is None or camera["machine_id"] != self.binding.robot_id:
            raise VisionError("NOT_FOUND", 404)
        if camera["evidence_kind"] not in ("fixture", "simulation"):
            raise VisionError("SIMULATION_REQUIRED", 409)
        if profile is None or profile["type"] != "color_regions":
            raise VisionError("INVALID_CONFIGURATION")
        snapshot = self.client.call("astra.game_read_match", {"version": 5, "match_id": self.binding.match_id})["snapshot"]
        self._robot(snapshot)
        if not any(target["id"] == self.binding.target_id for target in snapshot["world"]["deposits"]):
            raise VisionError("NOT_FOUND", 404)
        return snapshot, profile

    def _robot(self, snapshot: Json) -> Json:
        """Resolve an owned robot from the runtime's authorized public projection."""
        robot = next((item for item in snapshot["field"]["robots"] if item["id"] == self.binding.robot_id and not item.get("retired")), None)
        if robot is None:
            raise VisionError("NOT_FOUND", 404)
        return robot

    def _read(self, run_id: str) -> Json:
        """Ensure a run cannot be rebound to a different camera, robot or service."""
        record = self.store.read(uuid(run_id))
        if record is None:
            raise VisionError("NOT_FOUND", 404)
        if record["binding_id"] != self.binding.binding_id:
            raise VisionError("NOT_FOUND", 404)
        if record["configuration_sha256"] != self.fingerprint:
            raise VisionError("RUN_CONFIGURATION_CHANGED", 409)
        return record

    def _save(self, record: Json, stage: str, reason: str, **updates: object) -> Json:
        """Append a bounded causal event and atomically advance the workflow checkpoint."""
        updated = copy.deepcopy(record)
        updated.update(updates)
        updated.update(stage=stage, reason=reason, updated_at_ms=self.clock())
        updated["events"].append({"at_ms": self.clock(), "stage": stage, "reason": reason})
        if len(updated["events"]) > 32:
            raise VisionError("STORAGE_LIMIT", 507)
        return self.store.replace(record, updated)

    def _capture(self, record: Json, phase: str) -> Json:
        """Capture and analyze through MCP using stable request IDs for each phase."""
        request = lambda suffix: str(uuid5(UUID(record["run_id"]), phase + "." + suffix))
        frame = self.client.call("astra.vision_capture", {"camera_id": self.binding.camera_id,
                                                          "request_id": request("capture")})["frame"]
        return self.client.call("astra.vision_analyze", {"frame_id": frame["frame_id"],
            "profile_id": self.binding.profile_id, "request_id": request("analyze"),
            "max_age_ms": self.binding.max_age_ms})["observation"]

    def _evidence_issue(self, observation: Json, profile: Json) -> str | None:
        """Recheck freshness and configured interpretation immediately before dispatch."""
        if (observation["camera_id"] != self.binding.camera_id or observation["machine_id"] != self.binding.robot_id
                or observation["profile_sha256"] != digest(profile)
                or observation["evidence_kind"] not in ("fixture", "simulation")):
            return "EVIDENCE_MISMATCH"
        timestamp = self.clock()
        for recorded in (observation["acquired_at_ms"], observation["source_modified_at_ms"]):
            if recorded is not None and not -1000 <= timestamp - recorded <= self.binding.max_age_ms:
                return "STALE_FRAME"
        metrics = observation["metrics"]
        if (not self.binding.min_luma <= metrics["mean_luma"] <= self.binding.max_luma
                or metrics["laplacian_variance"] < self.binding.min_laplacian_variance):
            return "IMAGE_QUALITY"
        if observation["truncated"] or observation["detection_count"] != 1:
            return "TARGET_AMBIGUOUS" if observation["detection_count"] else "TARGET_NOT_OBSERVED"
        if observation["detections"][0]["label"] != profile["label"]:
            return "EVIDENCE_MISMATCH"
        return None

    def read(self, run_id: str) -> Json:
        """Read a historical trace after rechecking both service authorizations."""
        self._authorize()
        return self._read(run_id)

    def advance(self, run_id: str) -> Json:
        """Advance one bounded phase; repeated calls resume the same immutable intent."""
        uuid(run_id)
        snapshot, profile = self._authorize()
        self.store.create({"version": 1, "policy_version": "oi-inspection/1", "run_id": run_id,
            "binding_id": self.binding.binding_id, "configuration_sha256": self.fingerprint,
            "machine_id": self.binding.robot_id, "camera_id": self.binding.camera_id,
            "match_id": self.binding.match_id, "target_id": self.binding.target_id,
            "stage": "observing", "reason": "CAPTURE_REQUIRED", "attempt": 0, "revision": 1,
            "created_at_ms": self.clock(), "updated_at_ms": self.clock(), "events": []})
        record = self._read(run_id)
        try:
            return self._advance(record, snapshot, profile)
        except VisionError as exc:
            if exc.code == "RUN_CONFLICT":
                return self._read(run_id)
            raise

    def _advance(self, record: Json, snapshot: Json, profile: Json) -> Json:
        """Observe, plan, dispatch, monitor and verify using existing tool contracts."""
        stage = record["stage"]
        if stage in TERMINAL:
            return record
        if stage == "observing":
            try:
                observation = self._capture(record, f"before-{record['attempt']}")
            except VisionError as exc:
                if exc.code not in ("STALE_FRAME", "INVALID_IMAGE", "IMAGE_TOO_LARGE", "CAMERA_UNAVAILABLE"):
                    raise
                return self._save(record, "needs_review", exc.code)
            issue = self._evidence_issue(observation, profile)
            if issue:
                observations = [*record.get("rejected_observations", []), observation]
                if record["attempt"] == 0 and issue in ("IMAGE_QUALITY", "TARGET_AMBIGUOUS", "TARGET_NOT_OBSERVED"):
                    return self._save(record, "observing", "RECAPTURE_REQUIRED", attempt=1,
                                      rejected_observations=observations)
                return self._save(record, "needs_review", issue, rejected_observations=observations)
            return self._save(record, "ready", "TARGET_OBSERVED", before=observation,
                              before_position=self._robot(snapshot)["position"])
        if stage == "ready":
            issue = self._evidence_issue(record["before"], profile)
            robot = self._robot(snapshot)
            if issue:
                return self._save(record, "needs_review", issue)
            if snapshot["status"] != "active" or robot["job_id"] is not None:
                return self._save(record, "needs_review", "ROBOT_NOT_IDLE")
            if robot["position"] != record["before_position"]:
                return self._save(record, "needs_review", "ROBOT_MOVED_SINCE_OBSERVATION")
            command = {"version": 5, "command_id": str(uuid5(UUID(record["run_id"]), f"survey-command-{record.get('command_attempt', 0)}")),
                       "match_id": self.binding.match_id, "expected_revision": snapshot["revision"],
                       "action": "survey_robot", "robot_id": self.binding.robot_id,
                       "deposit_id": self.binding.target_id, "sensor": "camera-depth"}
            record = self._save(record, "dispatching", "COMMAND_PREPARED", command=command,
                                prepared_at_ms=self.clock(), decision_observation_id=record["before"]["observation_id"])
            return self._dispatch(record)
        if stage == "dispatching":
            # An old prepared request may or may not have reached the runtime. Never
            # turn an uncertain outcome into a fresh command using new arguments.
            if self._evidence_issue(record["before"], profile):
                return self._save(record, "needs_review", "UNCERTAIN_COMMAND_EXPIRED")
            return self._dispatch(record)
        if stage == "running":
            job = next((job for job in snapshot["field"]["jobs"] if job["id"] == record["job_id"]), None)
            if job is None or job["robot_id"] != self.binding.robot_id or job["target_id"] != self.binding.target_id:
                return self._save(record, "needs_review", "JOB_NOT_FOUND")
            if job["state"] == "completed":
                if self._robot(snapshot)["job_id"] is not None:
                    return self._save(record, "needs_review", "ROBOT_REASSIGNED", runtime_job=job)
                return self._save(record, "verifying", "RUNTIME_JOB_COMPLETED", runtime_job=job,
                                  after_position=self._robot(snapshot)["position"], runtime_revision=snapshot["revision"])
            if job["state"] == "cancelled":
                return self._save(record, "needs_review", "JOB_CANCELLED", runtime_job=job)
            age = self.clock() - record["prepared_at_ms"]
            if age < 0 or age > self.binding.timeout_ms:
                return self._save(record, "needs_review", "RUNTIME_WAIT_EXPIRED", runtime_job=job)
            return {**record, "runtime_job": job, "current_position": self._robot(snapshot)["position"]}
        if stage == "verifying":
            robot = self._robot(snapshot)
            if robot["job_id"] is not None or robot["position"] != record["after_position"]:
                return self._save(record, "needs_review", "ROBOT_MOVED_DURING_VERIFICATION")
            try:
                observation = self._capture(record, "after")
            except VisionError as exc:
                if exc.code not in ("STALE_FRAME", "INVALID_IMAGE", "IMAGE_TOO_LARGE", "CAMERA_UNAVAILABLE"):
                    raise
                return self._save(record, "needs_review", "POST_ACTION_" + exc.code)
            issue = self._evidence_issue(observation, profile)
            if observation["acquired_at_ms"] < record["prepared_at_ms"]:
                issue = "STALE_FRAME"
            if observation["frame_sha256"] == record["before"]["frame_sha256"]:
                issue = "UNCHANGED_IMAGE"
            current = self.client.call("astra.game_read_match", {"version": 5, "match_id": self.binding.match_id})["snapshot"]
            current_robot = self._robot(current)
            if current_robot["job_id"] is not None or current_robot["position"] != record["after_position"]:
                issue = "ROBOT_MOVED_DURING_VERIFICATION"
            if issue:
                return self._save(record, "needs_review", "POST_ACTION_" + issue, after=observation)
            return self._save(record, "completed", "RUNTIME_AND_FOLLOWUP_OBSERVATION_RECORDED", after=observation,
                verification={"runtime_job_completed": True, "image_changed": True,
                              "robot_moved": record["before_position"] != record["after_position"],
                              "physical_motion_verified": False})
        raise VisionError("INVALID_RESULT", 503)

    def _dispatch(self, record: Json) -> Json:
        """Send only the durable prepared payload; uncertain retries keep its exact ID."""
        try:
            receipt = self.client.call("astra.game_command", record["command"])
        except VisionError as exc:
            if exc.code in ("OUTCOME_UNKNOWN", "UNAVAILABLE", "INVALID_RESULT", "AUTH_REQUIRED"):
                return {**record, "retryable": True, "transport_error": exc.code}
            if exc.code == "CONFLICT" and record.get("command_attempt", 0) < 2:
                return self._save(record, "ready", "REVISION_CONFLICT_RECHECK_REQUIRED",
                    command_attempt=record.get("command_attempt", 0) + 1,
                    rejected_commands=[*record.get("rejected_commands", []), record["command"]])
            return self._save(record, "needs_review", exc.code)
        snapshot = receipt["snapshot"]
        job_id = self._robot(snapshot)["job_id"]
        if receipt.get("command_id") != record["command"]["command_id"] or job_id is None:
            return {**record, "retryable": True, "transport_error": "INVALID_RESULT"}
        return self._save(record, "running", "COMMAND_ACCEPTED", job_id=job_id,
                          receipt_revision=snapshot["revision"])
