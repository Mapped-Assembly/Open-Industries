import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import Ajv from 'ajv';
import { createClient } from '@supabase/supabase-js';
import { sceneTestService } from './lib/scene-test-service.ts';
import { hydrateManifest, readManifest, evaluateWorkspace } from '../src/lib/workspace.ts';
import { CloudStorage } from '../src/lib/cloud-storage.ts';
import { openSceneLink } from '../src/lib/scene-link-loader.ts';
import { readSceneLink } from '../src/lib/scene-links.ts';
import { importForm } from '../src/lib/form.ts';
import { executeSceneTool, workbenchOrigin } from '../server/mcp-scenes.ts';

const root = await mkdtemp(join(tmpdir(), 'astra-mcp-scenes-'));
const service = await sceneTestService();
const owner = randomUUID(), other = randomUUID();
const session = await service.account(owner), otherSession = await service.account(other);
const config = join(root, 'auth.json'); await writeFile(config, JSON.stringify(session));
const fixture = JSON.parse(await readFile('scripts/fixtures/cleanroom-scene-request.json', 'utf8'));
// Optional visibility must survive the real MCP schema, cloud save, and read/update cycle.
fixture.scene.animation.tracks[0].keys[0].visible = true;
fixture.scene.animation.tracks[0].keys.at(-1).visible = false;
const children: ReturnType<typeof spawn>[] = [];
function connection(env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [resolve('server/astra-mcp.mjs')], { env: { ...process.env, ASTRA_ROOT: root, ASTRA_CLI_CONFIG: config, ASTRA_SCENE_TOOLS_ENABLED: 'true', ASTRA_WORKBENCH_ORIGIN: 'http://localhost:5173', VITE_SUPABASE_URL: service.origin, VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child); let sequence = 0; let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const pending = new Map<number, (result: any) => void>();
  createInterface({ input: child.stdout! }).on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id); });
  const rpc = (method: string, params = {}): Promise<any> => new Promise((resolveResult, reject) => {
    const id = ++sequence; const timeout = setTimeout(() => reject(new Error(`MCP timeout: ${method}: ${stderr}`)), 15000);
    pending.set(id, value => { clearTimeout(timeout); value.error ? reject(new Error(value.error.message)) : resolveResult(value.result); });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { rpc, call: (name: string, args: unknown) => rpc('tools/call', { name: `astra.${name}`, arguments: args }) };
}
const mcp = connection();
const validators = new Map<string, any>();
async function ok(name: string, args: unknown, client = mcp) {
  const result = await client.call(name, args); assert(!result.isError, JSON.stringify(result));
  const data = result.structuredContent; const validate = validators.get(name);
  assert(validate(data), JSON.stringify(validate.errors)); assert.deepEqual(JSON.parse(result.content[0].text), data); return data;
}
async function bad(name: string, args: unknown, code: string, client = mcp) {
  const result = await client.call(name, args); assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.error.code, code, JSON.stringify(result)); return result.structuredContent.error;
}
const counts = async () => (await service.sql('select (select count(*) from scenes)::int scenes,(select count(*) from scene_revisions)::int revisions,(select count(*) from asset_file_versions)::int versions')).rows[0];
try {
  assert.equal((await mcp.rpc('initialize')).protocolVersion, '2025-06-18');
  const tools = (await mcp.rpc('tools/list')).tools; const ajv = new Ajv({ strict: false });
  for (const tool of tools.filter((tool: any) => tool.name.includes('scene'))) validators.set(tool.name.replace('astra.', ''), ajv.compile(tool.outputSchema));
  assert.equal(validators.size, 5);
  const disabled = connection({ ASTRA_SCENE_TOOLS_ENABLED: 'false' });
  await bad('list_scene_assets', { version: 1 }, 'DISABLED', disabled);
  assert(!(await disabled.call('create_room', { name: 'Offline', width: 6, depth: 5, height: 3 })).isError);
  const unauth = connection({ ASTRA_CLI_CONFIG: join(root, 'missing.json') });
  await bad('list_scene_assets', { version: 1 }, 'AUTH_REQUIRED', unauth);
  const serviceRole = connection({ VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_not-a-real-key' });
  await bad('list_scene_assets', { version: 1 }, 'AUTH_REQUIRED', serviceRole);
  const list = await ok('list_scene_assets', { version: 1 }); assert.equal(list.assets.length, 3);
  assert.equal(list.assets[0].source_kind, 'generated');
  const inspected = await ok('inspect_scene_asset', { version: 1, asset: list.assets[0].asset });
  assert(inspected.asset.parts.length >= 5); assert.equal(inspected.asset.provenance.generator, 'form-industries');
  const before = await counts();
  for (const mutate of [
    (a: any) => { a.version = 2; }, (a: any) => { a.scene.room.width = -1; },
    (a: any) => { a.scene.instances[0].position = [0, null, 0]; },
    (a: any) => { a.scene.instances[0].asset = { kind: 'file', path: '../secret' }; },
    (a: any) => { a.authorization = 'secret-canary'; },
    (a: any) => { a.scene.animation.tracks[0].keys[0].visible = 'false'; },
  ]) { const input = structuredClone(fixture); mutate(input); await bad('create_scene', input, 'INVALID_REQUEST'); }
  for (const mutate of [
    (a: any) => { a.scene.instances[1].id = a.scene.instances[0].id; },
    (a: any) => { a.scene.animation.tracks[0].instance_id = 'missing'; },
    (a: any) => { a.scene.animation.tracks[0].part_id = 'missing'; },
    (a: any) => { a.scene.animation.tracks[0].keys[1].time = 0; },
    (a: any) => { a.scene.animation.duration = 1; },
  ]) { const input = structuredClone(fixture); mutate(input); await bad('create_scene', input, 'INVALID_SCENE'); }
  await bad('create_scene', { ...fixture, agent: 'x'.repeat(1024 * 1024) }, 'PAYLOAD_TOO_LARGE');
  const missing = structuredClone(fixture); missing.scene.instances[0].asset = { kind: 'cloud', version_id: randomUUID() };
  await bad('create_scene', missing, 'ASSET_UNAVAILABLE'); assert.deepEqual(await counts(), before);
  service.interruptUpload(); await bad('create_scene', fixture, 'ASSET_UPLOAD_FAILED');
  assert.equal((await counts()).scenes, 0); assert.equal((await counts()).versions, 1);
  const created = await ok('create_scene', fixture); assert.equal(created.scene_id, fixture.request_id); assert.equal(created.revision_id, 1);
  assert.equal(new URL(created.revision_url).origin, 'http://localhost:5173'); assert.equal(new URL(created.revision_url).searchParams.get('revision'), '1');
  const savedCounts = await counts(); assert.deepEqual(savedCounts, { scenes: 1, revisions: 1, versions: 3 });
  assert.deepEqual(await ok('create_scene', fixture), created); assert.deepEqual(await counts(), savedCounts);
  await bad('create_scene', { ...fixture, agent: 'different' }, 'REQUEST_ID_REUSED');
  const read = await ok('read_scene', { version: 1, scene_id: created.scene_id });
  assert.deepEqual(read.scene.room, fixture.scene.room); assert.equal(read.scene.instances.length, 6); assert.equal(read.scene.animation.tracks[0].keys.length, 26);
  assert.deepEqual(read.scene.animation.tracks, fixture.scene.animation.tracks);
  const client = createClient(service.origin, 'fixture-public-key', { global: { headers: { Authorization: `Bearer ${session.access_token}` } }, auth: { persistSession: false } });
  const storage = new CloudStorage(client, owner); const versions = await storage.list();
  const assets = await Promise.all(versions.map(async version => (await storage.load(version)).asset));
  const doc: any = (await service.sql('select document from scenes where id=$1', [created.scene_id])).rows[0].document;
  const workspace = hydrateManifest(readManifest(doc), assets, new Map(versions.map((version, i) => [version.id, assets[i]]))); assert(workspace.items.every(item => !item.missing));
  assert.deepEqual(evaluateWorkspace(workspace.items, workspace.animation, 5)[1].position, fixture.scene.animation.tracks[0].keys.find((key: any) => key.time === 5).position);
  const previousWindow = globalThis.window;
  try {
    (globalThis as any).window = { location: { origin: new URL(created.revision_url).origin } };
    const linked = await openSceneLink(client, readSceneLink(new URL(created.revision_url))!, async () => { throw new Error('Private URL must use owner authentication'); });
    assert.equal(linked.notice, ''); assert.equal(linked.workspace.items.length, 6);
    assert(linked.workspace.items.every(item => !item.missing));
    assert.deepEqual(linked.workspace.animation, workspace.animation);
    assert.deepEqual(linked.workspace.items.map(item => item.asset.parts), workspace.items.map(item => item.asset.parts));
  } finally { if (previousWindow) globalThis.window = previousWindow; else delete (globalThis as any).window; }
  assert.equal(doc.authoring.agent, 'fixture-agent'); assert.equal(doc.authoring.parent_revision, null);
  const update = { version: 1, request_id: randomUUID(), scene_id: created.scene_id, base_revision: 1, agent: 'second-agent', scene: structuredClone(read.scene) };
  update.scene.animation.tracks[0].keys.at(-1).visible = true;
  update.scene.room.width = 25; update.scene.instances[2].position[0] += 1;
  const edited = await ok('update_scene', update); assert.equal(edited.revision_id, 2);
  assert.deepEqual(await ok('update_scene', update), edited);
  const conflict = await bad('update_scene', { ...update, request_id: randomUUID() }, 'CONFLICT'); assert.equal(conflict.current_revision, 2);
  assert.equal((await ok('read_scene', { version: 1, scene_id: created.scene_id, revision_id: 1 })).scene.room.width, fixture.scene.room.width);
  assert.equal((await ok('read_scene', { version: 1, scene_id: created.scene_id })).scene.room.width, 25);
  assert.equal((await ok('read_scene', { version: 1, scene_id: created.scene_id, revision_id: 1 })).scene.animation.tracks[0].keys.at(-1).visible, false);
  assert.equal((await ok('read_scene', { version: 1, scene_id: created.scene_id })).scene.animation.tracks[0].keys.at(-1).visible, true);
  assert.equal((await counts()).revisions, 2); assert.equal((await counts()).versions, 3);
  await writeFile(config, JSON.stringify(otherSession));
  await bad('read_scene', { version: 1, scene_id: created.scene_id }, 'SCENE_UNAVAILABLE');
  await bad('update_scene', { ...update, request_id: randomUUID(), base_revision: 2 }, 'SCENE_UNAVAILABLE');
  await bad('inspect_scene_asset', { version: 1, asset: read.scene.instances[0].asset }, 'ASSET_UNAVAILABLE');
  assert.equal((await ok('list_scene_assets', { version: 1 })).assets.length, 3);
  await writeFile(config, JSON.stringify(session));
  // Form geometry follows the same immutable path and never exposes retained provider config.
  const form = importForm({ hardware_ir_version: '0.2', overview: { title: 'Fixture machine' }, mechanical: { render_dimensions: { x_mm: 100, y_mm: 200, z_mm: 300 } } }, 'fixture.json', 'fixture-digest');
  (form as any).formProject = { projectId: 'fixture', revision: '1', ir: { runtime_config: { base_url: 'private-provider-canary', api_key: 'secret-canary' } }, source: 'raw_ir', hardwareIrVersion: '0.2' };
  const formVersion = await storage.upload({ id: form.id, asset: form, updatedAt: 0 }, () => {});
  // Inspect actual uploaded bytes, not only the allowlisted MCP response.
  const formBytes = await (await storage.downloadFile(formVersion, 'asset.json')).text();
  assert(!formBytes.includes('canary')); assert(!formBytes.includes('runtime_config'));
  const loadedForm = (await storage.load(formVersion)).asset;
  assert.equal(loadedForm.formProject?.projectId, 'fixture'); assert.equal(loadedForm.formProject?.revision, '1');
  const formDetail = await ok('inspect_scene_asset', { version: 1, asset: { kind: 'cloud', version_id: formVersion.id } });
  assert(!JSON.stringify(formDetail).includes('canary'));
  const formRequest = { ...fixture, request_id: randomUUID(), scene: { ...fixture.scene, instances: [{ ...fixture.scene.instances[0], id: 'machine', asset: { kind: 'cloud', version_id: formVersion.id } }], animation: { duration: 2, loop: false, tracks: [{ instance_id: 'machine', part_id: form.parts[0].id, keys: [{ time: 0, position: [0, 0, 0], rotation: [0, 0, 0] }, { time: 2, position: [0, 1, 0], rotation: [0, 0, 0] }] }] } } };
  const invalidPartVisibility = structuredClone(formRequest);
  (invalidPartVisibility.scene.animation.tracks[0].keys[0] as any).visible = false;
  await bad('create_scene', invalidPartVisibility, 'INVALID_SCENE');
  const formCreated = await ok('create_scene', formRequest);
  const formDoc: any = (await service.sql('select document from scenes where id=$1', [formCreated.scene_id])).rows[0].document;
  assert(!JSON.stringify(formDoc).includes('canary')); assert(!JSON.stringify(formDoc).includes('runtime_config'));
  const localProject = { format: 'form-project', version: 1, project_id: 'local-project', agent: 'codex',
    runtime_config: { provider: 'provider-canary', model: 'model-canary', base_url: 'endpoint-canary' },
    project_ir: { hardware_ir_version: '0.2', assembly_metadata: { revision: 7, api_key: 'secret-canary' } } };
  await writeFile(join(root, 'local-project.json'), JSON.stringify(localProject));
  const localRead = await mcp.call('read_form_project', { path: 'local-project.json' });
  assert(!localRead.isError); assert(!JSON.stringify(localRead).includes('canary'));
  assert.equal(localRead.structuredContent.project_id, 'local-project');
  const localSave = await mcp.call('save_form_project', { path: 'local-project.json', project_ir: localProject.project_ir });
  assert(!localSave.isError);
  const savedLocal = JSON.parse(await readFile(join(root, 'local-project.json'), 'utf8'));
  assert(!JSON.stringify(savedLocal).includes('canary')); assert.equal(savedLocal.agent, 'codex');
  assert.equal(savedLocal.project_ir.assembly_metadata.revision, 7);
  // Legacy scene rows can still contain settings: test the real CLI boundaries.
  const legacyDocument = { ...formDoc, runtime_config: localProject.runtime_config };
  const legacySaved = await client.rpc('save_workspace_scene', { p_id: formCreated.scene_id, p_name: 'Legacy portable scene',
    p_document: legacyDocument, p_expected_revision: 1, p_write_id: randomUUID() });
  assert.ifError(legacySaved.error);
  async function cli(args: string[]) {
    const child = spawn(process.execPath, [resolve('cli/astra.mjs'), ...args], { env: { ...process.env,
      ASTRA_CLI_CONFIG: config, VITE_SUPABASE_URL: service.origin, VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 15000);
    try { const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', resolveExit); }); assert.equal(code, 0, output); }
    finally { clearTimeout(timeout); }
  }
  const exportedRoom = join(root, 'cli-export.json');
  await cli(['rooms', 'export', formCreated.scene_id, exportedRoom]);
  assert(!String(await readFile(exportedRoom)).includes('canary'));
  assert.equal(JSON.parse(await readFile(exportedRoom, 'utf8')).authoring.agent, fixture.agent);
  await writeFile(exportedRoom, JSON.stringify(legacyDocument));
  await cli(['rooms', 'import', exportedRoom, '--name', 'CLI portable fixture']);
  const cliDocument: any = (await service.sql("select document from scenes where name='CLI portable fixture'")).rows[0].document;
  assert(!JSON.stringify(cliDocument).includes('canary')); assert.equal(cliDocument.assets[0].projectRevision, '1');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => executeSceneTool('astra.list_scene_assets', { version: 1 }, { client, owner, origin: 'http://localhost:5173', signal: aborted.signal }), (e: any) => e.code === 'TIMEOUT');
  for (const origin of ['file:///tmp', 'http://user:secret@localhost:5173', 'http://localhost:5173/path', 'http://example.com']) assert.throws(() => workbenchOrigin(origin));
  const staticScene = structuredClone(formRequest); staticScene.request_id = randomUUID(); delete (staticScene.scene as any).animation;
  const staticCreated = await ok('create_scene', staticScene);
  assert.deepEqual((await ok('read_scene', { version: 1, scene_id: staticCreated.scene_id })).scene.animation, { duration: 3, loop: false, tracks: [] });
  if (process.argv.includes('--browser')) {
    const { createServer } = await import('vite');
    const { chromium, expect } = await import('@playwright/test');
    process.env.VITE_SUPABASE_URL = service.origin;
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'fixture-public-key';
    process.env.VITE_CLOUD_STORAGE_ENABLED = 'true';
    const web = await createServer({ server: { host: '127.0.0.1', port: 4175, strictPort: true } });
    let browser;
    try {
      await web.listen(); const origin = new URL(web.resolvedUrls!.local[0]).origin;
      const browserMcp = connection({ ASTRA_WORKBENCH_ORIGIN: origin });
      const authored = await ok('create_scene', { ...fixture, request_id: randomUUID() }, browserMcp);
      browser = await chromium.launch({ headless: true, ...(process.env.ASTRA_CHROME_PATH ? { executablePath: process.env.ASTRA_CHROME_PATH } : {}) });
      const context = await browser.newContext();
      await context.addInitScript(({ session, key, origin }) => { if (location.origin === origin) localStorage.setItem(key, JSON.stringify(session)); }, { session, key: `sb-${new URL(service.origin).hostname.split('.')[0]}-auth-token`, origin });
      const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(authored.revision_url);
      await expect(page.getByLabel('Scene link', { exact: true })).toContainText('Cleanroom sampling mission · revision 1');
      await expect(page.locator('.asset')).toHaveCount(6);
      await expect(page.locator('.asset').filter({ hasText: 'MISSING' })).toHaveCount(0);
      await expect(page.getByLabel('Width', { exact: true })).toHaveValue('24.384');
      await expect(page.getByLabel('Local draft status')).toHaveText('Link workspace · not autosaved');
      await page.locator('.asset').nth(1).click(); await page.getByLabel('Keyframe time', { exact: true }).fill('5');
      await expect(page.getByLabel('Keyframe position X', { exact: true })).toHaveValue('-4.2');
      await expect(page.getByLabel('Keyframe position Z', { exact: true })).toHaveValue('-5.3');
      await page.getByRole('button', { name: 'Play animation', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Pause animation', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
      await mkdir('test-results', { recursive: true }); await page.screenshot({ path: 'test-results/mcp-cleanroom.png', fullPage: true });
      assert.deepEqual(errors, []);
      console.log('PASS fresh-browser MCP revision URL: six instances, generated architecture, STEP geometry, and authored robot motion.');
    } finally { await browser?.close(); await web.close(); }
  }
  console.log('PASS MCP stdio schemas; deterministic cleanroom create/read/update; real SQL revisions/RLS; generated/STEP/Form geometry and animation; retry/interruption/conflict; auth/account switch; bounded validation and sanitized outputs.');
} finally { for (const child of children) child.kill(); await service.close(); await rm(root, { recursive: true, force: true }); }
