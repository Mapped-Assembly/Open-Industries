import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { chromium, expect, type Page } from '@playwright/test';
import { createServer } from 'vite';
import type { SceneManifest } from '../src/lib/workspace.ts';
import type { GifMetadata } from '../src/lib/gif.ts';

const { GifReader } = createRequire(import.meta.url)('omggif');
const output = process.env.ANIMATION_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'animation-evidence-'));
await mkdir(output, { recursive: true });
const web = await createServer({ envFile: false, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
  'import.meta.env.VITE_FORM_GENERATION_ENABLED': JSON.stringify('false'),
}, server: { host: '127.0.0.1', port: 4181, strictPort: true } });
let browser;
async function downloaded(page: Page, action: () => Promise<unknown>, name: string) {
  const event = page.waitForEvent('download'); await action();
  const path = join(output, name); await (await event).saveAs(path); return readFile(path);
}
try {
  await web.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.ASTRA_CHROME_PATH ? { executablePath: process.env.ASTRA_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [], external: string[] = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.pathname === '/animation-storage-test') return route.fulfill({ contentType: 'text/html', body: '<title>Draft persistence test</title>' });
    if (url.hostname === '127.0.0.1') return route.continue();
    external.push(url.href); return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://127.0.0.1:4181');
  await expect(page).toHaveTitle('Mergence — Spatial Workbench');
  assert.equal(new URL(page.url()).pathname, '/');
  await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
  await page.getByRole('button', { name: 'New room', exact: true }).click();
      await page.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
  const source = { hardware_ir_version: '0.2', overview: { title: 'Visibility machine' }, mechanical: { render_dimensions: { x_mm: 1000, y_mm: 1000, z_mm: 1000 } } };
  await page.getByLabel('Import files').setInputFiles({ name: 'machine.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(source)) });
  await expect(page.locator('.asset')).toHaveCount(1);
  await page.getByLabel('Animation duration').fill('2');
  await page.getByLabel('Loop playback').uncheck();
  const visible = page.getByLabel('Keyframe visible', { exact: true });
  const seek = async (time: number) => { await page.getByLabel('Keyframe time', { exact: true }).fill(String(time)); };
  const key = async (time: number, show: boolean) => {
    await seek(time); await visible.setChecked(show);
    await page.getByRole('button', { name: 'Add / update keyframe', exact: true }).click();
  };
  await key(0, true); await key(1, false); await key(1.5, true);
  await expect(page.locator('.keyframe')).toHaveCount(3);
  // Edit at the same time; deleting a visibility key restores the previous held value.
  await key(1, true); await seek(1.25); await expect(visible).toBeChecked();
  await key(1, false); await seek(1.25); await expect(visible).not.toBeChecked();
  await page.getByRole('button', { name: 'Delete keyframe at 1 seconds', exact: true }).click();
  await expect(visible).toBeChecked(); await key(1, false);
  await expect(page.locator('.keyframe')).toHaveCount(3);
  for (const [time, expected] of [[.5, true], [1, false], [1.25, false], [1.5, true]] as const) {
    await seek(time); await expect(visible).toBeChecked({ checked: expected });
    await expect(page.locator('.placement').getByLabel('Visible', { exact: true })).toBeChecked();
  }
  await page.getByLabel('Animation target').selectOption('0');
  await expect(visible).toHaveCount(0);
  await page.getByLabel('Animation target').selectOption('-1');
  await page.getByRole('button', { name: 'Reset to base layout', exact: true }).click();
  await expect(visible).toBeChecked();
  await expect(page.locator('.timeline')).toContainText('Base layout');
  await page.getByRole('button', { name: 'Play animation', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause animation', exact: true })).toBeVisible();
  await expect(page.getByLabel('Keyframe time', { exact: true })).toHaveValue('2', { timeout: 10000 });
  await expect(page.getByRole('button', { name: 'Play animation', exact: true })).toBeVisible();
  await seek(.5);
  await page.getByRole('button', { name: 'Animate', exact: true }).click();
  await page.screenshot({ path: join(output, 'desktop-visible-key.png') });
  await seek(1.25);
  await page.screenshot({ path: join(output, 'desktop-hidden-key.png') });
  const exported: SceneManifest = JSON.parse(String(await downloaded(page, () => page.getByRole('button', { name: 'Export scene JSON', exact: true }).click(), 'room.json')));
  assert.deepEqual(exported.animation.tracks[0].keys.map(k => k.visible), [true, false, true]);
  assert.equal(exported.instances[0].visible, true);
  assert.deepEqual(exported.bundledAssets![0].formProject!.ir, source);
  await expect(page.getByRole('status', { name: 'Local draft status' })).toHaveText('Local draft saved');
  await page.reload();
  await expect(page.locator('.asset')).toHaveCount(1);
  await expect(page.locator('.keyframe')).toHaveCount(3);
  await seek(1); await expect(visible).not.toBeChecked();
  await page.getByLabel('Import files').setInputFiles(join(output, 'room.json'));
  await page.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
  await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
  await page.locator('.asset').first().click();
  await expect(page.locator('.keyframe')).toHaveCount(3);
  await seek(1); await expect(visible).not.toBeChecked();

  await page.getByRole('button', { name: 'GIF studio', exact: true }).click();
  const studio = page.getByRole('region', { name: 'GIF studio', exact: true });
  await studio.getByLabel('GIF resolution').selectOption('320');
  await studio.getByLabel('Frame rate').selectOption('10');
  await studio.getByLabel('Export scope').selectOption('asset');
  await studio.getByLabel('Preview motion').selectOption('animation');
  await studio.getByLabel('Animation export end').fill('2');
  await studio.getByRole('button', { name: 'Render GIF', exact: true }).click();
  await expect(studio.getByRole('status', { name: 'GIF export status' })).toContainText('GIF ready', { timeout: 60000 });
  await expect(studio.locator('.capture-result')).toContainText('plays once');
  const metadata: GifMetadata = JSON.parse(String(await downloaded(page, () => studio.getByRole('link', { name: 'Download review metadata', exact: true }).click(), 'visibility-gif.json')));
  assert.equal(metadata.motion, 'animation'); assert.match(metadata.note, /Authored timeline/);
  assert.deepEqual(metadata.animation, exported.animation);
  assert.equal(metadata.frameCount, 20);
  assert.deepEqual(metadata.frames!.map(f => f.instances[0].visible), Array.from({ length: 20 }, (_, i) => i < 10 || i >= 15));
  const gif = new GifReader(await downloaded(page, () => studio.getByRole('link', { name: 'Download GIF', exact: true }).click(), 'visibility.gif'));
  assert.equal(gif.numFrames(), 20); assert.equal(gif.loopCount(), null);
  const frames = [0, 10, 11, 15].map(i => { const pixels = Buffer.alloc(320 * 320 * 4); gif.decodeAndBlitFrameRGBA(i, pixels); return pixels; });
  assert(!frames[0].equals(frames[1]), 'Hidden geometry must disappear in encoded pixels');
  assert(frames[1].equals(frames[2]), 'Hidden frames must stay hidden');
  assert(frames[0].equals(frames[3]), 'Showing the instance must restore its geometry');
  await page.screenshot({ path: join(output, 'authored-gif.png') });
  await studio.getByLabel('Preview motion').selectOption('sample');
  await expect(studio).toContainText('Synthetic demonstration motion');
  await page.getByRole('button', { name: 'Close GIF studio' }).click();
  // A repeated source gets its own identity, base visibility, and track selection.
  await page.locator('.placement').getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('.asset')).toHaveCount(2);
  await page.locator('.asset').last().click();
  await expect(page.locator('.timeline')).toContainText('No keyframes for this target yet.');
  await expect(visible).toBeChecked();
  await key(0, false);
  await expect(page.locator('.keyframe')).toHaveCount(1);
  await page.locator('.asset').first().click();
  await expect(page.locator('.keyframe')).toHaveCount(3);
  await seek(1); await expect(visible).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Animate', exact: true }).click();
  await visible.scrollIntoViewIfNeeded();
  await expect(visible).toBeVisible();
  await key(1, true); await key(1, false);
  await page.screenshot({ path: join(output, 'mobile-key-editor.png') });

  // Test persisted room/account separation without involving #43's transition races.
  const storagePage = await context.newPage();
  await storagePage.goto('http://127.0.0.1:4181/animation-storage-test');
  const saved = await storagePage.evaluate(async document => {
    const { hydrateManifest, readManifest, evaluateWorkspace } = await import('/src/lib/workspace.ts');
    const { saveWorkspaceDraft, loadWorkspaceDraft } = await import('/src/lib/workspace-draft.ts');
    const { saveActiveRoom, saveScene } = await import('/src/lib/scene-storage.ts');
    const a = hydrateManifest(readManifest(document), []), b = structuredClone(a);
    b.animation.tracks[0].keys.forEach(k => { k.visible = !k.visible; });
    await saveWorkspaceDraft(a, 'animation-owner', 'room-a');
    await saveWorkspaceDraft(b, 'animation-owner', 'room-b');
    await saveWorkspaceDraft(a, 'other-owner', 'room-b');
    const second = await loadWorkspaceDraft('animation-owner');
    await saveActiveRoom('animation-owner', 'room-a');
    const first = await loadWorkspaceDraft('animation-owner');
    const other = await loadWorkspaceDraft('other-owner');
    const item = a.items[0];
    await saveScene({ schemaVersion: 1, id: 'legacy', source: {}, room: { width: 6, depth: 5, height: 3 },
      instances: [{ id: item.id, name: item.name, assetId: item.asset.id, position: item.position, rotation: item.rotation, visible: true }],
      animation: { durationSeconds: 2, fps: 10, tracks: [{ instanceId: item.id, keyframes: [{ timeSeconds: 0 }, { timeSeconds: 1, visible: false }, { timeSeconds: 1.5, visible: true }] }] },
    }, [item.asset], 'legacy-owner:legacy-room');
    await saveActiveRoom('legacy-owner', 'legacy-room');
    const legacy = await loadWorkspaceDraft('legacy-owner');
    return { first: first!.workspace.animation, second: second!.workspace.animation, other: other!.workspace.animation,
      ids: [first!.roomId, second!.roomId], legacyVisible: evaluateWorkspace(legacy!.workspace.items, legacy!.workspace.animation, 1.25)[0].visible };
  }, exported);
  assert.deepEqual(saved.first, exported.animation);
  assert.deepEqual(saved.other, exported.animation);
  assert.deepEqual(saved.ids, ['room-a', 'room-b']);
  assert.deepEqual(saved.second.tracks[0].keys.map(k => k.visible), [false, true, false]);
  assert.equal(saved.legacyVisible, false);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(`PASS browser key CRUD, scrubbing/playback, base/source immutability, reload/import, independent instances/room drafts, legacy visibility, encoded GIF pixels, desktop/mobile UI. Evidence: ${output}`);
} finally { await browser?.close(); await web.close(); }
