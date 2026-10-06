import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formHealth } from '../../server/form.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const out = resolve(process.argv[2] ?? join(repoRoot, 'deliverables', 'field-lab'));
const port = Number(process.env.FIELD_LAB_VERIFY_PORT ?? 4192);
const host = process.env.FIELD_LAB_HOST ?? '127.0.0.1';
const scenePath = join(out, 'field-lab.oi.json');
const stepPath = existsSync(join(out, 'field-lab-pipette.step'))
  ? join(out, 'field-lab-pipette.step')
  : join(here, 'fixtures', 'field-lab-pipette.step');
const publicRoot = join(out, '.vite-public');
const publicAssets = join(publicRoot, 'field-lab-assets');
await mkdir(publicAssets, { recursive: true });
await copyFile(stepPath, join(publicAssets, 'field-lab-pipette.step'));

const server = await createServer({ root: repoRoot, publicDir: publicRoot, server: { host, port, strictPort: true } });
await server.listen();
let browser;
const errors = [];
const reportPath = join(out, 'capability-report.json');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeCapability = async (entries) => {
  const report = existsSync(reportPath) ? await readJson(reportPath) : { schema: 'field-lab-benchmark/capability-report/v1', statuses: {} };
  report.statuses = { ...(report.statuses ?? {}), ...entries };
  const values = Object.values(report.statuses).map((entry) => entry.status);
  report.summary = Object.fromEntries(['passed', 'failed', 'blocked', 'not-tested'].map((status) => [status, values.filter((value) => value === status).length]));
  await writeFile(reportPath, JSON.stringify(report, null, 2));
};

async function launchBrowser() {
  const configured = process.env.ASTRA_CHROME_PATH?.trim();
  if (configured && !existsSync(configured)) throw new Error(`ASTRA_CHROME_PATH does not exist: ${configured}`);
  return chromium.launch({
    ...(configured ? { executablePath: configured } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
}

try {
  const scene = await readJson(scenePath);
  if (scene.instances?.length !== 21 || scene.animation?.tracks?.length !== 8) {
    throw new Error(`Expected 21 scene instances and 8 animation tracks; found ${scene.instances?.length ?? 0} and ${scene.animation?.tracks?.length ?? 0}.`);
  }
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://${host}:${port}`);
  await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
  await page.getByLabel('Import files').setInputFiles(scenePath);
  await expect(page.getByRole('button', { name: /Drop files or browse/ })).toBeEnabled();
  if (await page.getByRole('dialog', { name: 'Unsaved room changes' }).count()) {
    await page.getByRole('dialog', { name: 'Unsaved room changes' }).getByRole('button', { name: 'Discard and continue' }).click();
  }
  await expect(page.locator('.asset')).toHaveCount(21, { timeout: 30000 });
  await expect(page.locator('.asset').filter({ hasText: 'MISSING' })).toHaveCount(0);
  await page.screenshot({ path: join(out, 'native-workbench-import.png') });

  const step = await page.evaluate(async () => {
    const { convertStep, stepToAsset } = await import('/src/lib/step.ts');
    const { digestBytes } = await import('/src/lib/scene.ts');
    const bytes = await (await fetch('/field-lab-assets/field-lab-pipette.step')).arrayBuffer();
    const digest = await digestBytes(bytes);
    const asset = stepToAsset(await convertStep(bytes, () => {}), 'field-lab-pipette.step', digest, { upAxis: 'Z', scale: 1 });
    return { parts: asset.parts.length, dimensions: asset.dimensions, source: asset.source, triangles: asset.parts.reduce((total, part) => total + part.indices.length / 3, 0) };
  });
  expect(step.parts).toBeGreaterThan(50);
  expect(step.dimensions[0]).toBeCloseTo(1.12, 2);
  expect(step.dimensions[2]).toBeCloseTo(0.76, 2);
  const health = await formHealth(repoRoot);
  await writeFile(join(out, 'integration-checks.json'), JSON.stringify({
    nativeUiImport: { instances: 21, missingGeometry: 0, animationTracks: 8, passed: true },
    nativeStepWorker: step,
    formGenerationBridge: health,
    evidenceBoundary: { kinematics: 'passed', perception: 'not-tested', physicalEvidence: 'not-tested' },
    errors,
  }, null, 2));
  await writeCapability({
    nativeUiImport: { status: 'passed', detail: 'Native import rendered all 21 instances with zero missing geometry and eight animation tracks.', evidence: ['native-workbench-import.png'] },
    stepWorker: { status: 'passed', detail: `OpenCascade worker converted the STEP fixture to ${step.parts} parts with dimensions ${step.dimensions.join(' × ')} m.`, evidence: ['integration-checks.json'] },
    formGenerationBridge: { status: health.available ? 'passed' : 'blocked', detail: health.available ? 'Live Form bridge is available.' : (health.message ?? 'Live Form bridge was not exercised.'), evidence: ['integration-checks.json'] },
  });
  expect(errors).toEqual([]);
  console.log('PASS native workbench import / no missing geometry / eight animation tracks / actual STEP worker conversion');
  console.log('Form health:', JSON.stringify(health));
} catch (error) {
  await writeCapability({ nativeUiImport: { status: 'failed', detail: String(error), evidence: ['integration-checks.json'] } });
  console.error(error);
  throw error;
} finally {
  if (browser) await browser.close();
  await server.close();
}
