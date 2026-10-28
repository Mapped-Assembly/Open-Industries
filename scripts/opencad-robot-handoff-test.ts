/** Validate an actual OpenCAD robot asset against the OI persistence + scene stack.
 * Set OPENCAD_OI_ASSET_PATH for cross-repository integration with a real export.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCloudBundle } from '../src/lib/cloud-storage.ts';
import { LocalSceneBackend } from '../server/local-scene-backend.ts';
import { executeSceneTool } from '../server/mcp-scenes.ts';

const sha = '1'.repeat(64);
const fixture = {
  schemaVersion: 1,
  asset: {
    schemaVersion: 1,
    id: 'opencad-robot-' + '1'.repeat(24), name: 'robot_example',
    source: { kind: 'generated', generator: 'opencad-robot', filename: 'robot_example.urdf', digest: sha },
    units: 'm', upAxis: 'Y',
    parts: [
      { id: 'urdf:base:visual:0', name: 'base',
        vertices: [0,0,0,0.1,0,0,0,0.05,0], indices: [0,1,2],
        metadata: { representation: 'OpenCAD URDF visual; static neutral configuration',
          link_id: 'urdf:base', visual_id: 'urdf:base:visual:0',
          frame: 'OpenCAD Z-up/mm to OpenIndustries Y-up/m',
          kinematic_status: 'neutral_unvalidated', source_urdf_sha256: sha } },
      { id: 'urdf:tip:visual:0', name: 'tip',
        vertices: [0,0.1,0,0.01,0.1,0,0,0.12,0], indices: [0,1,2],
        metadata: { representation: 'OpenCAD URDF visual; static neutral configuration',
          link_id: 'urdf:tip', visual_id: 'urdf:tip:visual:0',
          frame: 'OpenCAD Z-up/mm to OpenIndustries Y-up/m',
          kinematic_status: 'neutral_unvalidated', source_urdf_sha256: sha } },
    ],
    hierarchy: { id: 'urdf:base', name: 'base', partIds: ['urdf:base:visual:0'],
      children: [{ id: 'urdf:tip', name: 'tip', partIds: ['urdf:tip:visual:0'], children: [] }] },
    dimensions: [0.1, 0.12, 0], originOffset: [0.05, 0, 0],
    warnings: [
      'Static neutral-position robot geometry only; OpenIndustries animation is not verified robot kinematics.',
      'Passive constraints, collision clearance, dynamics and hardware safety are NOT validated.',
    ],
  },
};
const testRoot = await mkdtemp(join(tmpdir(), 'oi-opencad-robot-'));
try {
  const sourcePath = process.env.OPENCAD_OI_ASSET_PATH;
  const input = sourcePath ? await readFile(sourcePath, 'utf8') : JSON.stringify(fixture);
  const original = JSON.parse(input);
  const asset = parseCloudBundle(input).asset;
  assert.equal(asset.source.kind, 'generated');
  assert.equal(asset.source.generator, 'opencad-robot');
  assert.equal(asset.units, 'm');
  assert.equal(asset.upAxis, 'Y');
  assert.match(asset.source.digest, /^[0-9a-f]{64}$/);
  assert(asset.parts.length >= 2);
  assert(asset.parts.every(p => p.metadata.kinematic_status === 'neutral_unvalidated'));
  assert(asset.warnings.some(w => w.includes('NOT validated') || w.includes('not verified')));
  assert.equal(new Set(asset.parts.map(p => p.id)).size, asset.parts.length);
  assert(asset.parts.every(p => p.metadata.visual_id === p.id));
  assert.deepEqual(original.asset.source, asset.source);
  const findNode = (node: typeof asset.hierarchy, id: string): boolean =>
    node.id === id || node.children.some(child => findNode(child, id));
  assert(findNode(asset.hierarchy, 'urdf:base'));
  assert(findNode(asset.hierarchy, 'urdf:tip'));

  const backend = new LocalSceneBackend(testRoot);
  try {
    const id = await backend.persistAsset(asset);
    assert.equal(await backend.persistAsset(asset), id);
    const version = await backend.asset(id);
    assert(version);
    assert.equal(version.asset?.source_kind, 'generated');
    const restored = parseCloudBundle(await backend.geometry(version)).asset;
    assert.deepEqual(restored.source, asset.source);
    assert.deepEqual(restored.hierarchy, asset.hierarchy);
    assert.deepEqual(restored.parts.map(p => p.id), asset.parts.map(p => p.id));

    const context = { backend, origin: 'http://localhost:5173', signal: AbortSignal.timeout(15000) };
    const inspect = await executeSceneTool('astra.inspect_scene_asset', {
      version: 1, asset: { kind: 'local', version_id: id },
    }, context);
    assert.equal((inspect as any).asset.provenance.generator, 'opencad-robot');
    assert.deepEqual((inspect as any).asset.parts.map((p: any) => p.id),
      asset.parts.map(p => p.id));

    const uuid = randomUUID();
    const saved = await executeSceneTool('astra.create_scene', {
      version: 1, request_id: uuid, agent: 'opencad-robot-contract',
      scene: { name: 'Robot layout (neutral geometry only)',
        room: { width: 5, depth: 5, height: 3 },
        instances: [{ id: 'robot-1', name: 'Robot (unvalidated neutral pose)',
          asset: { kind: 'local', version_id: id },
          position: [2, 0, 2], rotation: [0, 0, 0], visible: true }],
        animation: { duration: 3, loop: false, tracks: [] } },
    }, context);
    assert.equal(saved.revision_id, 1);
    const readBack = await executeSceneTool('astra.read_scene', {
      version: 1, scene_id: uuid,
    }, context);
    assert.equal((readBack as any).scene.instances[0].asset.version_id, id);
    assert.equal((readBack as any).scene.animation.tracks.length, 0);

    const wrong = structuredClone(original);
    wrong.asset.source.generator = 'made-up-generator';
    assert.throws(() => parseCloudBundle(JSON.stringify(wrong)),
      /Unsupported or incomplete cloud asset bundle/);
    console.log(sourcePath
      ? 'PASS: REAL OpenCAD robot asset -> OI typed asset -> local scene'
      : 'PASS: OpenCAD robot contract fixture -> OI typed asset -> local scene');
  } finally { backend.close(); }
} finally { await rm(testRoot, { recursive: true, force: true }); }
