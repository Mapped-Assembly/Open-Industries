import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
let storageRequests = 0;
page.on('request', request => { if (/\/storage\/v1\/|\/rest\/v1\/(asset_file_versions|rpc\/.*asset)/.test(request.url())) storageRequests++; });
try {
  await page.goto('http://127.0.0.1:8787');
  await page.locator('input[aria-label="Import files"]').setInputFiles({ name: 'local.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    hardware_ir_version: '0.2', overview: { title: 'Local with cloud off' }, mechanical: { render_dimensions: { x_mm: 100, y_mm: 200, z_mm: 300 } },
  })) });
  await expect(page.locator('.asset')).toHaveCount(1);
  await page.getByRole('button', { name: 'GIF studio', exact: true }).click();
  await page.getByRole('button', { name: /Asset library/ }).click();
  await expect(page.getByText('Cloud file storage is disabled.', { exact: false })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Cloud asset storage' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save selected asset to library' }).click();
  await expect(page.getByRole('article', { name: 'Local with cloud off' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
  expect(storageRequests).toBe(0);
  console.log('PASS disabled cloud storage: imports, local library, and Auth controls work with zero object-storage requests.');
} finally { await browser.close(); }
