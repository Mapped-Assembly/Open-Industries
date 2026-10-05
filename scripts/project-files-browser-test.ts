import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { readFormDocument } from '../src/lib/form.ts';

const output = process.env.OI_PROJECT_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'oi-project-'));
await mkdir(output, { recursive: true });
const realGeneration = process.env.OI_REAL_GENERATION === 'true';
const api = realGeneration ? spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: '8799' }, stdio: ['ignore', 'pipe', 'pipe'] }) : undefined;
const web = await createServer({ envFile: false, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
  'import.meta.env.VITE_FORM_GENERATION_ENABLED': JSON.stringify('true'),
}, server: { host: '127.0.0.1', port: 4186, strictPort: true, proxy: { '/api': realGeneration ? 'http://127.0.0.1:8799' : 'http://127.0.0.1:8787' } } });
let browser;
try {
  if (api) await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local Forma API did not start')), 10_000);
    api.on('error', error => { clearTimeout(timer); reject(error); });
    api.on('exit', code => { clearTimeout(timer); reject(new Error(`Local API exited: ${code}`)); });
    api.stdout!.on('data', chunk => { if (String(chunk).includes('Mergence server:')) { clearTimeout(timer); resolve(); } });
    api.stderr!.resume();
  });
  await web.listen();
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...(process.env.ASTRA_CHROME_PATH ? { executablePath: process.env.ASTRA_CHROME_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '', contentType: 'text/css' }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  if (!realGeneration) {
    const fixture = JSON.parse(await readFile('scripts/fixtures/form-workflows/sdk/project-ir.json', 'utf8'));
    await page.route('**/api/health', route => route.fulfill({ json: { available: true, message: 'Form is ready' } }));
    await page.route('**/api/generations', route => { assert.equal(route.request().postDataJSON().mode, 'simulation'); return route.fulfill({ status: 202, json: { id: 'test-job' } }); });
    await page.route('**/api/generations/test-job', route => route.fulfill({ json: { status: 'succeeded', project: fixture } }));
  }
  await page.goto('http://127.0.0.1:4186');
  await expect(page).toHaveTitle(/Mergence/);
  await expect(page.getByRole('button', { name: 'Import OI project', exact: true })).toBeEnabled();
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'New room', exact: true }).click();
  await page.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
  await expect(page.locator('.asset')).toHaveCount(0);
  await page.getByRole('button', { name: 'Generate Forma project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Build and import' })).toBeEnabled();
  await page.getByLabel('Generation mode').selectOption('live');
  await expect(page.getByRole('button', { name: 'Build and import' })).toBeDisabled();
  await page.getByLabel('Model', { exact: true }).fill('test-model');
  await expect(page.getByRole('button', { name: 'Build and import' })).toBeEnabled();
  await page.getByLabel('Generation mode').selectOption('simulation');
  await page.getByRole('button', { name: 'Build and import' }).click();
  await expect(page.locator('footer [role=status]')).toContainText('Form simulation project imported', { timeout: 90_000 });
  await expect(page.locator('.asset')).toHaveCount(1);
  const download = async (button: string, filename: string) => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: button, exact: true }).click();
    const result = await pending;
    assert.match(result.suggestedFilename(), /\.(oi|forma)\.json$/);
    const path = join(output, filename); await result.saveAs(path);
    return { path, json: JSON.parse(await readFile(path, 'utf8')) };
  };
  const forma = await download('Export selected Forma project', 'equipment.forma.json');
  const doc = readFormDocument(forma.json, 'equipment.forma.json');
  assert.ok(doc.project.ir.bom?.length, 'Generated project retains BOM');
  const placement = page.locator('.placement').first();
  await placement.getByLabel(`${doc.name} X position`, { exact: true }).fill('1.5');
  await placement.getByLabel(`${doc.name} Y rotation`, { exact: true }).fill('45');
  await page.getByLabel('Width', { exact: true }).fill('9');
  await page.getByLabel('Keyframe time').fill('1');
  await page.getByLabel('Keyframe position X', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Add / update keyframe', exact: true }).click();
  await placement.getByRole('button', { name: 'Duplicate', exact: true }).click();
  const oi = await download('Export OI project', 'project.oi.json');
  assert.equal(oi.json.instances.length, 2);
  assert.equal(oi.json.bundledAssets.length, 1);
  assert.equal(oi.json.animation.tracks.length, 1);
  assert.equal(oi.json.instances[0].position[0], 1.5);
  await page.getByRole('button', { name: 'Generate Forma project', exact: true }).click();
  await page.locator('#workspace-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: join(output, 'oi-project-desktop.png') });
  // Exports are on disk; stop the source WebGL loop before booting another renderer.
  await context.close();

  // A clean browser context proves the export does not rely on the original cache/login.
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await fresh.route('https://fonts.googleapis.com/**', route => route.fulfill({ body: '', contentType: 'text/css' }));
  const reopened = await fresh.newPage();
  reopened.on('pageerror', error => errors.push(error.message));
  await reopened.goto('http://127.0.0.1:4186');
  await expect(reopened.getByRole('button', { name: 'Import OI project', exact: true })).toBeEnabled();
  await reopened.getByLabel('Import OI project file', { exact: true }).setInputFiles(oi.path);
  await reopened.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
  await expect(reopened.locator('.asset')).toHaveCount(2);
  await expect(reopened.getByLabel('Width', { exact: true })).toHaveValue('9');
  await reopened.locator('.asset').first().click();
  await expect(reopened.getByLabel(`${doc.name} X position`, { exact: true })).toHaveValue('1.5');
  const again = reopened.waitForEvent('download');
  await reopened.getByRole('button', { name: 'Export OI project', exact: true }).click();
  const againPath = join(output, 'reopened.oi.json'); await (await again).saveAs(againPath);
  assert.deepEqual(JSON.parse(await readFile(againPath, 'utf8')), oi.json);
  await reopened.getByLabel('Import OI project file', { exact: true }).setInputFiles(forma.path);
  await expect(reopened.getByRole('alert')).toContainText('Choose an exported OI project');
  await expect(reopened.locator('.asset')).toHaveCount(2);
  await reopened.getByLabel('Import OI project file', { exact: true }).setInputFiles({ name: 'bad.oi.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(reopened.locator('.asset')).toHaveCount(2);
  await reopened.getByLabel('Import files', { exact: true }).setInputFiles(forma.path);
  await expect(reopened.locator('.asset')).toHaveCount(3);
  await expect(reopened.getByRole('alert')).toHaveCount(0);
  // Unavailable API must show an actionable status, retain the project, and recover.
  await reopened.route('**/api/health', route => route.fulfill({ body: '<html>Static deployment</html>', contentType: 'text/html' }));
  await reopened.getByRole('button', { name: 'Generate Forma project', exact: true }).click();
  await expect(reopened.getByLabel('Forma availability')).toContainText('unavailable on this deployment');
  await expect(reopened.getByRole('button', { name: 'Build and import' })).toBeDisabled();
  await reopened.route('**/api/health', route => route.fulfill({ json: { available: true, message: 'Form is ready' } }));
  await reopened.getByRole('button', { name: 'Check again', exact: true }).click();
  await expect(reopened.getByRole('button', { name: 'Build and import' })).toBeEnabled();
  await reopened.route('**/api/generations', route => route.fulfill({ status: 202, json: { id: 'failed-job' } }));
  await reopened.route('**/api/generations/failed-job', route => route.fulfill({ json: { status: 'failed', message: 'Provider unavailable' } }));
  await reopened.getByRole('button', { name: 'Build and import' }).click();
  await expect(reopened.getByRole('alert')).toContainText('Provider unavailable');
  await expect(reopened.locator('.asset')).toHaveCount(3);
  await expect(reopened.getByRole('button', { name: 'Export OI project', exact: true })).toBeEnabled();
  await reopened.getByRole('button', { name: 'Dismiss error' }).click();
  await reopened.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await reopened.getByRole('button', { name: 'Export selected Forma project', exact: true }).scrollIntoViewIfNeeded();
  await reopened.screenshot({ path: join(output, 'oi-project-mobile.png') });
  assert.deepEqual(errors, []);
  await fresh.close();
  console.log(`PASS ${realGeneration ? 'real local Forma' : 'fixture'} generation → Forma JSON → OI export → fresh-browser import, layout/animation/BOM retention, failures, desktop/mobile.`);
} finally {
  await browser?.close(); await web.close();
  api?.kill();
  if (!process.env.OI_PROJECT_EVIDENCE_DIR) await rm(output, { recursive: true, force: true });
}
