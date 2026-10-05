import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto('http://127.0.0.1:8787');
  await page.getByRole('button', { name: 'Enter fullscreen' }).click();
  await page.getByRole('button', { name: 'Show workspace' }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Drop files or browse/ }).click();
  const chooser = await chooserPromise;
  // Reproduce Edge/Windows exiting native fullscreen when its OS picker opens.
  await page.evaluate(async () => {
    window.pickerInput = document.querySelector('input[type=file]');
    if (document.fullscreenElement) await document.exitFullscreen();
  });
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/fullscreen-import-picker.png' });
  await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
  await expect(page.locator('#workspace-panel')).toBeVisible();
  expect(await page.evaluate(() => window.pickerInput === document.querySelector('input[type=file]'))).toBe(true);
  await page.evaluate(() => {
    document.querySelector('.stage').requestFullscreen = () => Promise.reject(new Error('User activation required'));
  });
  await chooser.setFiles({ name: 'fullscreen-project.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    hardware_ir_version: '0.2', overview: { title: 'Fullscreen import' },
    mechanical: { render_dimensions: { x_mm: 300, y_mm: 200, z_mm: 100 } },
  })) });
  await expect(page.locator('.asset').filter({ hasText: 'Fullscreen import' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
  await expect(page.locator('.stage')).toHaveClass(/stage-expanded/);
  await page.screenshot({ path: 'test-results/fullscreen-import-after.png' });
  // A cancelled dialog must preserve expanded mode as well.
  const cancelledChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Drop files or browse/ }).click();
  await cancelledChooser;
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    document.querySelector('input[type=file]').dispatchEvent(new Event('cancel', { bubbles: true }));
  });
  await expect(page.getByRole('button', { name: 'Exit fullscreen' })).toBeVisible();
  await page.getByRole('button', { name: 'Exit fullscreen' }).click();
  await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  await expect(page.locator('#workspace-panel')).toBeVisible();
  expect(errors).toEqual([]);
  console.log('PASS picker-triggered fullscreen exit, stable input, successful import, cancellation, and explicit exit.');
} finally { await browser.close(); }
