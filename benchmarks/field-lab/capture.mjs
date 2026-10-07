import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const out = resolve(process.argv[2] ?? join(repoRoot, 'deliverables', 'field-lab'));
const mode = process.argv[3] ?? 'preview';
const port = Number(process.env.FIELD_LAB_CAPTURE_PORT ?? 4191);
const host = process.env.FIELD_LAB_HOST ?? '127.0.0.1';
const publicRoot = join(out, '.vite-public');
await mkdir(publicRoot, { recursive: true });
await cp(join(repoRoot, 'public'), publicRoot, { recursive: true, force: true });
const publicAssets = join(publicRoot, 'field-lab-assets');
await mkdir(publicAssets, { recursive: true });
for (const file of ['field-lab.oi.json', 'field-lab-results.json']) await copyFile(join(out, file), join(publicAssets, file));

const server = await createServer({ root: repoRoot, publicDir: publicRoot, server: { host, port, strictPort: true } });
await server.listen();
let browser;
const errors = [];
const reportPath = join(out, 'capability-report.json');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
try {
  const configured = process.env.ASTRA_CHROME_PATH?.trim();
  if (configured && !existsSync(configured)) throw new Error(`ASTRA_CHROME_PATH does not exist: ${configured}`);
  browser = await chromium.launch({
    ...(configured ? { executablePath: configured } : {}),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 966 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(`http://${host}:${port}/benchmarks/field-lab/render.html`);
  await page.waitForFunction(() => window.ready, { timeout: 60000 });
  console.log('Page loaded; ready:', await page.evaluate(() => window.ready));
  const canvas = page.locator('#output');
  await page.evaluate(() => window.frame(2, 'hero'));
  await canvas.screenshot({ path: join(out, 'field-lab-overview.png') });
  await page.evaluate(() => window.frame(10));
  await canvas.screenshot({ path: join(out, 'field-lab-pipetting.png') });
  let frames = 2;
  if (mode === 'film') {
    const framesRoot = join(out, 'frames');
    await mkdir(framesRoot, { recursive: true });
    const stats = [];
    for (let index = 0; index < 240; index += 1) {
      const start = performance.now();
      const info = await page.evaluate((time) => window.frame(time), index / 10);
      await canvas.screenshot({ path: join(framesRoot, `${String(index).padStart(4, '0')}.png`) });
      stats.push({ ...info, frame: index, captureMs: performance.now() - start });
      if (index % 40 === 0) console.log('Captured', index, '/ 240');
    }
    frames = 240;
    await writeFile(join(out, 'render-performance.json'), JSON.stringify({
      schema: 'field-lab-benchmark/render-timing/v1',
      measurementBoundary: 'Frame evaluation plus PNG screenshot capture; not interactive FPS or hardware performance.',
      frames: stats,
    }, null, 2));
    console.log('Rendering native Open-Industries GIF export');
    const gif = await page.evaluate(() => window.nativeGif());
    await writeFile(join(out, 'field-lab-native.gif'), new Uint8Array(gif.bytes));
    await writeFile(join(out, 'field-lab-native-metadata.json'), JSON.stringify(gif.metadata, null, 2));
  }
  const renderChecks = {
    errors,
    overlay: await page.locator('vite-error-overlay').count(),
    ready: true,
    renderer: 'Open-Industries createWorld + applyWorldPoses + evaluateWorkspace with benchmark camera, lighting and captions.',
    browser: 'Playwright Chromium with SwiftShader-compatible flags',
    nativeGif: mode === 'film',
    frames,
    interactiveFps: 'not-tested',
  };
  await writeFile(join(out, 'render-checks.json'), JSON.stringify(renderChecks, null, 2));
  const report = existsSync(reportPath) ? await readJson(reportPath) : { schema: 'field-lab-benchmark/capability-report/v1', statuses: {} };
  report.statuses = {
    ...(report.statuses ?? {}),
    rendering: { status: errors.length ? 'failed' : 'passed', detail: `${frames} deterministic capture frames rendered without browser errors.`, evidence: ['render-checks.json', 'field-lab-overview.png'] },
    captureTiming: { status: 'passed', detail: 'Capture timing is recorded separately from interactive FPS or hardware performance.', evidence: ['render-performance.json'] },
    interactiveFps: { status: 'not-tested', detail: 'The benchmark does not claim interactive FPS or hardware throughput.' },
  };
  const values = Object.values(report.statuses).map((entry) => entry.status);
  report.summary = Object.fromEntries(['passed', 'failed', 'blocked', 'not-tested'].map((status) => [status, values.filter((value) => value === status).length]));
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('PASS rendered scene, no browser errors');
} finally {
  if (browser) await browser.close();
  await server.close();
}
