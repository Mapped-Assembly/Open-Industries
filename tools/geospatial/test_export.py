"""Independent contract checks for static geometry and geographic interchange."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from export_scene import Anchor, C, export_scene, pose_matrix, transform, validate_scene

ROOT = Path(__file__).resolve().parents[2]
FIELD = ROOT / "benchmarks/field-lab/fixtures/field-lab.oi.json"


def sample_scene() -> dict[str, Any]:
    """Build an asymmetric shared-asset fixture independent of FIELD-LAB."""
    asset = {"schemaVersion": 1, "id": "equipment", "name": "Asymmetric test shape",
             "units": "m", "upAxis": "Y", "originOffset": [100, 200, 300],
             "source": {"kind": "generated", "filename": "test", "digest": "test-digest"},
             "parts": [{"id": "body", "name": "body", "vertices": [0, 0, 0, 2, 0, 0, 0, 3, 1],
                        "indices": [0, 1, 2], "color": [1, 0, 0]}]}
    return {"format": "astra.scene", "version": 1, "units": "m", "upAxis": "Y",
            "assets": [{"id": "equipment", "source": asset["source"], "dimensions": [2, 3, 1]}],
            "bundledAssets": [asset], "animation": {"tracks": []},
            "instances": [{"id": "first", "name": "first", "assetId": "equipment", "position": [5, 6, 7], "rotation": [0, 0, 0], "visible": True},
                          {"id": "second", "name": "second", "assetId": "equipment", "position": [-2, 0, 1], "rotation": [0, 90, 0], "visible": True}]}


class ExportTests(unittest.TestCase):
    """Check errors, coordinate conventions, exact bindings and deterministic bytes."""

    def test_geographic_origin_and_heading(self) -> None:
        """Equatorial analytic references test ECEF axes and clockwise heading."""
        origin = Anchor(0, 0, 10, 0).matrix()
        self.assertEqual(transform(origin, (0, 0, 0)), (6378147.0, 0.0, 0.0))
        self.assertEqual(transform(origin, (2, 3, 4)), (6378151.0, 2.0, 3.0))
        heading = Anchor(0, 0, 0, 90).matrix()
        point = transform(heading, (2, 3, 4))
        for actual, expected in zip(point, (6378141.0, 3.0, -2.0)):
            self.assertAlmostEqual(actual, expected, places=8)
        # A second analytic location: at lon=90 on the equator, east is -X.
        point = transform(Anchor(90, 0, 0, 0).matrix(), (2, 3, 4))
        for actual, expected in zip(point, (-2.0, 6378141.0, 3.0)):
            self.assertAlmostEqual(actual, expected, places=8)

    def test_anchors_reject_invalid_data(self) -> None:
        """Missing CLI anchors and invalid geographic values cannot silently default."""
        for values in ((181, 0, 0, 0), (0, -91, 0, 0), (0, 0, float("nan"), 0), (0, 0, 0, 360)):
            with self.assertRaises(ValueError):
                Anchor(*values)

    def test_euler_xyz(self) -> None:
        """Test simultaneous Euler rotations against an independent analytic result."""
        point = transform(pose_matrix((0, 0, 0), (90, 90, 90)), (1, 2, 3))
        for actual, expected in zip(point, (3, -2, 1)):
            self.assertAlmostEqual(actual, expected)

    def test_scale_axis_and_indices_rejected(self) -> None:
        """Deliberate malformed-unit/axis/geometry cases fail instead of guessing."""
        for field, value in (("units", "mm"), ("upAxis", "Z")):
            scene = sample_scene()
            scene[field] = value
            with self.assertRaises(ValueError):
                validate_scene(scene)
        scene = sample_scene()
        scene["bundledAssets"][0]["parts"][0]["indices"][0] = 9
        with self.assertRaises(ValueError):
            validate_scene(scene)

    def test_missing_geometry_and_source_mismatch(self) -> None:
        """Identity alone cannot substitute for exact source/revision binding."""
        scene = sample_scene()
        scene["bundledAssets"] = []
        with self.assertRaises(ValueError):
            validate_scene(scene)
        scene = sample_scene()
        scene["assets"][0]["source"] = {**scene["assets"][0]["source"], "digest": "different"}
        with self.assertRaises(ValueError):
            validate_scene(scene)
        scene = sample_scene()
        scene["instances"][0]["cloudVersionId"] = "missing-version"
        with self.assertRaises(ValueError):
            validate_scene(scene)

    def test_export_shared_asset_and_bounds(self) -> None:
        """Check sharing, serialized transforms, extents and no double origin offset."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "scene.json"
            source.write_text(json.dumps(sample_scene()), encoding="utf-8")
            report = export_scene(source, root / "out", Anchor(0, 0, 0, 0), "test")
            self.assertEqual((report["instances"], report["uniqueGlbs"]), (2, 1))
            tileset = json.loads((root / "out/tileset.json").read_text())
            first, second = tileset["root"]["children"]
            self.assertEqual(first["content"]["uri"], second["content"]["uri"])
            self.assertEqual(first["transform"][12:15], [5, -7, 6])
            self.assertEqual(first["metadata"]["properties"]["instanceId"], "first")
            for instance, tile in zip(sample_scene()["instances"], tileset["root"]["children"]):
                matrix = [[tile["transform"][j * 4 + i] for j in range(4)] for i in range(4)]
                local = transform(C, (2, 0, 0))
                output = transform(matrix, local)
                expected = (7, -7, 6) if instance["id"] == "first" else (-2, 1, 0)
                for actual, wanted in zip(output, expected):
                    self.assertAlmostEqual(actual, wanted)
            provenance = json.loads((root / "out/provenance.json").read_text())
            self.assertEqual(provenance["instances"][0]["sourceNormalizationOffset"], [100, 200, 300])

    def test_secrets_not_exported_and_determinism(self) -> None:
        """Outputs are allowlisted and stable despite runtime configuration input."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scene = sample_scene()
            scene["bundledAssets"][0]["formProject"] = {"ir": {"api_key": "DO-NOT-EXPORT", "runtime_config": {"provider": "private"}}}
            source = root / "scene.json"
            source.write_text(json.dumps(scene), encoding="utf-8")
            a = export_scene(source, root / "a", Anchor(0, 0, 0, 0), "test")
            b = export_scene(source, root / "b", Anchor(0, 0, 0, 0), "test")
            self.assertEqual(a["checksums"], b["checksums"])
            for path in (root / "a").rglob("*"):
                if path.is_file():
                    self.assertNotIn(b"DO-NOT-EXPORT", path.read_bytes())

    def test_field_lab_fixture(self) -> None:
        """The merged real fixture exports with expected count and bounded payload."""
        with tempfile.TemporaryDirectory() as directory:
            report = export_scene(FIELD, Path(directory), Anchor(-73.977, 40.684, 30, 0), "unresolved")
            self.assertEqual(report["instances"], 21)
            self.assertLess(report["payloadBytes"], 1_000_000)


if __name__ == "__main__":
    unittest.main()
