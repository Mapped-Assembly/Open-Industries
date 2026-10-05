import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importForm, readFormDocument } from '../src/lib/form.ts';
import { parseCloudBundle } from '../src/lib/cloud-storage.ts';
import { scrubPortableData } from '../src/lib/portable-data.mjs';
import { appendAssets, emptyWorkspace, makeManifest, readManifest, hydrateManifest, canonicalJSON } from '../src/lib/workspace.ts';

const runtime = { provider: 'provider-canary', model: 'model-canary', base_url: 'https://endpoint-canary.invalid', api_key: 'credential-canary' };
const ir = {
  hardware_ir_version: '0.2', overview: { title: 'Portable bench' },
  assembly_metadata: { project_id: 'portable-project', revision: 7, source_agent: 'codex', runtime_config: runtime, ...runtime },
  components: [{ ref_des: 'BENCH', name: 'Bench', model: 'Physical model 37' }],
  bom: [{ name: 'Bench assembly', quantity: 1, model: 'Hardware part number' }],
  validation: { warning: [{ description: 'Keep the service aisle clear.' }] },
  cad_model: { model: { meshes: [{ name: 'Bench', ref_des: 'BENCH', vertices: [0, 0, 0, 100, 0, 0, 0, 100, 0], faces: [0, 1, 2] }] } },
};
const manifest = { format: 'form-project', version: 1, project_id: 'portable-project', agent: 'codex', project_ir: ir,
  artifacts: [{ path: 'cad/bench.step', sha256: 'a'.repeat(64), runtimeConfig: runtime }],
  providerConfig: runtime, response_metadata: [{ authentication: { access_token: 'access-canary' }, configuration: runtime }],
};
const namespaced = { object_type: 'form.project', object_id: 'portable-project', version: 7, namespaces: [
  { name: 'project.meta', payload: { hardware_ir_version: '0.2', assembly_metadata: ir.assembly_metadata, ...runtime } },
  { name: 'product.overview', payload: { overview: ir.overview } },
  { name: 'product.mech', payload: { cad_model: ir.cad_model } },
  { name: 'product.electrical', payload: { components: ir.components } },
  { name: 'product.bom', payload: { line_items: ir.bom } },
  { name: 'product.validation', payload: { validation: ir.validation } },
] };
function clean(value: unknown) {
  assert(!JSON.stringify(value).includes('canary'), 'Runtime settings or credentials escaped the artifact boundary');
}
for (const input of [ir, manifest, { response: manifest }, { hardware_ir: ir }, namespaced, { response: { project_object: namespaced } }]) {
  const before = JSON.stringify(input);
  const doc = readFormDocument(input, 'portable.json'); clean(doc);
  assert.equal(JSON.stringify(input), before, 'Import mutated the supplied source');
  assert.equal(doc.project.projectId, 'portable-project'); assert.equal(doc.project.revision, '7'); assert.equal(doc.project.agent, 'codex');
  assert.deepEqual(doc.project.ir.bom, ir.bom); assert.deepEqual(doc.project.ir.validation, ir.validation);
  assert.deepEqual(doc.project.ir.components, ir.components); assert.deepEqual(doc.cad, ir.cad_model);
  assert.equal(importForm(input, 'portable.json', 'original-bytes').parts.length, 1, 'CAD model adapter was stripped');
}
// Aliases, arrays, and unknown wrapper nesting must not reintroduce settings.
const aliases = { response: { result: [{ 'Runtime-Configuration': runtime, LLM_SETTINGS: runtime,
  provider_name: 'provider-canary', modelName: 'model-canary', apiBaseURL: 'endpoint-canary',
  custom: { configuration: runtime }, authoring: { agent: 'sdk', model: 'model-canary' },
  project_id: 'portable-project', revision: 7 }] } };
clean(scrubPortableData(aliases));
assert.deepEqual(scrubPortableData(scrubPortableData(aliases)), scrubPortableData(aliases));

