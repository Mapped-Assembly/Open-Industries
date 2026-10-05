import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
const page = await context.newPage();
try {
  const base = process.env.ASTRA_BASE_URL || 'http://127.0.0.1:8787';
  await page.goto(base);
  await expect(page.getByRole('button', { name: '+ Import project' })).toBeEnabled();
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('astra-scenes', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const transaction = db.transaction('scenes', 'readwrite'); const scenes = transaction.objectStore('scenes'); scenes.put({ id: 'active-room:guest', kind: 'astra.active-room', version: 1, roomId: 'legacy' }); scenes.put({ id: 'active:guest:legacy', schemaVersion: 1, room: null, instances: [] }); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    db.close();
  });
  await page.close();
  const recoveryPage = await context.newPage();
  await recoveryPage.goto(base);
  const recovery = recoveryPage.locator('.draft-recovery');
  await expect(recovery).toContainText('Saved workspace needs recovery', { timeout: 20000 });
  await expect(recoveryPage.getByRole('button', { name: '+ Import project' })).toBeEnabled();
  const backup = recoveryPage.waitForEvent('download');
  await recovery.getByRole('button', { name: 'Download backup' }).click();
  const download = await backup;
  expect(download.suggestedFilename()).toBe('astra-draft-recovery.json');
  await recovery.getByRole('button', { name: 'Start clean workspace' }).click();
  await expect(recovery).toHaveCount(0);
  await expect(recoveryPage.getByRole('button', { name: '+ Import project' })).toBeEnabled();
  await recoveryPage.locator('input[aria-label="Import files"]').setInputFiles({
    name: 'after-recovery.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ hardware_ir_version: '0.2', overview: { title: 'After recovery' }, mechanical: { render_dimensions: { x_mm: 100, y_mm: 100, z_mm: 100 } } })),
  });
  await expect(recoveryPage.locator('.asset')).toContainText('After recovery');
  console.log('PASS malformed local draft recovery, backup download, clean reset, and import after recovery.');
} finally {
  await context.close();
  await browser.close();
}
