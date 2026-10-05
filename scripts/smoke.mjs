import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:8787');
  await page.locator('canvas').waitFor();
  const fixture = { hardware_ir_version: '0.2', overview: { title: 'Lab workbench' }, mechanical: { component_placements: [
    { ref_des: 'TOP', label: 'Work surface', size: { x_mm: 1800, y_mm: 800, z_mm: 50 }, position: { x_mm: 0, y_mm: 0, z_mm: 875 } },
    { ref_des: 'BASE', label: 'Cabinet base', size: { x_mm: 1200, y_mm: 650, z_mm: 850 }, position: { x_mm: 0, y_mm: 0, z_mm: 425 } },
  ] } };
  await page.locator('input[type=file]').setInputFiles({ name: 'lab-workbench.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
  await page.getByRole('status').filter({ hasText: 'Imported 1' }).waitFor();
  await page.getByRole('heading', { name: 'Lab workbench' }).waitFor();
  console.log('PASS Form JSON import and visible inspector');
  await page.getByRole('button', { name: 'View entire room' }).click();
  await page.getByLabel('Width', { exact: true }).fill('8');
  console.log('PASS room dimensions and camera reset');
  await page.locator('input[type=file]').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await page.getByRole('alert').filter({ hasText: 'not valid JSON' }).waitFor();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  console.log('PASS invalid import retains previous asset');
  const stepResponse = await fetch('https://raw.githubusercontent.com/kovacsv/occt-import-js/master/test/testfiles/simple-basic-cube/cube.stp');
  if (!stepResponse.ok) throw new Error('Could not download upstream STEP test fixture.');
  const stepBytes = Buffer.from(await stepResponse.arrayBuffer());
  await page.locator('input[type=file]').setInputFiles({ name: 'cube.stp', mimeType: 'model/step', buffer: stepBytes });
  await page.getByRole('heading', { name: 'cube', exact: true }).waitFor({ timeout: 120000 });
  console.log('PASS real STEP conversion and rendered asset:', await page.locator('.inspector').innerText());
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/1-4-desktop.png' });
  await page.getByText('Build with Form', { exact: true }).click();
  await page.getByRole('button', { name: 'Build and import' }).click();
  await page.getByRole('status').filter({ hasText: /Form simulation project imported|Generation failed/ }).waitFor({ timeout: 90000 });
  console.log('Form generation:', await page.locator('footer [role=status]').innerText());
  if (await page.getByRole('alert').count()) console.log('Generation error:', await page.getByRole('alert').innerText());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/1-4-mobile.png', fullPage: true });
  console.log('Browser errors:', errors);
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); }
