import assert from 'node:assert/strict';
import { importForm } from '../src/lib/form.ts';
import { appendAssets, emptyWorkspace, evaluateWorkspace, hydrateManifest, makeManifest, readManifest, writeKeyframe, zeroPose } from '../src/lib/workspace.ts';
import { applyWorldPoses, createWorld } from '../src/lib/world.ts';
import { compareSceneRevisions } from '../src/lib/scene-history.ts';
import type { SavedScene } from '../src/lib/scene-repository.ts';

const source = { hardware_ir_version: '0.2', overview: { title: 'Animated machine' }, mechanical: { render_dimensions: { x_mm: 1000, y_mm: 1000, z_mm: 1000 } } };
const asset = importForm(source, 'machine.json', 'machine-digest');
const original = JSON.stringify({ source, asset });
let workspace = appendAssets(emptyWorkspace(), [asset, asset]);
const [a, b] = workspace.items;
b.visible = false;
workspace.animation = writeKeyframe(workspace.animation, a.id, undefined, { ...zeroPose(), id: 'start', time: 0 });
workspace.animation = writeKeyframe(workspace.animation, a.id, undefined, { ...zeroPose(), id: 'hide', time: 1, visible: false });
workspace.animation = writeKeyframe(workspace.animation, a.id, undefined, { ...zeroPose(), id: 'move', time: 1.5, position: [1, 0, 0] });
workspace.animation = writeKeyframe(workspace.animation, a.id, undefined, { ...zeroPose(), id: 'show', time: 2, visible: true });
workspace.animation = writeKeyframe(workspace.animation, b.id, undefined, { ...zeroPose(), id: 'show-b', time: .5, visible: true });
workspace.animation = writeKeyframe(workspace.animation, b.id, undefined, { ...zeroPose(), id: 'hide-b', time: 2.5, visible: false });
// Input order must not affect held visibility or continuous pose interpolation.
workspace.animation.tracks[0].keys.reverse();
for (const [time, visible] of [[0, [true, false]], [.5, [true, true]], [.999, [true, true]], [1, [false, true]], [1.5, [false, true]], [1.999, [false, true]], [2, [true, true]], [3, [true, false]]] as const) {
  assert.deepEqual(evaluateWorkspace(workspace.items, workspace.animation, time).map(p => p.visible), visible);
}
assert.equal(evaluateWorkspace(workspace.items, workspace.animation, 1.25)[0].position[0], .5);
assert.deepEqual(evaluateWorkspace(workspace.items, workspace.animation, null).map(p => p.visible), [true, false]);
assert.deepEqual(evaluateWorkspace(workspace.items, { ...workspace.animation, tracks: [] }, 2).map(p => p.visible), [true, false]);
const legacy = structuredClone(workspace.animation);
legacy.tracks.forEach(track => track.keys.forEach(key => { delete key.visible; }));
assert.deepEqual(evaluateWorkspace(workspace.items, legacy, 2).map(p => p.visible), [true, false]);
// Replacing a key replaces visibility without accumulating duplicate times.
const edited = writeKeyframe(workspace.animation, a.id, undefined, { ...zeroPose(), id: 'replacement', time: 1, visible: true });
assert.equal(edited.tracks.find(t => t.instanceId === a.id)!.keys.length, 4);
assert.equal(evaluateWorkspace(workspace.items, edited, 1.5)[0].visible, true);
assert.equal(evaluateWorkspace(workspace.items, workspace.animation, 1.5)[0].visible, false);
const world = createWorld(workspace.items.map(i => i.asset), workspace.room);
try {
  applyWorldPoses(world.groups, evaluateWorkspace(workspace.items, workspace.animation, 1));
  assert.deepEqual(world.groups.map(g => g.visible), [false, true]);
  applyWorldPoses(world.groups, evaluateWorkspace(workspace.items, workspace.animation, null));
  assert.deepEqual(world.groups.map(g => g.visible), [true, false]);
} finally { world.dispose(); }
const manifest = makeManifest(workspace, true);
const restored = hydrateManifest(readManifest(JSON.parse(JSON.stringify(manifest))), []);
assert.deepEqual(restored.animation, JSON.parse(JSON.stringify(workspace.animation)));
assert.deepEqual(evaluateWorkspace(restored.items, restored.animation, 1).map(p => p.visible), [false, true]);
const repaired = appendAssets(hydrateManifest(readManifest(makeManifest(workspace)), []), [asset]);
assert.deepEqual(repaired.animation, makeManifest(workspace).animation);
assert.deepEqual(repaired.items.map(i => i.id), workspace.items.map(i => i.id));
for (const value of [null, 0, 'false']) {
  const invalid = structuredClone(manifest);
  (invalid.animation.tracks[0].keys[0] as any).visible = value;
  assert.throws(() => readManifest(invalid), /visibility/);
}
const part = structuredClone(manifest);
part.animation.tracks[0].partId = asset.parts[0].id;
part.animation.tracks[0].id = `${a.id}:${asset.parts[0].id}`;
assert.throws(() => readManifest(part), /whole-instance/);
const after = makeManifest({ ...workspace, animation: edited });
const comparison = compareSceneRevisions({ name: 'Room', revision: 1, document: manifest } as SavedScene, { name: 'Room', revision: 2, document: after } as SavedScene);
assert(comparison.changes.some(c => c.field === 'Visible at 1s' && c.before === 'false' && c.after === 'true'));
assert.equal(JSON.stringify({ source, asset }), original);
console.log('PASS visibility boundaries, independent instances, legacy tracks, interpolation, world poses, portable/repair round trips, validation, history and immutable sources.');
