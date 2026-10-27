"""Persistent agent control of the existing ASTRA/SO-101 kinematic sample farm."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
from typing import Any
from uuid import UUID, uuid4

import cv2
import numpy as np

from .demo_host import DirectoryLock

SOURCE_COMMIT = "523d1f5a54b5b279d6d2ae9fcb8b5315b15573aa"
BOUNDARIES = (0., 6., 18., 24., 36., 42., 54., 72.)
ACTIONS = ("move_to_next_bed", "harvest", "move_to_next_bed", "harvest",
           "move_to_next_bed", "harvest", "return_home")
BEDS = (2, 1, 0)


class FarmError(ValueError):
    """Return a bounded public error code without exposing private configuration."""


def require(condition: bool, code: str) -> None:
    """Validate commands without relying on optimizable assertions."""
    if not condition:
        raise FarmError(code)


def canonical_uuid(value: Any) -> str:
    """Require a canonical caller-generated UUID for idempotent commands."""
    try:
        require(isinstance(value, str) and str(UUID(value)) == value, "INVALID_REQUEST")
    except (ValueError, AttributeError):
        raise FarmError("INVALID_REQUEST") from None
    return value


def analyze_pixels(rgb: np.ndarray, bed: int) -> dict[str, Any]:
    """Measure color evidence in the calibrated simulated pickup ROI, not plant semantics."""
    height, width = rgb.shape[:2]
    roi = rgb[height//2-16:height//2+16, width//2-16:width//2+16]
    hsv = cv2.cvtColor(roi, cv2.COLOR_RGB2HSV)
    low, high = ((0, 120, 140), (9, 255, 255)) if bed == 0 else (
        ((30, 90, 100), (90, 255, 255)) if bed == 1 else ((5, 120, 140), (25, 255, 255)))
    mask = cv2.inRange(hsv, np.array(low), np.array(high))
    if bed == 0:
        mask |= cv2.inRange(hsv, np.array((170, 120, 140)), np.array((179, 255, 255)))
    pixels = int(cv2.countNonZero(mask))
    return {"target_pixels": pixels, "target_visible": pixels >= 5,
            "roi": [width//2-16, height//2-16, 32, 32], "opencv": cv2.__version__,
            "interpretation": "color candidate at fixed simulated pickup location; not crop recognition"}


def analyze_pov(rgba: bytes) -> dict[str, Any]:
    """Find bounded color contours in browser-rendered POV pixels; no semantic claims."""
    require(len(rgba) == 256*160*4, "INVALID_REQUEST")
    pixels = np.frombuffer(rgba, dtype=np.uint8).reshape(160, 256, 4)
    hsv = cv2.cvtColor(pixels[:, :, :3], cv2.COLOR_RGB2HSV)
    boxes = []
    for label, low, high in (("red", (0, 120, 110), (9, 255, 255)),
                             ("orange", (10, 120, 110), (25, 255, 255)),
                             ("green", (30, 90, 80), (90, 255, 255))):
        mask = cv2.inRange(hsv, np.array(low), np.array(high))
        if label == "red":
            mask |= cv2.inRange(hsv, np.array((170, 120, 110)), np.array((179, 255, 255)))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < 12:
                continue
            x, y, width, height = cv2.boundingRect(contour)
            boxes.append({"label": label, "box": [x, y, width, height], "area": area})
    return {"width": 256, "height": 160, "boxes": sorted(boxes, key=lambda box: box["area"], reverse=True)[:24],
            "method": "OpenCV HSV color contours", "opencv": cv2.__version__}


class FarmRuntime:
    """Own the farm clock, model, durable commands and camera; agents never set poses/time."""

    def __init__(self, source: Path, directory: Path, clock: Any = time.monotonic) -> None:
        """Load the existing farm assets and resume the saved simulation without looping."""
        self.directory = directory.resolve()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lease = DirectoryLock(self.directory)
        self.lease.acquire()
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.clock = clock
        self.last = clock()
        self.failure: str | None = None
        self.thread: threading.Thread | None = None
        self.db: sqlite3.Connection | None = None
        try:
            os.environ.setdefault("MUJOCO_GL", "egl")
            os.environ.setdefault("EGL_PLATFORM", "surfaceless")
            sys.path.insert(0, str(source.resolve()))
            import mujoco
            from simulation.garden_patrol import build_model, CROPS
            from simulation.harvest_mission import HarvestMission
            self.mj, self.crops = mujoco, CROPS
            self.model = build_model(harvest=True)
            self.mission = HarvestMission(self.model)
            self.data = mujoco.MjData(self.model)
            self.db = sqlite3.connect(self.directory / "farm.sqlite", check_same_thread=False)
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, request TEXT NOT NULL, receipt TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS frames(id TEXT PRIMARY KEY, body TEXT NOT NULL, png BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS demo_commands(id TEXT PRIMARY KEY, request TEXT NOT NULL, receipt TEXT NOT NULL);
            """)
            row = self.db.execute("SELECT body FROM state WHERE id=1").fetchone()
            self.state = json.loads(row[0]) if row else {
                "version": 1, "station_id": str(uuid4()), "source": str(source.resolve()),
                "elapsed": 0., "boundary": 0, "revision": 0, "active_job": None, "paused": False,
                "review_required": False}
            require(self.state.get("version") == 1, "UNSUPPORTED_FARM_STATE")
            require(self.state["source"] == str(source.resolve()), "SOURCE_BINDING_CHANGED")
            self.state.setdefault("run_id", self.state["station_id"])
            self.state.setdefault("controller", "manual")
            self.state.setdefault("controller_error", None)
            self.mission.update(self.data, self.state["elapsed"])
            with self.db:
                self.save()
        except BaseException:
            self.close()
            raise

    def save(self) -> None:
        """Checkpoint the station in the caller's SQLite transaction."""
        self.db.execute("INSERT OR REPLACE INTO state VALUES(1,?)", (json.dumps(self.state),))

    def start(self) -> None:
        """Start one persistent clock independent of MCP connections and browser visits."""
        self.last = self.clock()
        self.thread = threading.Thread(target=self.run, name="farm-clock", daemon=True)
        self.thread.start()

    def run(self) -> None:
        """Advance bounded kinematics and checkpoint every frame; stop on runtime failure."""
        try:
            while not self.stop.wait(1/15):
                self.tick()
        except Exception:
            self.failure = "RUNTIME_FAILED"
            self.stop.set()

    def tick(self) -> None:
        """Consume only observed process uptime; restart downtime does not teleport the robot."""
        with self.lock, self.db:
            now = self.clock()
            delta, self.last = min(max(now-self.last, 0), .25), now
            if self.state["controller"] == "running" and not self.state["active_job"]:
                self.advance_controller()
            if not self.state["active_job"] or self.state["paused"]:
                return
            job = self.job(self.state["active_job"])
            self.state["elapsed"] = min(job["target_elapsed"], self.state["elapsed"] + delta)
            pose = self.mission.update(self.data, self.state["elapsed"])
            if self.state["elapsed"] == job["target_elapsed"]:
                self.state["boundary"] += 1
                self.state["revision"] += 1
                self.state["active_job"] = None
                job["stage"] = "completed"
                job["finished_at_ms"] = int(time.time()*1000)
                if job["action"] == "harvest":
                    after = self.capture(job["bed"], internal=True)
                    before = self.frame(job["observation_id"])[0]
                    job["after_observation_id"] = after["observation_id"]
                    job["verification"] = {"deposited": job["bed"] in pose.deposited,
                        "image_changed": before["sha256"] != after["sha256"],
                        "pickup_color_reduced": after["analysis"]["target_pixels"] < before["analysis"]["target_pixels"]}
                    if not all(job["verification"].values()):
                        job["stage"] = "needs_review"
                        self.state["review_required"] = True
                self.db.execute("UPDATE jobs SET body=? WHERE id=?", (json.dumps(job), job["command_id"]))
            self.save()

    def advance_controller(self) -> None:
        """Select the next bounded command using the same vision gates as MCP callers."""
        if self.state["review_required"] or self.state["boundary"] == 7:
            self.state["controller"] = "needs_review" if self.state["review_required"] else "completed"
            self.save()
            return
        try:
            boundary = self.state["boundary"]
            request = {"command_id": str(uuid4()), "expected_revision": self.state["revision"],
                       "action": ACTIONS[boundary]}
            if request["action"] == "harvest":
                request["observation_id"] = self.capture(BEDS[boundary//2])["observation_id"]
            self.command(request)
        except FarmError as exc:
            self.state["controller"] = "needs_review"
            self.state["controller_error"] = str(exc)
            self.state["review_required"] = True
        self.save()

    def demo_command(self, request: dict[str, Any]) -> dict[str, Any]:
        """Idempotent browser controls; archive runs without removing any evidence."""
        require(set(request) == {"command_id", "expected_revision", "action"}, "INVALID_REQUEST")
        ident = canonical_uuid(request["command_id"])
        serialized = json.dumps(request, sort_keys=True)
        with self.lock, self.db:
            previous = self.db.execute("SELECT request,receipt FROM demo_commands WHERE id=?", (ident,)).fetchone()
            if previous:
                require(previous[0] == serialized, "COMMAND_ID_REUSED")
                return json.loads(previous[1])
            require(type(request["expected_revision"]) is int and request["expected_revision"] == self.state["revision"], "REVISION_CONFLICT")
            action = request["action"]
            require(action in ("new_run", "start", "pause", "resume"), "INVALID_REQUEST")
            if action == "new_run":
                require(not self.state["active_job"] and self.state["controller"] != "running", "ROBOT_BUSY")
                self.db.execute("INSERT INTO runs VALUES(?,?)", (self.state["run_id"], json.dumps(self.state)))
                self.state.update(run_id=str(uuid4()), elapsed=0., boundary=0, paused=False,
                                  review_required=False, controller="manual", controller_error=None)
                self.mission.update(self.data, 0.)
            elif action == "start":
                require(not self.state["review_required"] and self.state["boundary"] < 7, "ACTION_NOT_AVAILABLE")
                require(not self.state["active_job"], "ROBOT_BUSY")
                self.state["controller"] = "running"
            else:
                require(self.state["controller"] == ("running" if action == "pause" else "paused"), "ACTION_NOT_AVAILABLE")
                self.state["controller"] = "paused" if action == "pause" else "running"
                self.state["paused"] = action == "pause"
            self.state["revision"] += 1
            self.last = self.clock()
            result = {"run_id": self.state["run_id"], "revision": self.state["revision"], "action": action}
            self.db.execute("INSERT INTO demo_commands VALUES(?,?,?)", (ident, serialized, json.dumps(result)))
            self.save()
            return result

    def evidence(self) -> dict[str, Any]:
        """Expose current evidence and retained run summaries for the demo screen."""
        with self.lock:
            jobs = [json.loads(row[0]) for row in self.db.execute("SELECT body FROM jobs ORDER BY rowid")]
            jobs = [job for job in jobs if job.get("run_id", self.state["station_id"]) == self.state["run_id"]]
            frames = [self.frame(job[key])[0] for job in jobs for key in ("observation_id", "after_observation_id") if job.get(key)]
            history = [json.loads(row[0]) for row in self.db.execute("SELECT body FROM runs ORDER BY rowid DESC")]
            return {"jobs": jobs, "frames": frames, "history": [{"run_id": run["run_id"], "boundary": run["boundary"]} for run in history]}

    def status(self) -> dict[str, Any]:
        """Expose current authoritative state and the next bounded action."""
        with self.lock:
            require(not self.failure, "RUNTIME_FAILED")
            pose = self.mission.update(self.data, self.state["elapsed"])
            boundary = self.state["boundary"]
            return {"station_id": self.state["station_id"], "revision": self.state["revision"],
                "source_commit": SOURCE_COMMIT,
                "run_id": self.state["run_id"], "controller": self.state["controller"],
                "controller_error": self.state["controller_error"],
                "elapsed": self.state["elapsed"], "duration": 72, "boundary": boundary,
                "phase": pose.phase, "paused": self.state["paused"], "active_job": self.state["active_job"],
                "review_required": self.state["review_required"],
                "next_action": ACTIONS[boundary] if boundary < len(ACTIONS) else None,
                "next_bed": BEDS[boundary//2] if boundary < 6 else None,
                "deposited": list(pose.deposited), "robot_position": self.data.qpos[:3].tolist(),
                "robot_quaternion": self.data.qpos[3:7].tolist(),
                "joint_positions": self.data.qpos[self.mission.qids].tolist(),
                "simulated": True, "looping": False, "control": "agent-selected kinematic segments; scripted grasp/release"}

    def job(self, command_id: str) -> dict[str, Any]:
        """Read durable mutable progress for a command; receipts remain immutable."""
        with self.lock:
            row = self.db.execute("SELECT body FROM jobs WHERE id=?", (canonical_uuid(command_id),)).fetchone()
            require(row is not None, "NOT_FOUND")
            return json.loads(row[0])

    def frame(self, observation_id: str) -> tuple[dict[str, Any], bytes]:
        """Read only a persisted frame selected by UUID, never caller-supplied paths."""
        with self.lock:
            row = self.db.execute("SELECT body,png FROM frames WHERE id=?", (canonical_uuid(observation_id),)).fetchone()
            require(row is not None, "NOT_FOUND")
            return json.loads(row[0]), row[1]

    def capture(self, bed: int, *, internal: bool = False) -> dict[str, Any]:
        """Render actual farm geometry with CPU-capable EGL and analyze the pickup ROI."""
        require(type(bed) is int and 0 <= bed <= 2, "INVALID_REQUEST")
        with self.lock:
            require(self.db.execute("SELECT count(*) FROM frames").fetchone()[0] < (256 if internal else 255), "STORAGE_LIMIT")
            camera = self.mj.MjvCamera()
            camera.lookat[:] = (float(bed-1), .55, .32)
            camera.distance, camera.azimuth, camera.elevation = .85, 90, -90
            with self.mj.Renderer(self.model, height=240, width=320) as renderer:
                renderer.update_scene(self.data, camera)
                pixels = renderer.render().copy()
            ok, encoded = cv2.imencode(".png", cv2.cvtColor(pixels, cv2.COLOR_RGB2BGR))
            require(ok, "CAMERA_UNAVAILABLE")
            png = encoded.tobytes()
            record = {"observation_id": str(uuid4()), "bed": bed, "crop_label": self.crops[bed],
                "run_id": self.state["run_id"],
                "captured_at_ms": int(time.time()*1000), "revision": self.state["revision"],
                "elapsed": self.state["elapsed"], "sha256": hashlib.sha256(png).hexdigest(),
                "evidence_kind": "simulation", "analysis": analyze_pixels(pixels, bed)}
            self.db.execute("INSERT INTO frames VALUES(?,?,?)", (record["observation_id"], json.dumps(record), png))
            return record

    def command(self, request: dict[str, Any]) -> dict[str, Any]:
        """Accept bounded segment commands once, with revision and vision checks before motion."""
        required = {"command_id", "action", "expected_revision"}
        require(isinstance(request, dict) and required <= request.keys()
                and not request.keys()-required-{"observation_id"}, "INVALID_REQUEST")
        command_id = canonical_uuid(request["command_id"])
        action = request["action"]
        require(action in {*ACTIONS, "pause", "resume"}, "INVALID_REQUEST")
        require(type(request["expected_revision"]) is int, "INVALID_REQUEST")
        serialized = json.dumps(request, sort_keys=True)
        with self.lock, self.db:
            previous = self.db.execute("SELECT request,receipt FROM commands WHERE id=?", (command_id,)).fetchone()
            if previous:
                require(previous[0] == serialized, "COMMAND_ID_REUSED")
                return json.loads(previous[1])
            require(not self.failure, "RUNTIME_FAILED")
            require(self.db.execute("SELECT count(*) FROM commands").fetchone()[0] < 1000, "STORAGE_LIMIT")
            require(request["expected_revision"] == self.state["revision"], "REVISION_CONFLICT")
            if action in ("pause", "resume"):
                require(self.state["active_job"] is not None, "NO_ACTIVE_JOB")
                self.state["paused"] = action == "pause"
            else:
                require(not self.state["review_required"], "REVIEW_REQUIRED")
                require(self.state["active_job"] is None, "ROBOT_BUSY")
                boundary = self.state["boundary"]
                require(boundary < len(ACTIONS) and action == ACTIONS[boundary], "ACTION_NOT_AVAILABLE")
                bed = BEDS[boundary//2] if boundary < 6 else None
                observation = request.get("observation_id")
                if action == "harvest":
                    before = self.frame(observation)[0]
                    require(before["bed"] == bed and before["revision"] == self.state["revision"]
                            and before["elapsed"] == self.state["elapsed"], "EVIDENCE_MISMATCH")
                    require(0 <= int(time.time()*1000)-before["captured_at_ms"] <= 60000, "STALE_EVIDENCE")
                    require(before["analysis"]["target_visible"], "TARGET_NOT_OBSERVED")
                    require(self.db.execute("SELECT count(*) FROM frames").fetchone()[0] < 255, "STORAGE_LIMIT")
                job = {"command_id": command_id, "action": action, "bed": bed, "stage": "running",
                    "run_id": self.state["run_id"],
                    "observation_id": observation, "target_elapsed": BOUNDARIES[boundary+1],
                    "accepted_at_ms": int(time.time()*1000), "simulated": True}
                self.db.execute("INSERT INTO jobs VALUES(?,?)", (command_id, json.dumps(job)))
                self.state["active_job"], self.state["paused"] = command_id, False
            self.last = self.clock()
            self.state["revision"] += 1
            receipt = {"command_id": command_id, "accepted": True, "revision": self.state["revision"],
                       "action": action, "active_job": self.state["active_job"], "simulated": True}
            self.db.execute("INSERT INTO commands VALUES(?,?,?)", (command_id, serialized, json.dumps(receipt)))
            self.save()
            return receipt

    def close(self) -> None:
        """Stop the clock and checkpoint before releasing exclusive state ownership."""
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=10)
        if self.db:
            self.db.close()
        self.lease.release()
