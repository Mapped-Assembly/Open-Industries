import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { readFormDocument } from '../src/lib/form.ts';
import type { SceneManifest } from '../src/lib/workspace.ts';

const root = resolve('scripts/fixtures/form-workflows');
const output = process.env.FORM_IMPORT_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'form-workflows-'));
await mkdir(output, { recursive: true });
const folderInputs = await mkdtemp(join(tmpdir(), 'cad-folder-inputs-'));
const web = await createServer({ envFile: false, define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(''),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(''),
  'import.meta.env.VITE_FORM_GENERATION_ENABLED': JSON.stringify('false'),
}, server: { host: '127.0.0.1', port: 4180, strictPort: true } });
let browser;
try {
  await web.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.ASTRA_CHROME_PATH ? { executablePath: process.env.ASTRA_CHROME_PATH } : {}) });
  const cases = [
    { name: 'sdk-legacy', path: 'sdk/project-ir-0.1.json', parts: 5 },
    { name: 'sdk-envelope', path: 'sdk/project-ir.json', parts: 5 },
    { name: 'opencode-folder', path: 'opencode/forma-project.json', parts: 1, cad: true, folder: true },
    { name: 'opencode-step', path: 'opencode/forma-project.json', parts: 1, cad: true },
    { name: 'codex-mixed', path: 'codex/forma-project.json', parts: 2 },
    { name: 'codex-namespace', path: 'codex/project-object.json', parts: 2 },
    { name: 'opencode-missing', path: 'opencode/forma-project.json', parts: 2 },
  ];
  for (const scenario of cases) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [], external: string[] = [], failed: string[] = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      // Font styling is outside the import contract; keep this suite fully offline.
      if (new URL(url).hostname === 'fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
      if (new URL(url).hostname === '127.0.0.1') return route.continue();
      external.push(url); return route.abort();
    });
    try {
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('requestfailed', r => failed.push(r.url()));
      await page.goto('http://127.0.0.1:4180');
      await expect(page).toHaveTitle('OpenIndustries — Spatial Workbench');
      assert.equal(new URL(page.url()).pathname, '/');
      await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
      await page.getByRole('button', { name: 'New room', exact: true }).click();
      await page.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
      const initialCount = scenario.folder ? 2 : 1;
      const paths = [join(root, scenario.path), ...(scenario.cad ? [join(root, 'opencode/models/block.step')] : [])];
      const source = JSON.parse(await readFile(paths[0], 'utf8'));
      const makeFolder = async (name: string, project: unknown, missing = false) => {
        const folder = join(folderInputs, name);
        await mkdir(join(folder, 'models'), { recursive: true });
        await mkdir(join(folder, 'other'), { recursive: true });
        await writeFile(join(folder, 'forma-project.json'), JSON.stringify(project));
        const step = await readFile(join(root, 'opencode/models/block.step'));
        if (!missing) await writeFile(join(folder, 'models/block.step'), step);
        await writeFile(join(folder, 'other/block.step'), Buffer.concat([step, Buffer.from('\n/* Other selected CAD */\n')]));
        return folder;
      };
      const importFolder = async (folder: string) => {
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Import project folder', exact: true }).click();
        await (await chooser).setFiles(folder);
        await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
      };
      let selectedFolder: string | undefined;
      if (scenario.folder) {
        selectedFolder = await makeFolder('Root', source);
        await importFolder(selectedFolder);
      } else await page.getByLabel('Import files').setInputFiles(paths);
      await expect(page.locator('.asset')).toHaveCount(initialCount, { timeout: 30000 });
      await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
      const doc = readFormDocument(source, paths[0]);
      const inspector = page.locator('.inspector');
      await expect(inspector.getByRole('heading', { name: doc.name, exact: true })).toBeVisible();
      const metadata = inspector.locator('details').filter({ has: page.locator('summary', { hasText: /^Form project$/ }) });
      for (const value of [doc.projectId!, doc.project.agent!, doc.project.revision!]) await expect(metadata).toContainText(value);
      await expect(inspector.locator('.part-select')).toHaveCount(scenario.parts);
      await inspector.getByText(`Bill of materials (${(doc.project.ir.bom?.length ?? 0)})`, { exact: true }).click();
      await expect(inspector.locator('.bom-row')).toHaveCount((doc.project.ir.bom?.length ?? 0));
      await inspector.getByText('Retained source JSON', { exact: true }).click();
      assert.deepEqual(JSON.parse(await inspector.locator('pre').innerText()), doc.project.ir);
      await inspector.getByText('Retained source JSON', { exact: true }).click();
      for (let i = 0; i < scenario.parts; i++) {
        await inspector.locator('.part-select').nth(i).click();
        await expect(page.getByLabel('Animation target')).toHaveValue(String(i));
        await expect(inspector.locator('.part-select').nth(i).locator('xpath=../..')).toHaveAttribute('open', '');
      }
      // Exercise the actual canvas raycast independently of inspector buttons.
      if (scenario.cad) {
        await page.getByLabel('Animation target').selectOption('-1');
        // Click center after the camera has focused the complete one-part solid.
        const canvas = page.locator('.viewport canvas');
        const box = await canvas.boundingBox(); assert(box);
        await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
        await expect(page.getByLabel('Animation target')).toHaveValue('0');
      }
      if (scenario.name === 'opencode-missing') await expect(inspector).toContainText('Referenced CAD is unavailable');
      await page.getByLabel(`${doc.name} X position`, { exact: true }).fill('2');
      await page.getByLabel(`${doc.name} Y rotation`, { exact: true }).fill('45');
      await page.locator('.placement').first().getByRole('button', { name: 'Duplicate', exact: true }).click();
      await expect(page.locator('.asset')).toHaveCount(initialCount + 1);
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export scene JSON', exact: true }).click();
      const path = join(output, `${scenario.name}.json`); await (await download).saveAs(path);
      const exported: SceneManifest = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(exported.instances.length, initialCount + 1); assert.equal(exported.assets.length, initialCount);
      assert.equal(exported.instances[0].position[0], 2); assert.equal(exported.instances[0].rotation[1], 45);
      assert.notEqual(exported.instances[0].id, exported.instances.at(-1)!.id);
      assert.equal(exported.instances[0].assetId, exported.instances.at(-1)!.assetId);
      assert.deepEqual(exported.bundledAssets![0].formProject, doc.project);
      assert.equal(exported.bundledAssets![0].parts.length, scenario.parts);
      // An import error must preserve the completed scene and allow recovery.
      const invalid = { ...source, hardware_ir_version: '0.3', project_ir: { hardware_ir_version: '0.3' } };
      await page.getByLabel('Import files').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
      await expect(page.getByRole('alert')).toContainText('hardware_ir_version');
      await expect(page.locator('.asset')).toHaveCount(initialCount + 1);
      await expect(page.getByLabel(`${doc.name} X position`, { exact: true })).toHaveValue('2');
      await page.getByLabel('Import files').setInputFiles(path);
      await page.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page.locator('.asset')).toHaveCount(initialCount + 1);
      await expect(page.getByLabel(`${doc.name} X position`, { exact: true })).toHaveValue('2');
      if (scenario.folder) {
        for (const [name, sha256, message] of [
          ['bad-hash', '0'.repeat(64), 'Integrity check failed'],
          ['malformed-hash', false, '64 hexadecimal characters'],
        ] as const) {
          const invalid = structuredClone(source); invalid.artifacts[0].sha256 = sha256;
          await importFolder(await makeFolder(name, invalid));
          await expect(page.getByRole('alert')).toContainText(message);
          await expect(page.locator('.asset')).toHaveCount(initialCount + 1);
          await expect(page.getByLabel(`${doc.name} X position`, { exact: true })).toHaveValue('2');
          await page.screenshot({ path: join(output, `${name}-preserved-scene.png`) });
        }
        await page.getByLabel('Import files').setInputFiles([
          join(selectedFolder!, 'forma-project.json'), join(selectedFolder!, 'models/block.step'), join(selectedFolder!, 'other/block.step'),
        ]);
        await expect(page.getByRole('alert')).toContainText('Multiple files match');
        await expect(page.locator('.asset')).toHaveCount(initialCount + 1);
        await expect(page.getByLabel(`${doc.name} X position`, { exact: true })).toHaveValue('2');
        // With folder paths, a namesake in another directory stays independent.
        await importFolder(await makeFolder('missing-cad', source, true));
        await expect(page.getByRole('alert')).toHaveCount(0);
        await expect(page.locator('.asset')).toHaveCount(initialCount + 3);
        await expect(inspector).toContainText('Referenced CAD is unavailable');
        await expect(inspector.locator('.part-select')).toHaveCount(2);
        // Reopen the saved scene to prove recovery retains source identities/layout.
        await page.getByLabel('Import files').setInputFiles(path);
      await page.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
        await expect(page.locator('.asset')).toHaveCount(initialCount + 1);
        await expect(page.getByLabel(`${doc.name} X position`, { exact: true })).toHaveValue('2');
      }
      await page.locator('.asset').first().click();
      await expect(inspector.locator('.part-select')).toHaveCount(scenario.parts);
      await page.locator('.viewport').scrollIntoViewIfNeeded();
      await expect(page.locator('.viewport canvas')).toBeVisible();
      await page.screenshot({ path: join(output, `${scenario.name}-desktop.png`) });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // The responsive layout hides the inspector; the timeline exposes the same selector.
      await page.getByLabel('Animation target').selectOption(String(scenario.parts - 1));
      await expect(page.getByLabel('Animation target')).toHaveValue(String(scenario.parts - 1));
      await page.locator('.viewport').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(output, `${scenario.name}-mobile.png`) });
      assert.deepEqual(errors, [], `${scenario.name}: browser errors`);
      assert.deepEqual(external, [], `${scenario.name}: unexpected external request`);
      assert.deepEqual(failed, [], `${scenario.name}: failed request`);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      console.log(`PASS browser ${scenario.name}: inspector, selection, placement, export/reopen, error recovery, desktop/mobile`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); await web.close();
  await rm(folderInputs, { recursive: true, force: true });
  if (!process.env.FORM_IMPORT_EVIDENCE_DIR) await rm(output, { recursive: true, force: true });
}
