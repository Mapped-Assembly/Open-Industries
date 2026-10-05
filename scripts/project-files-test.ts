import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importForm, readFormDocument } from '../src/lib/form.ts';
import { appendAssets, emptyWorkspace, hydrateManifest, readManifest, writeKeyframe } from '../src/lib/workspace.ts';
import { formaProjectJSON, oiProjectJSON, projectFilename } from '../src/lib/project-files.ts';
import { generationArgs, projectForClient } from '../server/form.mjs';
import { getFormHealth, generateFormProject } from '../src/lib/form-generation.ts';

for (const path of ['sdk/project-ir.json', 'codex/project-object.json', 'codex/forma-project.json']) {
  const input = JSON.parse(await readFile(`scripts/fixtures/form-workflows/${path}`, 'utf8'));
  const asset = importForm(input, 'forma-project.json', 'a'.repeat(64));
  const original = JSON.stringify(asset);
  const exported = JSON.parse(formaProjectJSON(asset));
  const reopened = readFormDocument(exported, 'equipment.forma.json');
  assert.equal(reopened.projectId, asset.formProject!.projectId);
  assert.equal(reopened.project.revision, asset.formProject!.revision);
  assert.equal(reopened.project.agent, asset.formProject!.agent);
  assert.deepEqual(reopened.project.ir.bom, asset.formProject!.ir.bom);
  assert.deepEqual(reopened.project.ir.mechanical, asset.formProject!.ir.mechanical);
  assert.deepEqual(reopened.project.ir.validation, asset.formProject!.ir.validation);
  assert.deepEqual(reopened.project.ir.cad_model, asset.formProject!.ir.cad_model);
  let workspace = appendAssets(emptyWorkspace(), [asset]);
  workspace = { ...workspace, room: [9, 7, 4], items: [
    { ...workspace.items[0], position: [1, 2, 3], rotation: [0, 45, 0] },
    { ...workspace.items[0], id: crypto.randomUUID(), name: 'Duplicate', visible: false },
  ] };
  workspace.animation = writeKeyframe(workspace.animation, workspace.items[0].id, undefined, { id: crypto.randomUUID(), time: 1, position: [2, 3, 4], rotation: [0, 90, 0], visible: false });
  const manifest = readManifest(JSON.parse(oiProjectJSON(workspace)));
  assert.equal(manifest.assets.length, 1);
  const fresh = hydrateManifest(manifest, []);
  assert.deepEqual(fresh.room, workspace.room);
  assert.deepEqual(fresh.animation, JSON.parse(JSON.stringify(workspace.animation)));
  assert.equal(JSON.stringify(fresh.items.map(({ id, name, position, rotation, visible, asset }) => ({ id, name, position, rotation, visible, asset }))), JSON.stringify(workspace.items.map(({ id, name, position, rotation, visible, asset }) => ({ id, name, position, rotation, visible, asset }))));
  assert.equal(JSON.stringify(asset), original);
}
assert.equal(readManifest(JSON.parse(oiProjectJSON(emptyWorkspace()))).instances.length, 0);
assert.equal(projectFilename('../../Lab / robot:*?', 'oi'), 'Lab-robot.oi.json');
assert.throws(() => formaProjectJSON({} as never), /Select a Forma/);
const portable = projectForClient({ hardware_ir_version: '0.2', provider: 'private-provider', runtime_config: { api_key: 'secret' }, bom: [{ name: 'Motor', quantity: 2 }] });
assert.doesNotMatch(JSON.stringify(portable), /private-provider|secret|runtime_config/);
assert.deepEqual(portable.project_ir.bom, [{ name: 'Motor', quantity: 2 }]);
assert.throws(() => generationArgs({ prompt: 'x', mode: 'live', provider: ' --simulation', model: 'x' }, 'p.json'));
const live = { prompt: 'A robot', mode: 'live' as const, provider: 'openai', model: 'example-model' };
assert.deepEqual(generationArgs(live, 'p.json'), ['-m', 'forma_core', 'generate', 'A robot', '--output', 'p.json', '--provider', 'openai', '--model', 'example-model']);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response('<html>Static host</html>');
  await assert.rejects(getFormHealth(), /unavailable on this deployment/);
  globalThis.fetch = async () => Response.json({ available: false, message: 'Install Forma' });
  assert.equal((await getFormHealth()).available, false);
  globalThis.fetch = async () => Response.json({ error: 'Already running' }, { status: 409 });
  await assert.rejects(generateFormProject(live, () => {}, () => true), /Already running/);
  globalThis.fetch = async () => Response.json({ id: '../unsafe' });
  await assert.rejects(generateFormProject(live, () => {}, () => true), /generation ID/);
  let calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1 ? { id: 'generation-id' } : { status: 'failed', message: 'Provider unavailable' });
  await assert.rejects(generateFormProject(live, () => {}, () => true), /Provider unavailable/);
  calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1 ? { id: 'generation-id' } : { status: 'unexpected' });
  await assert.rejects(generateFormProject(live, () => {}, () => true), /unknown generation status/);
  calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1 ? { id: 'generation-id' } : { status: 'succeeded' });
  await assert.rejects(generateFormProject(live, () => {}, () => true), /without a usable project/);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS Forma and OI round trips, design retention, credential removal, API failure recovery and live argument forwarding.');