const asset = importForm(manifest, 'portable.json', 'original-bytes');
let workspace = appendAssets(emptyWorkspace(), [asset, asset]);
workspace.room = [12.192, 12.192, 3.048];
workspace.items = workspace.items.map((item, i) => ({ ...item, id: `bench-${i}`, position: [i + 2, 0, -1], rotation: [0, 45, 0], visible: i === 0 }));
workspace.animation = { duration: 2, loop: false, tracks: [{ id: 'bench-0:instance', instanceId: 'bench-0', keys: [
  { id: 'start', time: 0, position: [2, 0, -1], rotation: [0, 45, 0] }, { id: 'end', time: 2, position: [3, 0, -1], rotation: [0, 90, 0] },
] }] };
// Simulate a legacy asset, bypassing the now-sanitized Form importer.
const legacy = structuredClone(asset);
legacy.formProject!.ir.assembly_metadata = structuredClone(ir.assembly_metadata);
legacy.formProject!.sourceDocument = structuredClone(manifest);
const legacyWorkspace = { ...workspace, items: workspace.items.map(item => ({ ...item, asset: legacy })) };
const legacyBefore = JSON.stringify(legacyWorkspace);
const portable = makeManifest(legacyWorkspace, true); clean(portable);
assert.equal(JSON.stringify(legacyWorkspace), legacyBefore);
const reopened = hydrateManifest(readManifest(JSON.parse(JSON.stringify(portable))), []);
assert.equal(canonicalJSON(makeManifest(reopened)), canonicalJSON(makeManifest(workspace)));
assert.deepEqual(reopened.items[0].asset.parts, asset.parts);
assert.deepEqual(reopened.items[0].asset.formProject, asset.formProject);
const legacyBundle = JSON.stringify({ schemaVersion: 1, asset: legacy, previewMetadata: { runtime_config: runtime } });
clean(parseCloudBundle(legacyBundle));
assert(legacyBundle.includes('canary'), 'Parsing must not rewrite immutable source bytes');
const legacyPortable = { ...portable, bundledAssets: [legacy], runtime_config: runtime };
clean(readManifest(legacyPortable)); clean(hydrateManifest(readManifest(legacyPortable), []));
const version = '77777777-7777-4777-8777-777777777777';
const pinned = { ...legacyWorkspace, items: legacyWorkspace.items.map(item => ({ ...item, cloudVersionId: version })) };
const pinnedPortable = makeManifest(pinned, true); clean(pinnedPortable);
assert.deepEqual(hydrateManifest(readManifest(pinnedPortable), []).items.map(item => item.cloudVersionId), [version, version]);

// A failed open/repair is atomic; the matching source restores the exact layout.
const metadataOnly = makeManifest(workspace);
const missing = hydrateManifest(readManifest(metadataOnly), []);
assert(missing.items.every(item => item.missing));
const missingBefore = JSON.stringify(missing);
for (const mutate of [
  (value: typeof asset) => { value.source.digest = 'changed-digest'; },
  (value: typeof asset) => { value.source.version = '0.1'; },
  (value: typeof asset) => { value.formProject!.revision = '8'; },
  (value: typeof asset) => { value.source.projectId = 'different-project'; },
  (value: typeof asset) => { value.formProject!.projectId = 'different-project'; },
]) {
  const changed = structuredClone(asset); mutate(changed);
  assert.throws(() => hydrateManifest(metadataOnly, [changed]), /Source revision mismatch.*Reimport the original/);
  assert.throws(() => appendAssets(missing, [changed]), /Source revision mismatch/);
  assert.equal(JSON.stringify(missing), missingBefore);
}
const repaired = appendAssets(missing, [asset]);
assert(repaired.items.every(item => !item.missing));
assert.equal(canonicalJSON(makeManifest(repaired)), canonicalJSON(metadataOnly));
assert.equal(canonicalJSON(makeManifest(hydrateManifest(metadataOnly, [asset]))), canonicalJSON(metadataOnly));
console.log('PASS nested Form wrappers, retained authoring/CAD/BOM data, legacy and versioned portable bundles, and atomic source revision recovery.');

