import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createClient, type Session } from '@supabase/supabase-js';
import { chromium, expect } from '@playwright/test';
import { CloudStorage, CLOUD_BUCKET, CLOUD_FILE_LIMIT } from '../src/lib/cloud-storage.ts';
import { importForm } from '../src/lib/form.ts';
import { digestBytes } from '../src/lib/scene.ts';
import { stepToAsset } from '../src/lib/step.ts';
import { createRequire } from 'node:module';
const { GIFEncoder } = createRequire(import.meta.url)('gifenc');

const url = process.env.SUPABASE_TEST_URL || 'https://mrhxfmtofvrgfaikllfw.supabase.co';
const key = process.env.SUPABASE_TEST_PUBLIC_KEY;
const adminKey = process.env.SUPABASE_TEST_ADMIN_KEY;
if (!key || !adminKey) throw new Error('Set SUPABASE_TEST_PUBLIC_KEY and SUPABASE_TEST_ADMIN_KEY for the test project. Keys are never printed.');
const admin = createClient(url, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });
const users: { id: string; store: CloudStorage; session: Session }[] = [];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const scenes: string[] = [];
const prefix = `astra-storage-${randomUUID()}`;
const authOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
async function newUser() {
  const email = `${prefix}-${users.length}@example.invalid`;
  const password = `Mergence-${randomUUID()}!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { user_name: 'astra-storage-test' } });
  if (error || !data.user) throw new Error(`Test user setup failed: ${error?.message}`);
  const client = createClient(url, key!, authOptions);
  // Register for cleanup before trying sign-in.
  const user = { id: data.user.id, store: new CloudStorage(client, data.user.id), session: null as unknown as Session };
  users.push(user);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) throw new Error('Test user sign-in failed');
  user.session = signedIn.data.session;
  return user;
}
async function userPage(session: Session) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ storageKey, session }) => localStorage.setItem(storageKey, JSON.stringify(session)), {
    storageKey: `sb-${new URL(url).hostname.split('.')[0]}-auth-token`, session,
  });
  const page = await context.newPage();
  page.on('pageerror', error => { throw error; });
  await page.goto(process.env.ASTRA_BASE_URL || 'http://127.0.0.1:8787');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'GIF studio', exact: true }).click();
  await page.getByRole('button', { name: /Asset library/ }).click();
  return { page, context, cloud: page.getByRole('region', { name: 'Cloud asset storage' }) };
}
try {
  const a = await newUser(); const b = await newUser();
  const { page, cloud, context } = await userPage(a.session);
  const fixture = { hardware_ir_version: '0.2', overview: { title: prefix },
    assembly_metadata: { api_key: 'DO_NOT_UPLOAD_TEST', credential: 'DO_NOT_UPLOAD_TEST' },
    mechanical: { render_dimensions: { x_mm: 1800, y_mm: 800, z_mm: 900 } } };
  await page.locator('input[aria-label="Import files"]').setInputFiles({ name: 'cloud-test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.getByRole('button', { name: 'Save selected asset to library' }).click();
  await page.getByLabel('GIF resolution').selectOption('320');
  await page.locator('.capture-panel').getByLabel('Duration').selectOption('2');
  const card = page.getByRole('article', { name: prefix, exact: true });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Render turntable' }).click();
  await expect(page.getByRole('status', { name: 'GIF export status' })).toContainText('preview saved', { timeout: 90000 });
  await cloud.getByRole('button', { name: 'Upload cloud copy' }).click();
  await expect.poll(async () => {
    if (await cloud.getByRole('alert').count()) throw new Error(await cloud.getByRole('alert').innerText());
    return await cloud.getByRole('status').innerText();
  }, { timeout: 90000 }).toContain('Cloud copy ready');
  await expect(cloud.getByRole('article')).toHaveCount(1);
  await cloud.getByRole('button', { name: 'Upload cloud copy' }).click();
  await expect(cloud.getByRole('status')).toContainText('Cloud copy ready', { timeout: 60000 });
  const versions = await a.store.list(); assert.equal(versions.length, 1);
  const version = versions[0]; assert.equal(version.state, 'ready');
  const bundle = await a.store.downloadFile(version, 'asset.json');
  assert.equal((await bundle.text()).includes('DO_NOT_UPLOAD_TEST'), false);
  const loaded = await a.store.load(version); assert(loaded.preview); assert.equal(loaded.asset.name, prefix);
  console.log('PASS actual authenticated UI upload, GIF storage, ready lifecycle, deduplication, and credential-field exclusion.');

  const second = await userPage(a.session);
  await expect(second.cloud.getByRole('article')).toHaveCount(1);
  await second.cloud.getByRole('button', { name: 'Load cloud asset into room' }).click();
  await expect(second.page.locator('.asset')).toHaveCount(1, { timeout: 60000 });
  await expect(second.cloud.getByAltText('Verified cloud GIF preview')).toBeVisible();
  await second.page.getByLabel(`${prefix} X position`, { exact: true }).fill('2');
  await expect(second.page.getByLabel(`${prefix} X position`, { exact: true })).toHaveValue('2');
  await mkdir('test-results', { recursive: true });
  await second.page.screenshot({ path: 'test-results/13-cloud-library-after.png' });
  await second.page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => second.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await second.page.screenshot({ path: 'test-results/13-cloud-library-mobile.png', fullPage: true });
  await second.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(second.cloud.getByRole('article')).toHaveCount(0);
  await expect(second.cloud.getByAltText('Verified cloud GIF preview')).toHaveCount(0);
  await second.context.close();
  console.log('PASS separate browser geometry/GIF retrieval, editable cloud instance, and cloud UI cleared on sign-out.');

  const path = a.store.path(version, version.files[0]);
  assert.equal((await b.store.list()).length, 0);
  assert((await b.store.client.storage.from(CLOUD_BUCKET).download(path)).error);
  assert((await b.store.client.storage.from(CLOUD_BUCKET).upload(path, new Blob(['forged']), { contentType: 'application/json' })).error);
  await b.store.client.storage.from(CLOUD_BUCKET).remove([path]);
  assert((await a.store.downloadFile(version, version.files[0].name)).size > 0);
  assert((await b.store.client.rpc('begin_asset_file_delete', { p_id: version.id })).error);
  assert((await a.store.client.from('asset_file_versions').update({ state: 'deleting' }).eq('id', version.id)).error);
  assert((await a.store.client.storage.from(CLOUD_BUCKET).upload(path, new Blob(['overwrite']), { upsert: true, contentType: 'application/json' })).error);
  const anon = createClient(url, key!, authOptions);
  assert((await anon.storage.from(CLOUD_BUCKET).download(path)).error);
  const signed = await a.store.client.storage.from(CLOUD_BUCKET).createSignedUrl(path, 1);
  assert.equal(signed.error, null); assert(signed.data);
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal((await fetch(signed.data.signedUrl)).ok, false);
  console.log('PASS cross-user/anonymous storage denial, protected lifecycle, immutable files, and expired signed URL.');

  const sceneId = crypto.randomUUID();
  const assetKey = version.asset?.asset_key ?? version.asset_id;
  const sceneDocument = { format: 'astra.scene', version: 1, units: 'm', upAxis: 'Y', room: [6, 5, 3],
    assets: [{ id: assetKey, name: prefix, source: { kind: 'form', filename: 'cloud-test.json', digest: version.fingerprint }, dimensions: [1, 1, 1], projectRevision: undefined }],
    instances: [{ id: crypto.randomUUID(), name: prefix, assetId: assetKey, position: [0, 0, 0], rotation: [0, 0, 0], visible: true, cloudVersionId: version.id }],
    animation: { duration: 3, loop: true, tracks: [] } };
  const scene = await a.store.client.rpc('save_workspace_scene', { p_id: sceneId, p_name: prefix, p_document: sceneDocument, p_expected_revision: 0, p_write_id: crypto.randomUUID() });
  assert.equal(scene.error, null); scenes.push(sceneId);
  await assert.rejects(() => a.store.remove(version), /referenced by a saved scene/);
  const deletes = await a.store.client.storage.from(CLOUD_BUCKET).remove([path]);
  assert(!deletes.data?.length); // No DELETE policy while still referenced/ready.
  assert.equal((await a.store.client.rpc('delete_workspace_scene', { p_id: sceneId, p_expected_revision: 1 })).error, null);
  assert((await a.store.downloadFile(version, version.files[0].name)).size > 0);
  console.log('PASS saved-scene reference protects shared files; scene deletion retains the asset.');

  const rawAsset = importForm(fixture, 'retry.json', prefix + '-retry');
  const gif = GIFEncoder(); gif.writeFrame(new Uint8Array([0,1,1,0]), 2, 2, { palette: [[0,0,0],[255,255,255]], delay: 100 }); gif.finish();
  const retryEntry = { id: rawAsset.id, asset: rawAsset, updatedAt: Date.now(), preview: new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' }) };
  let failedOnce = false;
  const interrupted = createClient(url, key!, { ...authOptions, global: {
    headers: { Authorization: `Bearer ${a.session.access_token}` },
    fetch: (input, init) => {
      if (!failedOnce && String(input).includes('/preview.gif') && init?.method === 'POST') { failedOnce = true; return Promise.resolve(new Response(JSON.stringify({ message: 'Simulated interruption' }), { status: 503, headers: { 'Content-Type': 'application/json' } })); }
      return fetch(input, init);
    },
  } });
  await assert.rejects(() => new CloudStorage(interrupted, a.id).upload(retryEntry, () => {}));
  assert(failedOnce); const pending = (await a.store.list()).find(v => v.state === 'pending'); assert(pending);
  assert((await a.store.client.rpc('finish_asset_upload', { p_id: pending.id })).error);
  const resumed = await a.store.upload(retryEntry, () => {}); assert.equal(resumed.state, 'ready');
  assert.equal((await a.store.list()).length, 2);
  assert((await a.store.load(resumed)).preview);
  await assert.rejects(() => a.store.upload({ ...retryEntry, preview: new Blob([new Uint8Array(CLOUD_FILE_LIMIT + 1)]) }, () => {}), /25 MiB/);
  const invalidManifest = await a.store.client.rpc('prepare_asset_upload', { p_asset_key: prefix, p_name: prefix, p_source_kind: 'step', p_metadata: {}, p_files: [{ name: '../escape', mime: 'application/json', size: 3, sha256: '0'.repeat(64) }] });
  assert(invalidManifest.error);
  const oversizedManifest = await a.store.client.rpc('prepare_asset_upload', { p_asset_key: prefix, p_name: prefix, p_source_kind: 'step', p_metadata: {}, p_files: [{ name: 'asset.json', mime: 'application/json', size: CLOUD_FILE_LIMIT + 1, sha256: '0'.repeat(64) }] });
  assert(oversizedManifest.error);
  console.log('PASS interrupted upload resumes existing intent, previous files verified, invalid paths and oversized payloads rejected.');

  // Tampered descriptors must never silently load wrong bytes.
  const tampered = structuredClone(version); tampered.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(() => a.store.downloadFile(tampered, tampered.files[0].name), /integrity/);
  await cloud.getByRole('button', { name: 'Refresh cloud list' }).click();
  await expect(cloud.getByRole('article')).toHaveCount(2);
  await cloud.getByRole('article').filter({ hasText: version.id.slice(0,8) }).getByRole('button', { name: 'Remove cloud copy' }).click();
  await expect(cloud.getByRole('article')).toHaveCount(1, { timeout: 60000 });
  assert((await a.store.client.storage.from(CLOUD_BUCKET).info(path)).error);
  await expect(card).toBeVisible(); // Removing cloud files doesn't delete the device library.
  console.log('PASS integrity failure and actual cloud deletion retaining local data.');
  const deleting = await a.store.client.rpc('begin_asset_file_delete', { p_id: resumed.id });
  assert.equal(deleting.error, null);
  assert((await a.store.client.rpc('finish_asset_file_delete', { p_id: resumed.id })).error);
  await a.store.client.storage.from(CLOUD_BUCKET).remove([a.store.path(resumed, resumed.files[0])]);
  await a.store.remove(resumed); // The already-missing first file does not prevent cleanup.
  assert.equal((await a.store.list()).length, 0);
  console.log('PASS interrupted removal retains its intent until remaining objects are removed.');

  const stepResponse = await fetch('https://raw.githubusercontent.com/kovacsv/occt-import-js/master/test/testfiles/simple-basic-cube/cube.stp');
  assert(stepResponse.ok);
  const stepBytes = await stepResponse.arrayBuffer();
  const occt = await createRequire(import.meta.url)('occt-import-js')();
  const stepAsset = stepToAsset(occt.ReadStepFile(new Uint8Array(stepBytes), { linearUnit: 'millimeter' }), 'cube.stp', await digestBytes(stepBytes), { upAxis: 'Z', scale: 1 });
  const source = new File([stepBytes], 'cube.stp');
  const withSource = await a.store.upload({ id: stepAsset.id, asset: stepAsset, updatedAt: Date.now() }, () => {}, source);
  assert.equal(await digestBytes(await (await a.store.downloadFile(withSource, 'source.step')).arrayBuffer()), stepAsset.source.digest);
  await assert.rejects(() => a.store.upload({ id: stepAsset.id, asset: stepAsset, updatedAt: Date.now() }, () => {}, new File(['wrong'], 'cube.stp')), /does not match/);
  console.log('PASS actual original STEP source storage and source-integrity mismatch rejection.');
  await context.close();
} finally {
  await browser.close();
  for (const user of users) {
    for (const id of scenes) await user.store.client.from('scenes').delete().eq('id', id);
    if (user.session) {
      for (const version of await user.store.list()) await user.store.remove(version);
      await user.store.client.from('assets').delete().eq('owner_id', user.id);
    }
    const deleted = await admin.auth.admin.deleteUser(user.id);
    if (deleted.error) throw new Error(`Test user cleanup failed: ${deleted.error.message}`);
  }
  console.log('Test users and storage records cleaned up.');
}
