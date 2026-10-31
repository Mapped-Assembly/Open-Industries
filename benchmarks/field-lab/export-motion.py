"""Export a pinned OpenCAD pipette interaction and bounded mechanics evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

from opencad import evaluate_scene, serialize_scene, deserialize_scene
from opencad.scene import SceneDocument
from opencad.scene.collision import validate_scene_motion
from opencad.kinematics import compose_transforms

ROOT = Path(__file__).resolve().parents[2]
MOVING = ['gantry', 'head', 'pipette', 'tip', 'camera', 'camera-lens']
HEAD = MOVING[1:]


def pose(x: float, y: float) -> dict[str, Any]:
    """Convert OI Y-up meter translation into OpenCAD Z-up millimeters."""
    return {'translation_mm': [x * 1000, 0, y * 1000]}


def digest(path: Path) -> str:
    """Hash UTF-8 source with normalized newlines; edits require a fresh export."""
    return hashlib.sha256(path.read_bytes().replace(b'\r\n', b'\n')).hexdigest()


def travel_valid(document: SceneDocument) -> bool:
    """Check declared prismatic travel at 0.25-second evaluated samples."""
    for tick in range(97):
        state = evaluate_scene(document, tick / 4)
        for name in MOVING:
            x, _, z = state.component_transforms['pipette'][name].translation_mm
            if not (-270 - 1e-8 <= x <= 290 + 1e-8 and -90 - 1e-8 <= z <= 1e-8):
                return False
    return True


def aligned(document: SceneDocument, time_s: float, port: str) -> bool:
    """Compare the evaluated tip interface to a declared task reference, in mm."""
    state = evaluate_scene(document, time_s)
    tip = compose_transforms(state.component_transforms['pipette']['tip'],
                             document.entities['pipette'].interfaces['tip-port'].transform)
    target = document.entities['target'].interfaces[port].transform
    return sum((a-b)**2 for a,b in zip(tip.translation_mm, target.translation_mm))**.5 <= 1


def export(source: Path, output: Path) -> None:
    """Evaluate the existing OpenCAD interaction API and export its transforms/checks."""
    scene_path = ROOT / 'benchmarks/field-lab/fixtures/field-lab.oi.json'
    scene = json.loads(scene_path.read_text())
    occurrence = next(i for i in scene['instances'] if i['id'] == 'pipette')
    asset = next(a for a in scene['bundledAssets'] if a['id'] == occurrence['assetId'])
    parts = {p['name']: p for p in asset['parts']}
    components = {name: {'id': name, 'name': name, 'geometry_refs': [parts[name]['id']],
                         'transform': pose(-.27 if name in MOVING else 0, 0)}
                  for name in parts}
    # Individual AABBs of selected real source meshes; the fused frame/rack arrays
    # are intentionally unchecked rather than treated as solid bounding boxes.
    covered = MOVING + ['base', 'rack', 'plate']
    colliders = []
    for name in covered:
        vertices = parts[name]['vertices']
        low = [min(vertices[i::3]) for i in range(3)]
        high = [max(vertices[i::3]) for i in range(3)]
        center = [(a + b) / 2 for a, b in zip(low, high)]
        size = [(b - a) * 1000 for a, b in zip(low, high)]
        colliders.append({'id': name + '-box', 'component_id': name,
                          'size_mm': [size[0], size[2], size[1]],
                          'transform': {'translation_mm': [center[0]*1000, -center[2]*1000, center[1]*1000]}})
    stages = [('lower-source', -.27, -.09), ('raise-source', -.27, 0),
              ('transfer', .29, 0), ('lower-target', .29, -.09),
              ('raise-target', .29, 0), ('return', -.27, 0)]
    interactions = [{'id': name, 'actor_id': 'pipette', 'target_id': 'target',
                     'interaction_type': 'MOVE', 'duration_s': 4,
                     'component_poses': {p: pose(x, y if p in HEAD else 0) for p in MOVING}}
                    for name, x, y in stages]
    raw = {'id': 'field-lab-pipette-transfer-v1', 'name': 'Pipette transfer',
           'entities': {'pipette': {'id': 'pipette', 'name': 'Pipette',
                        'assembly': {'id': 'pipette-assembly', 'name': 'Pipette',
                                     'root_ids': list(components), 'components': components},
                        'interfaces': {'tip-port': {'id': 'tip-port', 'component_id': 'tip',
                                                   'transform': {'translation_mm': [0, -30, 292]}}},
                        'colliders': colliders},
                        'target': {'id': 'target', 'name': 'Assay target reference',
                                   'assembly': {'id': 'target', 'name': 'Target', 'root_ids': ['target'],
                                                'components': {'target': {'id': 'target', 'name': 'Target'}}},
                                   'interfaces': {name: {'id': name, 'component_id': 'target', 'transform': {'translation_mm': [x, -30, 202]}} for name, x in [('source-port', -270), ('destination-port', 290)]}}},
           'interactions': interactions,
           'collision_exclusions': [[a+'-box', b+'-box'] for a, b in [('gantry', 'head'), ('head', 'pipette'), ('pipette', 'tip'), ('camera', 'camera-lens'), ('base', 'rack'), ('base', 'plate')]]}
    document = SceneDocument.model_validate(raw)
    restored = deserialize_scene(serialize_scene(document))
    samples = []
    for tick in range(97):
        time = tick / 4
        state = evaluate_scene(document, time)
        assert state == evaluate_scene(restored, time)
        offsets = {}
        for name in MOVING:
            x, z, y = state.component_transforms['pipette'][name].translation_mm
            assert -270 - 1e-8 <= x <= 290 + 1e-8 and -90 - 1e-8 <= y <= 1e-8
            offsets[parts[name]['id']] = [x/1000, y/1000, -z/1000]
        samples.append({'time_s': time, 'offsets_m': offsets})
    clear = validate_scene_motion(document).model_dump()
    assert clear['status'] in ('clear', 'unchecked'), clear
    blocked = document.model_dump()
    blocked['entities']['target']['assembly']['components']['target']['geometry_refs'] = ['obstruction']
    blocked['entities']['target']['colliders'] = [{'id': 'obstruction', 'component_id': 'target',
        'size_mm': [80, 80, 160], 'transform': {'translation_mm': [0, -30, 320]}}]
    blocked_check = validate_scene_motion(SceneDocument.model_validate(blocked)).model_dump()
    assert blocked_check['status'] == 'collision', blocked_check
    assert travel_valid(document)
    overtravel = document.model_dump()
    overtravel['interactions'][2]['component_poses']['head']['translation_mm'] = [400, 0, 0]
    assert not travel_valid(SceneDocument.model_validate(overtravel))
    assert aligned(document, 4, 'source-port') and aligned(document, 16, 'destination-port')
    misaligned = document.model_dump()
    misaligned['entities']['target']['interfaces']['destination-port']['transform']['translation_mm'] = [310, -30, 202]
    assert not aligned(SceneDocument.model_validate(misaligned), 16, 'destination-port')
    result = {'schema': 'oi.opencad-motion/v1', 'occurrence_id': 'pipette',
              'source_scene_sha256': digest(scene_path),
              'source_form_sha256': digest(scene_path.with_name('field-lab-pipette.form.json')),
              'opencad_revision': subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(),
              'exporter_sha256': digest(Path(__file__)),
              'frames': {'source': 'right-handed Z-up mm', 'target': 'right-handed Y-up m', 'mapping': '[x,z,-y]/1000', 'rotation': 'translation-only'},
              'duration_s': 24, 'joint_ids': ['pipette/x', 'pipette/z'],
              'interface_id': 'pipette/tip-port', 'target_interfaces': ['target/source-port', 'target/destination-port'], 'component_ids': {p: parts[p]['id'] for p in MOVING},
              'document': document.model_dump(), 'samples': samples,
              'checks': {'motion': clear, 'blocked_path': blocked_check, 'travel': {'status': 'passed', 'x_mm': [-270, 290], 'z_mm': [-90, 0], 'negative_x_mm': 400},
                         'alignment': {'status': 'passed', 'tolerance_mm': 1, 'rejected_offset_mm': 20},
                         'roundtrip': 'passed', 'sample_interval_s': .25, 'collision_tolerance_mm': .001,
                         'collision_time_tolerance_s': .0001,
                         'intended_contact': {'pairs': raw['collision_exclusions'], 'reason': 'Rigid head attachments, gantry/carriage interface, and rack/plate base mounts; these pairs are not collision-validated.'},
                         'unsupported': ['Unchecked components listed by OpenCAD', 'mesh contact', 'liquid transfer', 'assay validity', 'cable/harness feasibility', 'hardware certification'],
                         'scope': 'OpenCAD conservative interval checks over selected source-mesh box proxies; sampled travel/alignment checks. Not whole-machine or hardware certification.'}}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result['checks'], indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--opencad-source', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=ROOT / 'benchmarks/field-lab/fixtures/pipette-motion.json')
    args = parser.parse_args()
    export(args.opencad_source, args.output)