if (process.argv.includes('--browser')) {
  const { createServer } = await import('vite');
  const { chromium, expect } = await import('@playwright/test');
  // No cloud account or external model provider is used by this local file flow.
  const web = await createServer({ server: { host: '127.0.0.1', port: 4176, strictPort: true } });
  const output = await mkdtemp(join(tmpdir(), 'portable-scene-browser-'));
  let browser;
  try {
    await web.listen();
    browser = await chromium.launch({ headless: true, ...(process.env.ASTRA_CHROME_PATH ? { executablePath: process.env.ASTRA_CHROME_PATH } : {}) });
    const errors: string[] = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const first = await context.newPage(); first.on('pageerror', error => errors.push(error.message));
    await first.goto('http://127.0.0.1:4176');
    await expect(first.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
    const open = async (page: typeof first, value: unknown) => {
      await page.getByLabel('Import files').setInputFiles({ name: 'portable-scene.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) });
      await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
      if (await page.getByRole('dialog', { name: 'Unsaved room changes' }).count()) await page.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
    };
    await open(first, legacyPortable);
    const backup = await first.evaluate(async ({ asset, document }) => {
      const storage = await import('/src/lib/scene-storage.ts');
      await storage.saveScene({ schemaVersion: 1, id: 'portable-backup', source: {},
        room: { width: 12.192, depth: 12.192, height: 3.048 }, instances: [], workspaceDocument: document }, [asset], 'portable-backup');
      return storage.exportStoredDraft('portable-backup');
    }, { asset: legacy, document: metadataOnly });
    clean(backup); assert.equal(backup.assets.length, 1);
    await expect(first.locator('.asset')).toHaveCount(2);
    await expect(first.getByLabel('Width', { exact: true })).toHaveValue('12.192');
    const download = first.waitForEvent('download'); await first.getByRole('button', { name: 'Export scene JSON', exact: true }).click();
    const path = join(output, 'export.json'); await (await download).saveAs(path);
    const exported = JSON.parse(await readFile(path, 'utf8')); clean(exported);
    assert.equal(canonicalJSON(exported), canonicalJSON(portable));
    // A different port is a different browser origin, with an empty device cache.
    const otherWeb = await createServer({ server: { host: '127.0.0.1', port: 4177, strictPort: true } });
    try {
      await otherWeb.listen(); const second = await context.newPage(); second.on('pageerror', error => errors.push(error.message));
      await second.goto('http://127.0.0.1:4177'); await expect(second.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
      await open(second, exported); await expect(second.locator('.asset')).toHaveCount(2);
      await expect(second.locator('.asset').filter({ hasText: 'MISSING' })).toHaveCount(0);
      await expect(second.getByLabel('Width', { exact: true })).toHaveValue('12.192');
      const mismatch = structuredClone(metadataOnly); mismatch.assets[0].projectRevision = '8'; mismatch.room[0] = 20;
      await open(second, mismatch);
      await expect(second.locator('.error')).toContainText('Source revision mismatch');
      await expect(second.getByLabel('Width', { exact: true })).toHaveValue('12.192');
      await expect(second.locator('.asset')).toHaveCount(2);
      await open(second, exported); await expect(second.locator('.error')).toHaveCount(0);
      await second.setViewportSize({ width: 390, height: 844 });
      await expect(second.getByRole('button', { name: 'Export scene JSON', exact: true })).toBeEnabled();
      await expect.poll(() => second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await second.screenshot({ path: join(output, 'portable-scene.png'), fullPage: false });
      assert.deepEqual(errors, []);
      assert.equal(await second.locator('vite-error-overlay').count(), 0);
      console.log('PASS browser export/import across origins, visible mismatch warning without replacing the scene, and successful recovery.');
    } finally { await otherWeb.close(); }
  } finally { await browser?.close(); await web.close(); await rm(output, { recursive: true, force: true }); }
}
