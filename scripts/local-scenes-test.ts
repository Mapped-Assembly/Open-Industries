import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { LocalSceneBackend } from '../server/local-scene-backend.ts';
import { executeSceneTool } from '../server/mcp-scenes.ts';
import { hydrateManifest, readManifest } from '../src/lib/workspace.ts';

const directory = await mkdtemp(join(tmpdir(), 'oi-local-scenes-'));
const children: ReturnType<typeof spawn>[] = [];
/** Exercise the real stdio server with no cloud configuration or login. */
function connection() {
  const child = spawn(process.execPath, [resolve('server/astra-mcp.mjs')], {
    env: { ...process.env, ASTRA_ROOT: directory, ASTRA_SCENE_BACKEND: 'local', ASTRA_SCENE_DATA_DIR: directory,
      ASTRA_SCENE_TOOLS_ENABLED: 'true', VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', ASTRA_CLI_CONFIG: join(directory, 'no-login.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child); let sequence = 0; let stderr = '';
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const pending = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout! }).on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id); });
  return {
    async stop(): Promise<void> { const exited = once(child, 'exit'); child.kill(); await exited; },
    call(name: string, args: unknown): Promise<any> {
      return new Promise((resolveResult, reject) => {
        const id = ++sequence;
        const timeout = setTimeout(() => reject(new Error(`MCP timeout ${stderr}`)), 15000);
        pending.set(id, value => { clearTimeout(timeout); resolveResult(value.result); });
        child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: `astra.${name}`, arguments: args } }) + '\n');
      });
    },
  };
}
/** Require successful schema-validated MCP output. */
async function ok(client: ReturnType<typeof connection>, name: string, args: unknown): Promise<any> {
  const response = await client.call(name, args); assert(!response.isError, JSON.stringify(response)); return response.structuredContent;
}
try {
  const first = connection();
  const fixture = JSON.parse(await readFile('scripts/fixtures/cleanroom-scene-request.json', 'utf8'));
  fixture.request_id = randomUUID();
  const assets = await ok(first, 'list_scene_assets', { version: 1 }); assert.equal(assets.assets.length, 3);
  const original = await ok(first, 'inspect_scene_asset', { version: 1, asset: assets.assets[0].asset });
  const created = await ok(first, 'create_scene', fixture); assert.equal(created.revision_id, 1);
  assert(created.revision_url.startsWith('oi-local://'));
  assert.deepEqual(await ok(first, 'create_scene', fixture), created);
  await first.stop();
  const second = connection();
  const read = await ok(second, 'read_scene', { version: 1, scene_id: created.scene_id });
  assert.equal(read.agent, fixture.agent);
  assert.deepEqual(read.scene.animation, fixture.scene.animation);
  assert(read.scene.instances.every((item: any) => item.asset.kind === 'local'));
  const persisted = await ok(second, 'inspect_scene_asset', { version: 1, asset: read.scene.instances[0].asset });
  assert.deepEqual(persisted.asset.provenance, original.asset.provenance);
  const update = { version: 1, request_id: randomUUID(), scene_id: created.scene_id, base_revision: 1, agent: 'restart-test', scene: { ...read.scene, name: 'Garden revised' } };
  const updated = await ok(second, 'update_scene', update); assert.equal(updated.revision_id, 2);
  assert.deepEqual(await ok(second, 'update_scene', update), updated);
  const conflict = await second.call('update_scene', { ...update, request_id: randomUUID() }); assert.equal(conflict.structuredContent.error.code, 'CONFLICT');
  const reused = await second.call('update_scene', { ...update, agent: 'changed' }); assert.equal(reused.structuredContent.error.code, 'REQUEST_ID_REUSED');
  const old = await ok(second, 'read_scene', { version: 1, scene_id: created.scene_id, revision_id: 1 }); assert.deepEqual(old, read);
  await second.stop();

  const backend = new LocalSceneBackend(directory);
  try {
    const exported = await backend.exportScene(created.scene_id, 1);
    const workspace = hydrateManifest(readManifest(exported), []);
    assert.equal(workspace.items.length, fixture.scene.instances.length);
    assert(workspace.items.every(item => !item.missing));
    assert.equal(exported.authoring.agent, fixture.agent);
    const importedId = await backend.persistAsset(workspace.items[0].asset);
    assert.equal(importedId, read.scene.instances[0].asset.version_id);
    const assetPath = join(directory, 'custom-asset.json');
    const customAsset = { ...workspace.items[0].asset, id: 'custom-garden', name: 'Custom garden geometry' };
    await writeFile(assetPath, JSON.stringify({ schemaVersion: 1, asset: customAsset }));
    const cli = promisify(execFile);
    const cliEnv = { ...process.env, ASTRA_SCENE_DATA_DIR: directory };
    const imported = await cli(process.execPath, ['--import', 'tsx', 'cli/local-scenes.ts', 'import-asset', assetPath], { env: cliEnv });
    const customRef = JSON.parse(imported.stdout);
    assert.equal(customRef.kind, 'local');
    const exportPath = join(directory, 'portable.scene.json');
    await cli(process.execPath, ['--import', 'tsx', 'cli/local-scenes.ts', 'export', created.scene_id, exportPath, '1'], { env: cliEnv });
    assert.deepEqual(JSON.parse(await readFile(exportPath, 'utf8')), JSON.parse(JSON.stringify(exported)));
    assert.equal(hydrateManifest(readManifest(JSON.parse(await readFile(exportPath, 'utf8'))), []).items.length, fixture.scene.instances.length);
    await assert.rejects(() => cli(process.execPath, ['--import', 'tsx', 'cli/local-scenes.ts', 'export', created.scene_id, exportPath, '1'], { env: cliEnv }));
    const context = { backend, origin: 'http://localhost:5173', signal: AbortSignal.timeout(15000) };
    const custom = await executeSceneTool('astra.inspect_scene_asset', { version: 1, asset: customRef }, context);
    assert.equal((custom as any).asset.asset_id, 'custom-garden');
    const peer = new LocalSceneBackend(directory);
    const race = await Promise.allSettled(['a', 'b'].map(agent => executeSceneTool('astra.update_scene', { ...update, base_revision: 2, request_id: randomUUID(), agent }, { ...context, backend: agent === 'a' ? backend : peer })));
    peer.close();
    assert.equal(race.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal((race.find(value => value.status === 'rejected') as PromiseRejectedResult).reason.code, 'CONFLICT');
    assert.equal((await backend.read(created.scene_id)).revision, 3);
    const missing = await connection().call('inspect_scene_asset', { version: 1, asset: { kind: 'local', version_id: randomUUID() } });
    assert.equal(missing.structuredContent.error.code, 'ASSET_UNAVAILABLE');
    // Hash verification rejects modified bytes without updating or destroying any revision.
    const metadata = (await backend.asset(importedId))!;
    const path = join(directory, 'assets', `${metadata.files[0].sha256}.json`);
    const bytes = await readFile(path, 'utf8');
    await writeFile(path, bytes.replace('schemaVersion', 'schemaVersioN'));
    await assert.rejects(() => executeSceneTool('astra.inspect_scene_asset', { version: 1, asset: { kind: 'local', version_id: importedId } }, context), { code: 'ASSET_UNAVAILABLE' });
    assert.equal((await backend.read(created.scene_id, 1)).revision, 1);
    await writeFile(path, bytes);
    console.log('PASS: local MCP restart, revisions, provenance, portable geometry, deduplication, retries, concurrent conflicts, corruption detection');
  } finally { backend.close(); }
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  await rm(directory, { recursive: true, force: true });
}
