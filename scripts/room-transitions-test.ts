import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, type Route } from '@playwright/test';
import { createServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { sceneTestService } from './lib/scene-test-service.ts';
import { SceneRepository } from '../src/lib/scene-repository.ts';
import { importForm } from '../src/lib/form.ts';
import { appendAssets, emptyWorkspace, makeManifest, writeKeyframe, zeroPose } from '../src/lib/workspace.ts';

const service = await sceneTestService();
const owner = randomUUID(), other = randomUUID();
const session = await service.account(owner), otherSession = await service.account(other);
const client = createClient(service.origin, 'fixture-public-key', { global: { headers: { Authorization: `Bearer ${session.access_token}` } }, auth: { persistSession: false } });
const repo = new SceneRepository(client, owner, true);
const source = { hardware_ir_version: '0.2', overview: { title: 'Switch machine' }, mechanical: { render_dimensions: { x_mm: 1000, y_mm: 1000, z_mm: 1000 } } };
const asset = importForm(source, 'machine.json', 'switch-machine');
let a = appendAssets(emptyWorkspace(), [asset]);
a.animation = writeKeyframe(a.animation, a.items[0].id, undefined, { ...zeroPose(), id: 'hidden', time: 1, visible: false });
const b = appendAssets(emptyWorkspace(), [asset, asset]); b.room = [12, 8, 4];
const first = await repo.save(a, 'Room A', randomUUID(), 0, true, () => {});
const second = await repo.save(b, 'Room B', randomUUID(), 0, true, () => {});
const missing = await repo.save({ ...a, items: a.items.map(i => ({ ...i, asset: { ...asset, id: 'missing-machine', source: { ...asset.source, digest: 'missing-digest' } } })) }, 'Missing room', randomUUID(), 0, false, () => {});
const output = process.env.ROOM_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'room-transitions-'));
await mkdir(output, { recursive: true });
const web = await createServer({ envFile: false, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(service.origin),
  'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify('fixture-public-key'),
  'import.meta.env.VITE_CLOUD_STORAGE_ENABLED': JSON.stringify('true'),
  'import.meta.env.VITE_FORM_GENERATION_ENABLED': JSON.stringify('true'),
}, server: { host: '127.0.0.1', port: 4182, strictPort: true } });
let browser;
const errors: string[] = [];
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
try {
  await web.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.ASTRA_CHROME_PATH ? { executablePath: process.env.ASTRA_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ key, session }) => {
    if (!localStorage.getItem('fixture-initialized')) { localStorage.setItem(key, JSON.stringify(session)); localStorage.setItem('fixture-initialized', 'true'); }
  }, { key: `sb-${new URL(service.origin).hostname.split('.')[0]}-auth-token`, session });
  await context.route('**/default-room.json', route => json(route, makeManifest(emptyWorkspace(), true)));
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text()); });
  page.on('dialog', d => { assert.equal(d.type(), 'confirm'); void d.accept(); });
  await page.goto('http://127.0.0.1:4182');
  await expect(page).toHaveTitle('Mergence — Spatial Workbench');
  assert.equal(new URL(page.url()).pathname, '/');
  const manager = page.getByRole('region', { name: 'Scene persistence' });
  const prompt = page.getByRole('dialog', { name: 'Unsaved room changes' });
  const sidebarNew = page.getByRole('button', { name: 'New room', exact: true }).first();
  const open = async (name: string) => { await manager.getByRole('button', { name: `Open scene ${name}`, exact: true }).click(); };
  const width = page.getByLabel('Width', { exact: true });
  const saved = () => expect(page.getByLabel('Local draft status')).toHaveText('Local draft saved');
  const roomId = () => page.evaluate(async owner => (await import('/src/lib/scene-storage.ts')).loadActiveRoom(owner ?? 'guest'), owner);
  const exportScene = async () => {
    const event = page.waitForEvent('download'); await manager.getByRole('button', { name: 'Export scene JSON' }).click();
    const path = join(output, 'current-room.json'); await (await event).saveAs(path); return JSON.parse(await readFile(path, 'utf8'));
  };
  await expect(manager.getByRole('button', { name: 'Open scene Room A', exact: true })).toBeEnabled();
  await open('Room A'); await expect(page.locator('.asset')).toHaveCount(1); await saved();
  assert.equal(await roomId(), first.scene.id);
  await page.locator('.asset').first().click();
  await page.getByLabel('Keyframe time', { exact: true }).fill('1');
  await expect(page.getByLabel('Keyframe visible', { exact: true })).not.toBeChecked();
  // Save and continue must open B exactly once, with no second discard prompt.
  let nativePrompts = 0; page.on('dialog', () => nativePrompts++);
  await width.fill('9'); await open('Room B'); await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(prompt).not.toBeVisible(); await expect(width).toHaveValue('12');
  assert.equal(nativePrompts, 0);
  await open('Room A'); await expect(width).toHaveValue('9');
  await page.locator('.asset').first().click(); await expect(page.locator('.keyframe')).toHaveCount(1);
  assert.equal((await repo.open(first.scene.id, [], () => {})).workspace.room[0], 9);
  console.log('PASS saved room switch and independent timeline');

  // Every local replacement gets a fresh identity and flushes pending edits.
  await width.fill('10'); await sidebarNew.click(); await expect(prompt).toBeVisible();
  await page.screenshot({ path: join(output, 'desktop-unsaved.png') });
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(width).toHaveValue('10');
  await sidebarNew.focus(); await page.keyboard.press('Enter'); await expect(prompt).toBeVisible();
  await page.keyboard.press('Escape'); await expect(prompt).not.toBeVisible(); await expect(sidebarNew).toBeFocused();
  await sidebarNew.click(); await prompt.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(page.locator('.asset')).toHaveCount(0); await saved();
  assert.notEqual(await roomId(), first.scene.id);
  await open('Room A'); await expect(width).toHaveValue('10');
  const portable = makeManifest(b, true);
  await page.getByLabel('Import files').setInputFiles({ name: 'room.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)) });
  // A clean saved scene needs no discard prompt, but still receives a fresh room ID.
  await expect(width).toHaveValue('12'); await saved();
  const importedId = await roomId(); assert.notEqual(importedId, first.scene.id); assert.notEqual(importedId, second.scene.id);
  await page.getByRole('button', { name: 'Build space layout', exact: true }).click();
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: 'Discard and continue', exact: true }).click();
  await expect(page.locator('.asset')).toHaveCount(5); await saved(); assert.notEqual(await roomId(), importedId);
  // Imported and original drafts survive destination autosaves unchanged.
  const drafts = await page.evaluate(async ({ owner, first, imported }) => {
    const { loadScene } = await import('/src/lib/scene-storage.ts');
    return { a: (await loadScene(`${owner}:${first}`))!.scene.workspaceDocument, imported: (await loadScene(`${owner}:${imported}`))!.scene.workspaceDocument };
  }, { owner, first: first.scene.id, imported: importedId! });
  assert.equal(drafts.a!.room[0], 10); assert.equal(drafts.imported!.instances.length, 2);
  await open('Room A'); await prompt.getByRole('button', { name: 'Discard and continue', exact: true }).click(); await expect(width).toHaveValue('10');
  console.log('PASS sidebar/import/generated replacement identities and keyboard cancel');

  // Save errors preserve edits and the pending destination, allowing retry/cancel/discard.
  await width.fill('11');
  const saveURL = '**/rest/v1/rpc/save_workspace_scene';
  await page.route(saveURL, route => json(route, { message: 'Injected save failure' }, 503));
  await open('Room B'); await prompt.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(prompt.getByRole('alert')).toContainText('Injected save failure'); await expect(width).toHaveValue('11');
  await page.screenshot({ path: join(output, 'failed-save-retains-edits.png') });
  await page.unroute(saveURL); await prompt.getByRole('button', { name: 'Retry save and continue', exact: true }).click();
  await expect(width).toHaveValue('12'); await open('Room A'); await expect(width).toHaveValue('11');
  // A failed destination load never installs a partial room; retry uses the same destination.
  const openURL = '**/rest/v1/rpc/get_workspace_scene';
  await page.route(openURL, route => json(route, { message: 'Injected open failure' }, 503));
  await open('Room B'); await expect(manager.getByRole('alert')).toContainText('Injected open failure'); await expect(width).toHaveValue('11');
  await page.unroute(openURL); await manager.getByRole('button', { name: 'Retry room switch' }).click(); await expect(width).toHaveValue('12');
  // Cancel an in-flight open, start another, then deliver the older result last.
  const entered = deferred(), release = deferred(), delivered = deferred();
  await page.route(openURL, async route => {
    if (route.request().postDataJSON().p_id !== first.scene.id) return route.continue();
    const response = await route.fetch(); entered.resolve(); await release.promise; await route.fulfill({ response }); delivered.resolve();
  });
  await open('Room A'); await entered.promise;
  await manager.getByRole('button', { name: 'Cancel current action' }).click();
  await open('Missing room'); await expect(page.locator('.asset')).toHaveCount(1); await expect(page.locator('.asset')).toContainText('MISSING');
  release.resolve(); await delivered.promise; await page.unroute(openURL);
  await expect(manager.getByLabel('Scene name')).toHaveValue('Missing room');
  await page.locator('.asset').first().click();
  await expect(page.locator('.inspector')).toContainText(/missing/i);
  const missingExport = await exportScene(); assert.equal(missingExport.instances.length, 1); assert.equal(missingExport.bundledAssets.length, 0);
  assert.deepEqual(missingExport.animation, JSON.parse(JSON.stringify(a.animation)));
  await open('Room B'); await expect(width).toHaveValue('12');
  // A newer cloud revision must never be overwritten by Save and continue.
  await repo.save(second.workspace, 'Room B', second.scene.id, 1, false, () => {});
  await width.fill('13'); await open('Room A');
  await prompt.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(prompt.getByRole('alert')).toContainText('Current revision: 2'); await expect(width).toHaveValue('13');
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await open('Room A'); await prompt.getByRole('button', { name: 'Discard and continue', exact: true }).click(); await expect(width).toHaveValue('11');
  await open('Room B'); await expect(width).toHaveValue('12');
  console.log('PASS save/open failures, conflict, retry, cancelled stale open, missing geometry');

  // Cloud duplication retains independent instance IDs and shared geometry after deletion.
  await manager.getByRole('button', { name: 'Duplicate scene Room B', exact: true }).click();
  await expect(manager.getByLabel('Scene name')).toHaveValue('Room B copy');
  const copy = await exportScene(); assert.notEqual(copy.instances[0].id, second.workspace.items[0].id);
  await width.fill('15'); await manager.getByRole('button', { name: 'Save cloud scene', exact: true }).click();
  await expect(manager.getByLabel('Scene save status')).toContainText('saved to Postgres');
  await open('Room B'); await expect(width).toHaveValue('12');
  await manager.getByRole('button', { name: 'Delete scene Room B copy', exact: true }).click();
  await expect(manager.getByRole('button', { name: 'Open scene Room B copy', exact: true })).toHaveCount(0);
  assert((await repo.open(second.scene.id, [], () => {})).workspace.items.every(i => !i.missing));
  // Exercise the same manager in mobile and fullscreen layouts.
  await page.setViewportSize({ width: 390, height: 844 }); await width.fill('13'); await sidebarNew.click();
  await expect(prompt).toBeVisible(); await page.screenshot({ path: join(output, 'mobile-unsaved.png') });
  await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await manager.getByLabel('Scene name').fill('Unsaved room name');
  await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click();
  await page.getByRole('button', { name: /Show workspace/ }).click();
  await expect(manager.getByLabel('Scene name')).toHaveValue('Unsaved room name');
  await sidebarNew.click(); await expect(prompt).toBeVisible(); await page.screenshot({ path: join(output, 'fullscreen-unsaved.png') });
  await prompt.getByRole('button', { name: 'Discard and continue', exact: true }).click(); await expect(page.locator('.asset')).toHaveCount(0);
  await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Enter fullscreen', exact: true })).toBeVisible();
  console.log('PASS duplicate/delete independence, mobile and fullscreen');

  // A cloud asset request belongs to the room in which it started.
  await open('Room B'); await expect(width).toHaveValue('12');
  await page.getByRole('button', { name: 'GIF studio', exact: true }).click();
  const studio = page.getByRole('region', { name: 'GIF studio', exact: true });
  await studio.getByRole('button', { name: /Asset library/ }).click();
  const cloudEntered = deferred(), cloudRelease = deferred(), cloudDelivered = deferred();
  await page.route('**/storage/v1/object/**', async route => {
    const response = await route.fetch(); cloudEntered.resolve(); await cloudRelease.promise; await route.fulfill({ response }); cloudDelivered.resolve();
  });
  await studio.getByRole('button', { name: 'Load cloud asset into room', exact: true }).first().click(); await cloudEntered.promise;
  await sidebarNew.click(); await expect(page.locator('.asset')).toHaveCount(0);
  cloudRelease.resolve(); await cloudDelivered.promise; await page.unroute('**/storage/v1/object/**');
  await expect(studio).not.toBeVisible(); await expect(page.locator('.asset')).toHaveCount(0);
  console.log('PASS stale cloud-asset result after room replacement');

  // Account changes invalidate an in-flight result and reset retry/prompt UI.
  const oldEntered = deferred(), oldRelease = deferred(), oldDelivered = deferred();
  await page.route(openURL, async route => { const response = await route.fetch(); oldEntered.resolve(); await oldRelease.promise; await route.fulfill({ response }); oldDelivered.resolve(); });
  await open('Room A'); await oldEntered.promise;
  await page.evaluate(async session => { const { supabase } = await import('/src/lib/supabase.ts'); await supabase!.auth.setSession(session); }, otherSession);
  await expect(manager.getByRole('button', { name: 'Open scene Room A', exact: true })).toHaveCount(0);
  await expect(width).toBeEnabled(); oldRelease.resolve(); await oldDelivered.promise; await page.unroute(openURL);
  await expect(page.locator('.asset')).toHaveCount(0); await expect(prompt).not.toBeVisible();
  // Scene JSON takes an asynchronous File.text path too; its late result is fenced.
  await page.evaluate(() => {
    const original = File.prototype.text;
    const wait = new Promise<void>(resolve => { (window as any).releaseImport = resolve; });
    File.prototype.text = async function() {
      const text = await original.call(this);
      if (this.name === 'delayed-scene.json') { (window as any).importStarted = true; await wait; File.prototype.text = original; }
      return text;
    };
  });
  await page.getByLabel('Import files').setInputFiles({ name: 'delayed-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(portable)) });
  await page.waitForFunction(() => (window as any).importStarted);
  await page.evaluate(async session => { const { supabase } = await import('/src/lib/supabase.ts'); await supabase!.auth.setSession(session); }, session);
  await expect(manager.getByRole('button', { name: 'Open scene Room A', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).releaseImport());
  await expect(page.locator('.asset')).toHaveCount(0); await expect(prompt).not.toBeVisible();

  const generationEntered = deferred(), generationRelease = deferred(), generationDelivered = deferred();
  // Generation is mocked in this suite; its availability check must stay local too.
  await page.route('**/api/health', route => json(route, { available: true, message: 'Fixture generator ready' }));
  await page.route('**/api/generations', route => json(route, { id: 'delayed-generation' }));
  await page.route('**/api/generations/delayed-generation', async route => {
    generationEntered.resolve(); await generationRelease.promise;
    await json(route, { status: 'succeeded', project: source, message: 'Old account generation' }); generationDelivered.resolve();
  });
  await page.getByText('Build with Form', { exact: true }).click();
  await expect(page.getByRole('status', { name: 'Forma availability' })).toHaveText('Fixture generator ready');
  await expect(page.getByRole('button', { name: 'Build and import →', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Build and import →', exact: true }).click(); await generationEntered.promise;
  await page.evaluate(async session => { const { supabase } = await import('/src/lib/supabase.ts'); await supabase!.auth.setSession(session); }, otherSession);
  await expect(width).toBeEnabled(); generationRelease.resolve(); await generationDelivered.promise;
  await expect(page.locator('.asset')).toHaveCount(0);

  // A committed old-account save may finish, but cannot replace the new account's editor.
  await page.evaluate(async session => { const { supabase } = await import('/src/lib/supabase.ts'); await supabase!.auth.setSession(session); }, session);
  await open('Room A'); await expect(width).toHaveValue('11'); await width.fill('16');
  const saveEntered = deferred(), saveRelease = deferred(), saveDelivered = deferred();
  await page.route(saveURL, async route => { const response = await route.fetch(); saveEntered.resolve(); await saveRelease.promise; await route.fulfill({ response }); saveDelivered.resolve(); });
  await manager.getByRole('button', { name: 'Save cloud scene', exact: true }).click(); await saveEntered.promise;
  await page.evaluate(async session => { const { supabase } = await import('/src/lib/supabase.ts'); await supabase!.auth.setSession(session); }, otherSession);
  await expect(width).toBeEnabled(); saveRelease.resolve(); await saveDelivered.promise; await page.unroute(saveURL);
  await expect(page.locator('.asset')).toHaveCount(0); await expect(manager.getByRole('button', { name: 'Open scene Room A', exact: true })).toHaveCount(0);
  assert.equal((await repo.open(first.scene.id, [], () => {})).workspace.room[0], 16);
  await page.evaluate(async session => { const { supabase } = await import('/src/lib/supabase.ts'); await supabase!.auth.setSession(session); }, session);
  await expect(manager.getByRole('button', { name: 'Open scene Room A', exact: true })).toBeEnabled();
  const listEntered = deferred(), listRelease = deferred(), listDelivered = deferred();
  await page.route('**/rest/v1/scenes?**', async route => {
    if (route.request().headers().authorization !== `Bearer ${session.access_token}`) return route.continue();
    const response = await route.fetch(); listEntered.resolve(); await listRelease.promise; await route.fulfill({ response }); listDelivered.resolve();
  });
  await manager.getByRole('button', { name: 'Refresh scenes', exact: true }).click(); await listEntered.promise;
  await page.evaluate(async session => { const { supabase } = await import('/src/lib/supabase.ts'); await supabase!.auth.setSession(session); }, otherSession);
  await expect(width).toBeEnabled(); listRelease.resolve(); await listDelivered.promise; await page.unroute('**/rest/v1/scenes?**');
  await expect(manager.getByRole('button', { name: 'Open scene Room A', exact: true })).toHaveCount(0);
  console.log('PASS stale scene import, generation, save, list and account results');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub', exact: true })).toBeVisible();
  await expect(manager).toContainText('Sign in to save scenes');
  await expect(width).toBeEnabled();
  await saved();
  await page.getByLabel('Import files').setInputFiles({ name: 'local.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await expect(page.locator('.asset')).toHaveCount(1);
  await width.fill('17');
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    (window as any).restoreDraftWrites = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === 'scenes' && String(value.id).startsWith('active:')) throw new DOMException('Injected local storage failure', 'QuotaExceededError');
      return original.call(this, value, ...args);
    };
  });
  await sidebarNew.click(); await expect(prompt).toContainText('local draft');
  await prompt.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(prompt.getByRole('alert')).toContainText('Injected local storage failure'); await expect(width).toHaveValue('17');
  await page.evaluate(() => (window as any).restoreDraftWrites());
  await prompt.getByRole('button', { name: 'Save and continue', exact: true }).click(); await expect(page.locator('.asset')).toHaveCount(0); await saved();
  await page.reload(); await expect(page.locator('.asset')).toHaveCount(0); await expect(width).toBeEnabled();
  assert.deepEqual(errors, []);
  console.log(`PASS account fencing and signed-out local save/reload. Evidence: ${output}`);
} finally { await browser?.close(); await web.close(); await service.close(); }
