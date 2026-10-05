import assert from 'node:assert/strict';
import { migratePositions, validateScene, type MergenceScene } from '../src/lib/scene-manifest';
import type { Asset } from '../src/lib/scene';

const asset = { id: 'form-project', name: 'Workbench' } as Asset;
const scene = migratePositions([asset], [6, 5, 3], [[1, 2, 3]], 'scene-test');
assert.equal(scene.instances[0].id, 'form-project/instance/0');
assert.deepEqual(scene.instances[0].rotation, [0, 0, 0]);
assert.equal(validateScene(scene).length, 0);

const invalid: MergenceScene = { ...scene, instances: [{ ...scene.instances[0], id: 'duplicate' }, { ...scene.instances[0], id: 'duplicate' }] };
assert.match(validateScene(invalid).join(' '), /Duplicate scene instance ID/);
const animated: MergenceScene = { ...scene, animation: { durationSeconds: 2, fps: 10, tracks: [{ instanceId: scene.instances[0].id, keyframes: [{ timeSeconds: 0, position: [0, 0, 0] }, { timeSeconds: 2, position: [1, 0, 0] }] }] } };
assert.equal(validateScene(animated).length, 0);
console.log('PASS Mergence scene manifest migration and validation');
