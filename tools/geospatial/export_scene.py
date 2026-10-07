"""Export bounded, static OI scenes as georeferenced 3D Tiles 1.1.

Only Python's standard library is required. This is a small indexed-mesh GLB
adapter, not a CAD tessellator or scalable tiling engine. Existing OI geometry
is already normalized; originOffset is provenance, not a second translation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

Json = dict[str, Any]
Vec3 = tuple[float, float, float]
Matrix = list[list[float]]
MAX_BYTES = 75 * 1024 * 1024
C: Matrix = [[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]]
CI: Matrix = [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]]


def identity() -> Matrix:
    """Return a row-major identity matrix for internal computation."""
    return [[float(i == j) for j in range(4)] for i in range(4)]


def multiply(a: Matrix, b: Matrix) -> Matrix:
    """Multiply row-major matrices; serialization is column-major."""
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def transform(matrix: Matrix, point: Vec3) -> Vec3:
    """Transform a point with an affine matrix."""
    return tuple(sum(matrix[i][j] * point[j] for j in range(3)) + matrix[i][3] for i in range(3))


def columns(matrix: Matrix) -> list[float]:
    """Serialize an internal matrix using the glTF/3D Tiles column convention."""
    return [matrix[i][j] for j in range(4) for i in range(4)]


def pose_matrix(position: Vec3, rotation: Vec3) -> Matrix:
    """Match Three.js Euler XYZ in degrees: translation times Rx times Ry times Rz."""
    x, y, z = (math.radians(v) for v in rotation)
    rx = [[1, 0, 0, 0], [0, math.cos(x), -math.sin(x), 0], [0, math.sin(x), math.cos(x), 0], [0, 0, 0, 1]]
    ry = [[math.cos(y), 0, math.sin(y), 0], [0, 1, 0, 0], [-math.sin(y), 0, math.cos(y), 0], [0, 0, 0, 1]]
    rz = [[math.cos(z), -math.sin(z), 0, 0], [math.sin(z), math.cos(z), 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
    result = multiply(multiply(rx, ry), rz)
    for i in range(3):
        result[i][3] = position[i]
    return result


def finite(value: Any, label: str) -> float:
    """Require a finite numeric value without accepting booleans."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{label} must be a finite number")
    return float(value)


def vector(value: Any, label: str) -> Vec3:
    """Validate a bounded three-component vector."""
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{label} must have three components")
    result = tuple(finite(v, label) for v in value)
    if any(abs(v) > 1e6 for v in result):
        raise ValueError(f"{label} exceeds the supported local coordinate range")
    return result


def text_id(value: Any, label: str) -> str:
    """Require an identifier or name of bounded length."""
    if not isinstance(value, str) or not 0 < len(value) <= 512:
        raise ValueError(f"{label} must be a nonempty string of at most 512 characters")
    return value


@dataclass(frozen=True)
class Anchor:
    """WGS84 demonstration origin; heading is clockwise from true north."""

    longitude: float
    latitude: float
    height: float
    heading: float

    def __post_init__(self) -> None:
        """Reject invalid geographic anchors before generating artifacts."""
        for key in ("longitude", "latitude", "height", "heading"):
            finite(getattr(self, key), key)
        if not -180 <= self.longitude <= 180 or not -90 <= self.latitude <= 90:
            raise ValueError("longitude/latitude must be within WGS84 geographic bounds")
        if not -1000 <= self.height <= 100000 or not 0 <= self.heading < 360:
            raise ValueError("height must be -1000..100000 m and heading 0..<360 degrees")

    def matrix(self) -> Matrix:
        """Map heading-adjusted ENU to ECEF using the WGS84 ellipsoid."""
        lon, lat, heading = map(math.radians, (self.longitude, self.latitude, self.heading))
        a, e2 = 6378137.0, 6.6943799901413165e-3
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        origin = ((n + self.height) * math.cos(lat) * math.cos(lon),
                  (n + self.height) * math.cos(lat) * math.sin(lon),
                  (n * (1 - e2) + self.height) * math.sin(lat))
        east = (-math.sin(lon), math.cos(lon), 0.0)
        north = (-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat))
        up = (math.cos(lat) * math.cos(lon), math.cos(lat) * math.sin(lon), math.sin(lat))
        frame = identity()
        for i in range(3):
            frame[i][:3] = [east[i], north[i], up[i]]
            frame[i][3] = origin[i]
        rotation = identity()
        rotation[0][:2] = [math.cos(heading), math.sin(heading)]
        rotation[1][:2] = [-math.sin(heading), math.cos(heading)]
        return multiply(frame, rotation)


