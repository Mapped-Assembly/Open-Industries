import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { sceneTestService } from './lib/scene-test-service.ts';
import { clients, loadWorkflow, startClient, connectWorkflow, updateRequest } from './lib/mcp-scene-workflows.mjs';
import { readSamplingPlan } from '../src/lib/cleanroom.ts';
import { hydrateManifest, readManifest, evaluateWorkspace } from '../src/lib/workspace.ts';

const root = await mkdtemp(join(tmpdir(), 'mergence-agent-workflows-'));
const service = await sceneTestService();
const owner = randomUUID(), other = randomUUID();
const session = await service.account(owner), otherSession = await service.account(other);
const config = join(root, 'auth.json'); await writeFile(config, JSON.stringify(session));
const profiles = await Promise.all(clients.map(loadWorkflow));
const connections: ReturnType<typeof startClient>[] = [];
const env = { ASTRA_CLI_CONFIG: config, ASTRA_SCENE_TOOLS_ENABLED: 'true', VITE_SUPABASE_URL: service.origin, VITE_SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key', OPENAI_API_KEY: 'provider-secret-canary', XAI_API_KEY: 'provider-secret-canary' };
let web: any, browser: any;
try {
  let origin = 'http://127.0.0.1:5173';
  if (process.argv.includes('--browser')) {
    const { createServer } = await import('vite');
    process.env.VITE_SUPABASE_URL = service.origin; process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'fixture-public-key'; process.env.VITE_CLOUD_STORAGE_ENABLED = 'true';
    web = await createServer({ server: { host: '127.0.0.1', port: 4177, strictPort: true } }); await web.listen();
    origin = new URL(web.resolvedUrls.local[0]).origin;
  }
  const plan = readSamplingPlan(JSON.parse(await readFile('public/examples/cleanroom/sampling-plan.json', 'utf8')));
  assert.equal(plan.find(room => room.room === 'B')!.access.status, 'blocked');
  assert.equal(plan.find(room => room.room === 'B')!.proposedTimes.length, 0);
  const bundle = JSON.parse(await readFile('public/examples/cleanroom/cleanroom-suite.json', 'utf8'));
  const provenance = JSON.parse(await readFile('public/examples/cleanroom/asset-provenance.json', 'utf8'));
  assert.deepEqual(provenance.assets.map((entry: any) => entry.asset_id).sort(), bundle.bundledAssets.map((asset: any) => asset.id).sort());
  for (const entry of provenance.assets) {
    const asset = bundle.bundledAssets.find((asset: any) => asset.id === entry.asset_id);
    assert.equal(entry.digest, asset.source.digest); assert.equal(entry.units, asset.units);
    assert.equal(entry.source_kind, asset.source.kind); assert(entry.permission_note && entry.geometry_note);
  }
  const runs: any[] = [];
  const verifyURL = (value: any, revision: number, sceneId: string) => {
    assert.equal(value.scene_id, sceneId); assert.equal(value.revision_id, revision); assert.equal(value.access, 'owner');
    for (const [field, pin] of [['revision_url', String(revision)], ['head_url', null]] as const) {
      const url = new URL(value[field]); assert.equal(url.origin, origin); assert.equal(url.searchParams.get('sceneId'), sceneId);
      assert.equal(url.searchParams.get('revision'), pin); assert.equal(url.hash, ''); assert.equal(url.username, '');
    }
  };
  for (const profile of profiles) {
    const client = startClient(profile, { root, env: { ...env, ASTRA_WORKBENCH_ORIGIN: origin } }); connections.push(client);
    const mcp = await connectWorkflow(client, profile);
    const list = await mcp.call('list_scene_assets', { version: 1 });
    for (const entry of provenance.assets) {
      assert(list.assets.some((asset: any) => asset.asset.id === entry.example_id));
      const inspected = await mcp.call('inspect_scene_asset', { version: 1, asset: { kind: 'example', id: entry.example_id } });
      assert.equal(inspected.asset.provenance.digest, entry.digest); assert(inspected.asset.parts.length > 0);
    }
    const rawError = await client.call('create_scene', { ...profile.createRequest, authorization: 'input-secret-canary' });
    assert.equal(rawError.structuredContent.error.code, 'INVALID_REQUEST');
    assert(!JSON.stringify(rawError).includes('input-secret-canary'));
    const missing = structuredClone(profile.createRequest); missing.scene.instances[0].asset = { kind: 'cloud', version_id: randomUUID() };
    await assert.rejects(() => mcp.call('create_scene', missing), (e: any) => e.code === 'ASSET_UNAVAILABLE');
    const created = await mcp.call('create_scene', profile.createRequest); verifyURL(created, 1, profile.create.request_id);
    assert.deepEqual(await mcp.call('create_scene', profile.createRequest), created);
    const read = await mcp.call('read_scene', { version: 1, scene_id: created.scene_id });
    assert.equal(read.agent, profile.create.agent); assert.equal(read.scene.instances.length, 6);
    assert.deepEqual(read.scene.animation, profile.createRequest.scene.animation);
    assert(read.scene.instances.every((item: any) => item.asset.kind === 'cloud'));
    // Assert the route actually traverses A/C and never enters blocked B, including interpolation.
    const doc: any = (await service.sql('select document from scenes where id=$1', [created.scene_id])).rows[0].document;
    const geometry = new Map<string, any>();
    for (const bytes of service.objects.values()) { const asset = JSON.parse(bytes.toString()).asset; geometry.set(asset.id, asset); }
    const workspace = hydrateManifest(readManifest(doc), [], new Map(doc.instances.map((item: any) => [item.cloudVersionId, geometry.get(item.assetId)])));
    assert(workspace.items.every(item => !item.missing));
    for (const [time, position] of [[5, [-4.2, .21, -5.3]], [10, [-1.9, .21, -5.3]], [65, [-4.2, .21, 5.3]], [70, [-1.9, .21, 5.3]]] as const) {
      assert.deepEqual(evaluateWorkspace(workspace.items, workspace.animation, time)[1].position, position);
    }
    for (let tick = 0; tick <= 1100; tick++) {
      const [x, , z] = evaluateWorkspace(workspace.items, workspace.animation, tick / 10)[1].position;
      assert(!(x > 0 && x < 6.096 && z > -6.096 && z < 0), `Robot entered blocked Room B at ${tick / 10}s`);
    }
    const update = updateRequest(profile, read);
    const edited = await mcp.call('update_scene', update); verifyURL(edited, 2, created.scene_id);
    assert.deepEqual(await mcp.call('update_scene', update), edited);
    await assert.rejects(() => mcp.call('update_scene', { ...update, request_id: randomUUID() }), (e: any) => e.code === 'CONFLICT' && e.currentRevision === 2);
    const pinned = await mcp.call('read_scene', { version: 1, scene_id: created.scene_id, revision_id: 1 });
    assert.deepEqual(pinned, read);
    const latest = await mcp.call('read_scene', { version: 1, scene_id: created.scene_id });
    assert.equal(latest.scene.room.width, profile.update.room_width);
    assert.deepEqual(latest.scene.instances.find((item: any) => item.id === profile.update.instance_id).position, profile.update.position);
    assert.deepEqual(latest.scene.instances.map((item: any) => item.asset), read.scene.instances.map((item: any) => item.asset));
    assert.deepEqual(latest.scene.animation, read.scene.animation);
    await writeFile(config, JSON.stringify(otherSession));
    await assert.rejects(() => mcp.call('read_scene', { version: 1, scene_id: created.scene_id }), (e: any) => e.code === 'SCENE_UNAVAILABLE');
    await assert.rejects(() => mcp.call('update_scene', { ...update, base_revision: 2, request_id: randomUUID() }), (e: any) => e.code === 'SCENE_UNAVAILABLE');
    await assert.rejects(() => mcp.call('inspect_scene_asset', { version: 1, asset: read.scene.instances[0].asset }), (e: any) => e.code === 'ASSET_UNAVAILABLE');
    await writeFile(config, JSON.stringify(session));
    const messages = client.transcript;
    assert.equal(messages[0].message.method, 'initialize');
    assert(messages.some((entry: any) => entry.message.method === 'notifications/initialized'));
    assert(messages.filter((entry: any) => entry.direction === 'request' && 'id' in entry.message).every((entry: any) => typeof entry.message.id === profile.request_ids));
    const responses = JSON.stringify(messages.filter((entry: any) => entry.direction === 'response'));
    for (const secret of ['canary', session.access_token, session.refresh_token, 'runtime_config']) assert(!responses.includes(secret));
    const revisions = (await service.sql('select revision,parent_revision,author_agent from scene_revisions where scene_id=$1 order by revision', [created.scene_id])).rows;
    assert.deepEqual(revisions, [{ revision: 1, parent_revision: null, author_agent: profile.create.agent }, { revision: 2, parent_revision: 1, author_agent: profile.update.agent }]);
    runs.push({ profile, mcp, created, edited, read });
    console.log(`PASS ${profile.client}: initialize/discover, ${profile.response_mode} results, create/update/pin, A/C route, conflict, ownership, sanitization.`);
  }
  // An authenticated account, not the declared vendor/client name, owns the scene.
  const handoff = await runs[1].mcp.call('read_scene', { version: 1, scene_id: runs[0].created.scene_id });
  const handed = await runs[1].mcp.call('update_scene', updateRequest(profiles[1], handoff, randomUUID()));
  verifyURL(handed, 3, runs[0].created.scene_id);
  assert.equal((await runs[2].mcp.call('read_scene', { version: 1, scene_id: handed.scene_id })).agent, profiles[1].update.agent);
  // Exercise the same copyable CLI used by the walkthrough; no provider invocation.
  const cli = spawn(process.execPath, ['scripts/replay-scene-workflow.mjs', '--client', 'codex', '--update', runs[2].created.scene_id, '--base-revision', '2'], { env: { ...process.env, ...env, ASTRA_ROOT: root, ASTRA_WORKBENCH_ORIGIN: origin } });
  let output = '', stderr = ''; cli.stdout.on('data', chunk => { output += chunk; }); cli.stderr.on('data', chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { cli.on('error', reject); cli.on('close', resolve); });
  assert.equal(exitCode, 0, stderr); verifyURL(JSON.parse(output), 3, runs[2].created.scene_id);
  assert(!stderr.includes(session.access_token));
  if (web) {
    const { chromium, expect } = await import('@playwright/test');
    const evidence = process.env.MCP_WORKFLOW_EVIDENCE_DIR ?? 'test-results';
    await mkdir(evidence, { recursive: true });
    browser = await chromium.launch({ headless: true, ...(process.env.ASTRA_CHROME_PATH ? { executablePath: process.env.ASTRA_CHROME_PATH } : {}) });
    for (const run of runs) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await context.addInitScript(({ session, origin, key }: any) => { if (location.origin === origin) localStorage.setItem(key, JSON.stringify(session)); }, { session, origin, key: `sb-${new URL(service.origin).hostname.split('.')[0]}-auth-token` });
      const page = await context.newPage(), errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
      // These are server-returned URLs, never the bundled /?scene=cleanroom route.
      await page.goto(run.created.revision_url);
      await expect(page.getByLabel('Scene link', { exact: true })).toContainText('revision 1');
      await expect(page.locator('.asset')).toHaveCount(6); await expect(page.locator('.asset').filter({ hasText: 'MISSING' })).toHaveCount(0);
      await expect(page.getByLabel('Width', { exact: true })).toHaveValue('24.384');
      await expect(page.getByLabel('Local draft status')).toHaveText('Link workspace · not autosaved');
      const canvas = page.getByLabel('Interactive 3D room').locator('canvas'); await expect(canvas).toBeVisible();
      assert(await canvas.evaluate((element: HTMLCanvasElement) => element.width > 0 && !element.getContext('webgl2')!.isContextLost()));
      const capture = (stage: string) => page.screenshot({ path: join(evidence, `mcp-${run.profile.client}-${stage}.png`), fullPage: true });
      await capture('original');
      await page.locator('.asset').nth(1).click();
      await page.getByLabel('Keyframe time', { exact: true }).fill('5');
      await expect(page.getByLabel('Keyframe position X', { exact: true })).toHaveValue('-4.2');
      await expect(page.getByLabel('Keyframe position Z', { exact: true })).toHaveValue('-5.3');
      const atA = await canvas.screenshot();
      await page.getByLabel('Keyframe time', { exact: true }).fill('65');
      await expect(page.getByLabel('Keyframe position Z', { exact: true })).toHaveValue('5.3');
      await expect.poll(async () => (await canvas.screenshot()).equals(atA)).toBe(false);
      await page.getByRole('button', { name: 'Play animation', exact: true }).click();
      await expect.poll(async () => Number(await page.getByLabel('Keyframe time', { exact: true }).inputValue())).toBeGreaterThan(65);
      await page.getByRole('button', { name: 'Pause animation', exact: true }).click();
      await page.goto(run.edited.revision_url);
      await expect(page.getByLabel('Scene link', { exact: true })).toContainText('revision 2');
      await expect(page.getByLabel('Width', { exact: true })).toHaveValue(String(run.profile.update.room_width));
      await expect(page.locator('.asset')).toHaveCount(6);
      await expect(page.locator('.asset').filter({ hasText: 'MISSING' })).toHaveCount(0);
      await capture('updated');
      await page.goto(run.created.revision_url);
      await expect(page.getByLabel('Scene link', { exact: true })).toContainText('revision 1');
      await expect(page.getByLabel('Width', { exact: true })).toHaveValue('24.384');
      await expect(page.locator('.asset').filter({ hasText: 'MISSING' })).toHaveCount(0);
      await capture('pinned');
      // Compare and restore the same MCP-authored scene through the workbench.
      // Earlier handoff/replay checks may have advanced its head beyond revision 2.
      const beforeRestore = (await service.sql('select revision,document from scene_revisions where scene_id=$1 order by revision', [run.created.scene_id])).rows;
      const head = Number(beforeRestore.at(-1)!.revision), restoredRevision = head + 1;
      await page.getByText('Revision history', { exact: true }).click();
      await expect(page.getByText(`Latest saved revision: ${head}`, { exact: true })).toBeVisible();
      await page.getByLabel('Compare from revision').selectOption('1');
      await page.getByLabel('Compare to revision').selectOption('2');
      await page.getByRole('button', { name: 'Compare revisions', exact: true }).click();
      const comparison = page.getByRole('region', { name: 'Revision comparison' });
      await expect(comparison).toContainText('Width (m)');
      await expect(comparison).toContainText('Position (m)');
      await expect(comparison).toContainText(String(run.profile.update.room_width));
      await comparison.scrollIntoViewIfNeeded();
      // The comparison table scrolls horizontally in the narrow sidebar.
      await comparison.locator('.history-diff-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; });
      await capture('comparison');
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Restore revision 1', exact: true }).click();
      await expect(page.getByLabel('Scene save status')).toContainText(`Restored revision 1 as revision ${restoredRevision}`);
      await expect(page.getByLabel('Scene link', { exact: true })).toContainText(`revision ${restoredRevision}`);
      assert.equal(new URL(page.url()).searchParams.get('revision'), String(restoredRevision));
      await expect(page.getByLabel('Width', { exact: true })).toHaveValue('24.384');
      await expect(page.locator('.asset')).toHaveCount(6);
      await expect(page.locator('.asset').filter({ hasText: 'MISSING' })).toHaveCount(0);
      const restored = await run.mcp.call('read_scene', { version: 1, scene_id: run.created.scene_id });
      assert.equal(restored.revision_id, restoredRevision);
      assert.deepEqual(restored.scene, run.read.scene); // placements, immutable assets and animation all restored
      const afterRestore = (await service.sql('select revision,document from scene_revisions where scene_id=$1 order by revision', [run.created.scene_id])).rows;
      assert.deepEqual(afterRestore.slice(0, -1), beforeRestore); // restore never rewrites a snapshot
      assert.equal(afterRestore.length, beforeRestore.length + 1);
      const metadata = (await service.sql('select parent_revision,restored_from_revision,author_source from scene_revisions where scene_id=$1 and revision=$2', [run.created.scene_id, restoredRevision])).rows[0];
      assert.deepEqual(metadata, { parent_revision: head, restored_from_revision: 1, author_source: 'restore' });
      await page.getByText('Revision history', { exact: true }).click();
      await expect(page.getByLabel('Scene revisions')).toContainText(`Revision ${restoredRevision}`);
      await page.getByText(`Latest saved revision: ${restoredRevision}`, { exact: true }).scrollIntoViewIfNeeded();
      await capture('restored');
      // The original agent URL remains pinned after a browser-originated restore.
      await page.goto(run.created.revision_url);
      await expect(page.getByLabel('Scene link', { exact: true })).toContainText('revision 1');
      await expect(page.getByLabel('Width', { exact: true })).toHaveValue('24.384');
      assert.deepEqual(await run.mcp.call('read_scene', { version: 1, scene_id: run.created.scene_id, revision_id: 1 }), run.read);
      assert.deepEqual(errors, []); await context.close();
      console.log(`PASS ${run.profile.client} browser: returned URLs, geometry/motion, edit, compare, restore as revision ${restoredRevision}, immutable history and pinned original.`);
    }
  }
  console.log('PASS cross-client handoff and replay CLI; local SQL/Auth/Storage fixtures only; no live LLM calls.');
} finally { await browser?.close(); await web?.close(); await Promise.all(connections.map(client => client.close())); await service.close(); await rm(root, { recursive: true, force: true }); }
