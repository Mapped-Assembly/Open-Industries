import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const base = process.env.ASTRA_BASE_URL || 'http://127.0.0.1:4173';
  await page.goto(base);
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('astra-scenes', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['scenes', 'assets'], 'readwrite');
      const scene = (id, title, x) => ({ schemaVersion: 1, id, source: {}, room: { width: 6, depth: 5, height: 3 }, instances: [{ id: `${id}-instance`, assetId: `${id}-asset`, name: title, position: [x, 0, 0], rotation: [0, 0, 0], visible: true }], workspaceDocument: { format: 'astra.scene', version: 1, units: 'm', upAxis: 'Y', room: [6, 5, 3], assets: [{ id: `${id}-asset`, name: title, dimensions: [1, 1, 1], source: { kind: 'form', filename: `${id}.json`, digest: `${id}-digest` } }], instances: [{ id: `${id}-instance`, assetId: `${id}-asset`, name: title, position: [x, 0, 0], rotation: [0, 0, 0], visible: true }], animation: { duration: 3, loop: true, tracks: [] } } });
      tx.objectStore('scenes').put({ ...scene('active:guest:room-a', 'Room A', 1), id: 'active:guest:room-a' });
      tx.objectStore('scenes').put({ ...scene('active:guest:room-b', 'Room B', 4), id: 'active:guest:room-b' });
      tx.objectStore('scenes').put({ id: 'active-room:guest', kind: 'astra.active-room', version: 1, roomId: 'room-b' });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await expect(page.locator('.asset')).toContainText('Room B');
  await expect(page.getByLabel('Room B X position', { exact: true })).toHaveValue('4');
  await expect(page.locator('.asset')).not.toContainText('Room A');
  console.log('PASS active-room pointer selects the correct owner-scoped draft without mixing room state.');
} finally { await browser.close(); }