def write_json(path: Path, value: Any) -> None:
    """Write deterministic UTF-8 JSON with no nonstandard numeric values."""
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def digest(data: bytes) -> str:
    """Compute byte identity for input and output evidence."""
    return hashlib.sha256(data).hexdigest()


def bounds(points: list[Vec3]) -> list[float]:
    """Create a 3D Tiles axis-aligned box from already Z-up points."""
    if not points:
        raise ValueError("No visible geometry to export")
    lo = [min(p[i] for p in points) for i in range(3)]
    hi = [max(p[i] for p in points) for i in range(3)]
    half = [max((hi[i] - lo[i]) / 2, 1e-7) for i in range(3)]
    return [(hi[i] + lo[i]) / 2 for i in range(3)] + [half[0], 0, 0, 0, half[1], 0, 0, 0, half[2]]


def asset_points(asset: Json) -> list[Vec3]:
    """Return normalized Y-up points without reapplying source originOffset."""
    return [tuple(part["vertices"][i:i + 3]) for part in asset["parts"] for i in range(0, len(part["vertices"]), 3)]


def validate_scene(scene: Json) -> tuple[dict[str, Json], dict[str, Json]]:
    """Validate the supported static scene and exact source/version bindings.

    Animation is reported as excluded, never sampled or presented as physics.
    Missing geometry is rejected rather than replaced with an invented envelope.
    """
    if scene.get("format") != "astra.scene" or scene.get("version") != 1 or scene.get("units") != "m" or scene.get("upAxis") != "Y":
        raise ValueError("Only astra.scene v1 with meters/Y-up is supported")
    refs: dict[str, Json] = {}
    assets: dict[str, Json] = {}
    versions: dict[str, Json] = {}
    for ref in scene.get("assets", []):
        key = text_id(ref.get("id"), "asset.id")
        if key in refs:
            raise ValueError("Duplicate asset reference")
        refs[key] = ref
    for asset in scene.get("bundledAssets", []):
        key = text_id(asset.get("id"), "bundled asset.id")
        if key in assets:
            raise ValueError("Duplicate bundled asset")
        assets[key] = asset
    for entry in scene.get("bundledVersions", []):
        key = text_id(entry.get("cloudVersionId"), "cloudVersionId")
        if key in versions:
            raise ValueError("Duplicate cloud version")
        versions[key] = entry["asset"]
    instances = scene.get("instances")
    if not isinstance(instances, list) or not 1 <= len(instances) <= 1000:
        raise ValueError("A scene must have 1..1000 instances")
    ids: set[str] = set()
    bound: dict[str, Json] = {}
    for instance in instances:
        key = text_id(instance.get("id"), "instance.id")
        text_id(instance.get("name"), "instance.name")
        if key in ids:
            raise ValueError("Duplicate instance ID")
        ids.add(key)
        vector(instance.get("position"), "position")
        vector(instance.get("rotation"), "rotation")
        if not isinstance(instance.get("visible"), bool):
            raise ValueError("visible must be boolean")
        asset_id = instance.get("assetId")
        asset = versions.get(instance["cloudVersionId"]) if "cloudVersionId" in instance else assets.get(asset_id)
        ref = refs.get(asset_id)
        if not asset or not ref or asset.get("id") != asset_id:
            raise ValueError(f"Missing exact geometry binding for {key}")
        text_id(asset.get("name"), "asset.name")
        if asset.get("units") != "m" or asset.get("upAxis") != "Y" or asset.get("schemaVersion") != 1:
            raise ValueError("Asset must use schemaVersion 1, meters/Y-up")
        source = asset.get("source", {})
        if source.get("kind") not in ("form", "step", "generated"):
            raise ValueError("Invalid source kind")
        text_id(source.get("filename"), "source filename")
        text_id(source.get("digest"), "source digest")
        for field in ("kind", "digest", "version", "projectId"):
            if source.get(field) != ref.get("source", {}).get(field):
                raise ValueError(f"Source revision mismatch: {key}/{field}")
        project = asset.get("formProject") or {}
        if ref.get("projectRevision") is not None and ref["projectRevision"] != project.get("revision"):
            raise ValueError("Source project revision mismatch")
        if source.get("projectId") is not None and project.get("projectId") not in (None, source["projectId"]):
            raise ValueError("Source project ID mismatch")
        vector(asset.get("originOffset"), "originOffset")
        parts = asset.get("parts")
        if not isinstance(parts, list) or not parts:
            raise ValueError("Asset has no mesh parts")
        part_ids: set[str] = set()
        total = 0
        for part in parts:
            part_id = text_id(part.get("id"), "part.id")
            text_id(part.get("name"), "part.name")
            if part_id in part_ids:
                raise ValueError("Duplicate part ID")
            part_ids.add(part_id)
            vertices, indices = part.get("vertices"), part.get("indices")
            if not isinstance(vertices, list) or len(vertices) < 9 or len(vertices) % 3:
                raise ValueError("Invalid mesh vertices")
            for v in vertices:
                if abs(finite(v, "vertex")) > 1e6:
                    raise ValueError("Vertex exceeds local range")
            total += len(vertices) // 3
            if total > 2_000_000:
                raise ValueError("Asset exceeds 2 million vertices")
            if not isinstance(indices, list) or not indices or len(indices) % 3 or any(type(i) is not int or not 0 <= i < len(vertices) // 3 for i in indices):
                raise ValueError("Invalid triangle indices")
            color = vector(part.get("color", [0.7, 0.8, 0.75]), "part color")
            if any(not 0 <= c <= 1 for c in color):
                raise ValueError("Color must be linear RGB within 0..1")
        bound[key] = asset
    return bound, refs


class Glb:
    """Encode existing indexed OI meshes and bounded asset feature metadata."""

    def __init__(self) -> None:
        """Initialize aligned binary storage and a glTF 2.0 document."""
        self.binary = bytearray()
        self.doc: Json = {"asset": {"version": "2.0", "generator": "OI static geospatial adapter v1"},
                          "scene": 0, "scenes": [{"nodes": []}], "nodes": [], "meshes": [],
                          "materials": [], "accessors": [], "bufferViews": [],
                          "extensionsUsed": ["KHR_materials_unlit", "EXT_mesh_features", "EXT_structural_metadata"]}

    def view(self, data: bytes, target: int | None = None) -> int:
        """Append one four-byte-aligned glTF buffer view."""
        self.binary.extend(b"\0" * ((-len(self.binary)) % 4))
        item: Json = {"buffer": 0, "byteOffset": len(self.binary), "byteLength": len(data)}
        if target is not None:
            item["target"] = target
        self.binary.extend(data)
        self.doc["bufferViews"].append(item)
        return len(self.doc["bufferViews"]) - 1

    def accessor(self, values: list[Any], component: int, kind: str, target: int) -> int:
        """Encode validated positions or triangle indices as a glTF accessor."""
        data = struct.pack("<" + ("f" if component == 5126 else "I") * len(values), *values)
        count = len(values) // (3 if kind == "VEC3" else 1)
        item: Json = {"bufferView": self.view(data, target), "componentType": component, "count": count, "type": kind}
        if kind == "VEC3":
            item["min"] = [min(values[i::3]) for i in range(3)]
            item["max"] = [max(values[i::3]) for i in range(3)]
        self.doc["accessors"].append(item)
        return len(self.doc["accessors"]) - 1

    def encode(self, asset: Json) -> bytes:
        """Serialize a shared-asset GLB with explicit feature ID zero per vertex."""
        properties: Json = {}
        feature = {"assetId": asset["id"], "assetName": asset["name"], "sourceDigest": asset["source"]["digest"]}
        for key, value in feature.items():
            raw = value.encode("utf-8")
            properties[key] = {"values": self.view(raw), "stringOffsets": self.view(struct.pack("<II", 0, len(raw))), "stringOffsetType": "UINT32"}
        self.doc["extensions"] = {"EXT_structural_metadata": {
            "schema": {"id": "oi_asset_v1", "classes": {"equipment": {"properties": {key: {"type": "STRING"} for key in feature}}}},
            "propertyTables": [{"class": "equipment", "count": 1, "properties": properties}]}}
        for part in asset["parts"]:
            material = len(self.doc["materials"])
            self.doc["materials"].append({"pbrMetallicRoughness": {"baseColorFactor": part.get("color", [0.7, 0.8, 0.75]) + [1]},
                                          "doubleSided": True, "extensions": {"KHR_materials_unlit": {}}})
            primitive = {"attributes": {"POSITION": self.accessor(part["vertices"], 5126, "VEC3", 34962),
                                         "_FEATURE_ID_0": self.accessor([0.0] * (len(part["vertices"]) // 3), 5126, "SCALAR", 34962)},
                         "indices": self.accessor(part["indices"], 5125, "SCALAR", 34963), "material": material,
                         "extensions": {"EXT_mesh_features": {"featureIds": [{"featureCount": 1, "attribute": 0, "propertyTable": 0}]}}}
            mesh = len(self.doc["meshes"])
            self.doc["meshes"].append({"name": part["name"], "primitives": [primitive]})
            self.doc["scenes"][0]["nodes"].append(len(self.doc["nodes"]))
            self.doc["nodes"].append({"mesh": mesh, "name": part["name"], "extras": {"partId": part["id"]}})
        self.doc["buffers"] = [{"byteLength": len(self.binary)}]
        raw_json = json.dumps(self.doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        raw_json += b" " * ((-len(raw_json)) % 4)
        raw_bin = bytes(self.binary) + b"\0" * ((-len(self.binary)) % 4)
        length = 12 + 8 + len(raw_json) + 8 + len(raw_bin)
        return struct.pack("<III", 0x46546C67, 2, length) + struct.pack("<II", len(raw_json), 0x4E4F534A) + raw_json + struct.pack("<II", len(raw_bin), 0x004E4942) + raw_bin


def source_revision(path: Path) -> str | None:
    """Return the checkout revision if available; never invent an attribution."""
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=path.parent, text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def export_scene(source_path: Path, output: Path, anchor: Anchor, license_note: str) -> Json:
    """Export validated static geometry and an allowlisted provenance sidecar.

    Only selected source fields are copied; arbitrary Form source documents,
    provider configuration and credentials are never copied to outputs.
    """
    started = time.perf_counter()
    raw = source_path.read_bytes()
    if len(raw) > MAX_BYTES:
        raise ValueError("Scene exceeds the 75 MiB supported input limit")
    scene = json.loads(raw)
    bound, refs = validate_scene(scene)
    output.mkdir(parents=True, exist_ok=True)
    geometry = output / "geometry"
    geometry.mkdir(exist_ok=True)
    emitted: dict[str, str] = {}
    children: list[Json] = []
    instances: list[Json] = []
    all_points: list[Vec3] = []
    hidden: list[str] = []
    for instance in scene["instances"]:
        if not instance["visible"]:
            hidden.append(instance["id"])
            continue
        asset = bound[instance["id"]]
        # Exact geometry/provenance content identity permits shared immutable GLBs.
        encoded = Glb().encode(asset)
        content_hash = digest(encoded)
        filename = f"geometry/{content_hash}.glb"
        if content_hash not in emitted:
            (output / filename).write_bytes(encoded)
            emitted[content_hash] = filename
        pose = pose_matrix(vector(instance["position"], "position"), vector(instance["rotation"], "rotation"))
        # Content is GLB Y-up; runtimes apply C. Tile transforms are already Z-up.
        tile_pose = multiply(multiply(C, pose), CI)
        points = asset_points(asset)
        all_points.extend(transform(multiply(C, pose), p) for p in points)
        project = asset.get("formProject") or {}
        metadata = {"instanceId": instance["id"], "assetId": asset["id"], "name": instance["name"],
                    "sourceKind": asset["source"]["kind"], "sourceDigest": asset["source"]["digest"]}
        children.append({"boundingVolume": {"box": bounds([transform(C, p) for p in points])},
                         "transform": columns(tile_pose), "geometricError": 0,
                         "content": {"uri": filename}, "metadata": {"class": "equipment", "properties": metadata}})
        instances.append({**metadata, "contentUri": filename, "sourceFilename": asset["source"]["filename"],
                          "sourceVersion": asset["source"].get("version"),
                          "projectId": project.get("projectId", asset["source"].get("projectId")),
                          "projectRevision": project.get("revision", refs[asset["id"]].get("projectRevision")),
                          "cloudVersionId": instance.get("cloudVersionId"),
                          "sourceNormalizationOffset": asset["originOffset"],
                          "position": instance["position"], "rotationDegreesXYZ": instance["rotation"],
                          "partIds": [part["id"] for part in asset["parts"]]})
    root_box = bounds(all_points)
    schema = {"id": "oi_scene_v1", "classes": {"equipment": {"properties": {
        key: {"type": "STRING"} for key in ("instanceId", "assetId", "name", "sourceKind", "sourceDigest")}}}}
    # A nonzero empty-root error requests refinement to exact leaf content.
    root_error = max(root_box[3], root_box[7], root_box[11]) * 2
    tileset = {"asset": {"version": "1.1"}, "geometricError": root_error, "schema": schema,
               "root": {"boundingVolume": {"box": root_box}, "transform": columns(anchor.matrix()),
                        "geometricError": root_error, "refine": "ADD", "children": children},
               "extras": {"provenanceUri": "provenance.json", "evidence": "conceptual-static-scene"}}
    write_json(output / "tileset.json", tileset)
    write_json(output / "provenance.json", {
        "schema": "oi-geospatial-provenance/v1", "sourceSha256": digest(raw),
        "sourceRevision": source_revision(source_path), "sourceFilename": source_path.name,
        "anchor": vars(anchor), "placement": "demonstration anchor; not surveyed or deployed",
        "frame": "OI +X east, +Y up, -Z north at heading 0; clockwise heading from true north",
        "normalization": "Stored vertices are normalized. Stored instance position already locates the normalized origin. originOffset is retained only as provenance.",
        "licenseNote": license_note, "instances": instances,
        "excluded": {"hiddenInstances": hidden, "animationTracks": len(scene.get("animation", {}).get("tracks", [])),
                     "fields": ["BOM, compiler findings, arbitrary source documents", "room decoration, hierarchy grouping, textures, physics and animation"]},
        "capabilities": {"staticGeometry": "passed", "georeferencedPlacement": "passed",
                         "animation": "not-tested", "physicalValidation": "not-tested",
                         "licensePermission": "not-tested", "viewerInteroperability": "not-tested"}})
    files = sorted([output / "tileset.json", output / "provenance.json"] + [output / name for name in emitted.values()])
    report = {"schema": "oi-geospatial-export/v1", "inputSha256": digest(raw),
              "pythonVersion": sys.version, "instances": len(instances), "uniqueGlbs": len(emitted),
              "verticesPerInstanceTotal": len(all_points), "rootBox": root_box,
              "conversionSeconds": time.perf_counter() - started, "payloadBytes": sum(p.stat().st_size for p in files),
              "checksums": {p.relative_to(output).as_posix(): digest(p.read_bytes()) for p in files},
              "conformance": "not-tested; run npm run validate in tools/geospatial",
              "limitations": ["static base layout; no timeline sampling", "one small site; no LOD simplification", "conceptual geometry; no engineering certification"]}
    write_json(output / "export-report.json", report)
    return report


def main() -> int:
    """Run the CLI with an explicit geographic anchor and provenance statement."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--longitude", required=True, type=float)
    parser.add_argument("--latitude", required=True, type=float)
    parser.add_argument("--height", required=True, type=float, help="WGS84 ellipsoidal height in meters; not terrain height")
    parser.add_argument("--heading", required=True, type=float, help="Clockwise degrees from true north; 0 <= heading < 360")
    parser.add_argument("--license-note", required=True, help="Source license/permission evidence or explicit unresolved status; not a permission grant")
    args = parser.parse_args()
    try:
        result = export_scene(args.scene, args.output, Anchor(args.longitude, args.latitude, args.height, args.heading), args.license_note)
    except (ValueError, KeyError, TypeError, OSError) as exc:
        parser.exit(1, f"Export failed: {exc}\n")
    print(json.dumps({"instances": result["instances"], "uniqueGlbs": result["uniqueGlbs"], "payloadBytes": result["payloadBytes"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
