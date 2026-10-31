"""Pinned SO-101 forward/inverse kinematics and bounded approach trajectories."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

Json = dict[str, Any]


class RobotModel:
    """Consume the verified source joint/TCP contract without inventing physical ratings."""

    def __init__(self, fixture: Path) -> None:
        """Load immutable model definitions and preserve their exact source transforms."""
        raw = (fixture / 'robot-contract.json').read_bytes()
        self.sha = hashlib.sha256(raw).hexdigest()
        self.contract: Json = json.loads(raw)
        if self.contract['schema_version'] != 1 or hashlib.sha256((fixture / 'source-lock.json').read_bytes()).hexdigest() != self.contract['source_lock_sha256']:
            raise ValueError('MODEL_CONTRACT_PIN_MISMATCH')
        self.names = ['shoulder_pan', 'shoulder_lift', 'elbow_flex', 'wrist_flex', 'wrist_roll', 'gripper']
        self.home = np.array([self.contract['reference_pose_rad'][name] for name in self.names])
        self.lower = np.array([self.contract['joints'][name]['lower_rad'] for name in self.names])
        self.upper = np.array([self.contract['joints'][name]['upper_rad'] for name in self.names])

    def frames(self, q: list[float] | np.ndarray) -> dict[str, np.ndarray]:
        """Compose source Z-up metre/radian frames; the frontend alone changes basis."""
        values = dict(zip(self.names, q, strict=True))
        frames = {self.contract['root_link']: np.eye(4)}
        remaining = dict(self.contract['joints'])
        while remaining:
            count = len(remaining)
            for name, joint in list(remaining.items()):
                if joint['parent'] not in frames:
                    continue
                motion = np.eye(4)
                if joint['type'] == 'revolute':
                    motion[:3, :3] = Rotation.from_rotvec(np.array(joint['axis']) * values[name]).as_matrix()
                frames[joint['child']] = frames[joint['parent']] @ np.array(joint['origin_m']) @ motion
                del remaining[name]
            if len(remaining) == count:
                raise ValueError('INVALID_MODEL_CHAIN')
        return frames

    def tcp(self, q: list[float] | np.ndarray) -> np.ndarray:
        """Return the declared TCP translation, without substituting a gripper midpoint."""
        tcp = self.contract['tcp']
        return (self.frames(q)[tcp['parent_link']] @ np.array(tcp['matrix_m']))[:3, 3]

    def approach(self, q: list[float], target: list[float]) -> list[float]:
        """Solve position-only IK 100 mm above a selected block, or reject unreachable goals.

        This kinematic prototype does not implement grasp/contact physics or certify
        collision clearance. Neither object pose nor success can be supplied by a model.
        """
        goal = np.array(target) + [0, 0, .1]
        if not np.all(np.isfinite(goal)) or np.linalg.norm(goal) > .48 or goal[2] < .06:
            raise ValueError('UNREACHABLE_TARGET')
        def residual(value: np.ndarray) -> np.ndarray:
            """Minimize TCP position error using only the five arm joints."""
            return self.tcp(np.append(value, q[-1])) - goal
        best = None
        for seed in (np.array(q[:5]), self.home[:5], (self.lower[:5] + self.upper[:5]) / 2):
            fit = least_squares(residual, np.clip(seed, self.lower[:5], self.upper[:5]),
                                bounds=(self.lower[:5], self.upper[:5]), max_nfev=100)
            if best is None or np.linalg.norm(fit.fun) < np.linalg.norm(best.fun):
                best = fit
        if best is None or np.linalg.norm(best.fun) > .003:
            raise ValueError('UNREACHABLE_TARGET')
        return np.append(best.x, q[-1]).tolist()

    def projection(self, q: list[float]) -> Json:
        """Expose authoritative transforms for display, not editable client keyframes."""
        return {'joints': dict(zip(self.names, q, strict=True)),
                'frames': {name: matrix.tolist() for name, matrix in self.frames(q).items()},
                'tcp_m': self.tcp(q).tolist(), 'model_sha256': self.sha,
                'evidence_kind': 'simulated_kinematics', 'collision_validated': False,
                'physical_validation': False}
