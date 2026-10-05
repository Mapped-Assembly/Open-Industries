import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  const response = await page.goto(process.env.ASTRA_BASE_URL || 'https://astra-industries.vercel.app');
  expect(response.status()).toBe(200);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
  await expect(page.getByText('Build with Form', { exact: true })).toHaveCount(0);
  await page.locator('input[type=file]').setInputFiles({ name: 'deployed-fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    hardware_ir_version: '0.2', overview: { title: 'Deployed Form fixture' }, mechanical: { render_dimensions: { x_mm: 1800, y_mm: 800, z_mm: 900 } },
  })) });
  await expect(page.getByRole('heading', { name: 'Deployed Form fixture' })).toBeVisible();
  const step = await fetch('https://raw.githubusercontent.com/kovacsv/occt-import-js/master/test/testfiles/simple-basic-cube/cube.stp');
  if (!step.ok) throw new Error('STEP fixture download failed');
  await page.locator('input[type=file]').setInputFiles({ name: 'cube.stp', mimeType: 'model/step', buffer: Buffer.from(await step.arrayBuffer()) });
  await expect(page.getByRole('heading', { name: 'cube', exact: true })).toBeVisible({ timeout: 120000 });
  await expect(page.locator('.inspector')).toContainText('0.300 × 0.300 × 0.300 m');
  await page.getByRole('button', { name: 'GIF studio', exact: true }).click();
  const studio = page.getByRole('region', { name: 'GIF studio', exact: true });
  await studio.getByLabel('GIF resolution').selectOption('320');
  await studio.getByLabel('Duration').selectOption('2');
  await studio.getByRole('button', { name: 'Render GIF', exact: true }).click();
  await expect(studio.getByRole('status', { name: 'GIF export status' })).toContainText('GIF ready', { timeout: 90000 });
  await expect.poll(() => studio.getByAltText('Rendered GIF preview').evaluate(img => img.complete && img.naturalWidth === 320)).toBe(true);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/vercel-production.png' });
  expect(errors).toEqual([]);
  console.log('PASS public production HTTP 200, Auth controls, Form import, hosted STEP/WASM conversion at correct scale, GIF rendering, and zero page errors.');
} finally { await browser.close(); }
