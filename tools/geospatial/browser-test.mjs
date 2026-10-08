/** Verify actual local loading and geometry clicks in CesiumJS and Three.js. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { Cartesian3, Matrix4, Matrix3, Transforms, Math as CesiumMath } from 'cesium';
import * as THREE from 'three';
import './prepare.mjs';

const evidenceDir = process.argv[2] ?? 'evidence';
await mkdir(evidenceDir, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 4194, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const reports = [];
try {
  // Independent runtime oracle for placement: Cesium's ellipsoid/frame plus Three Euler.
  const tileset = JSON.parse(await readFile('public/export/tileset.json', 'utf8'));
  const provenance = JSON.parse(await readFile('public/export/provenance.json', 'utf8'));
  const anchor = provenance.anchor;
  const base = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(anchor.longitude, anchor.latitude, anchor.height));
  const heading = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(-CesiumMath.toRadians(anchor.heading)));
  const expectedRoot = Matrix4.multiply(base, heading, new Matrix4());
  const actualRoot = Matrix4.fromArray(tileset.root.transform);
  let maxErrorMeters = 0;
  for (const instance of provenance.instances) {
    const child = tileset.root.children.find(t => t.metadata.properties.instanceId === instance.instanceId);
    const centerZ = child.boundingVolume.box.slice(0, 3);
    const oi = new THREE.Vector3(centerZ[0], centerZ[2], -centerZ[1]);
    oi.applyEuler(new THREE.Euler(...instance.rotationDegreesXYZ.map(THREE.MathUtils.degToRad), 'XYZ'));
    oi.add(new THREE.Vector3(...instance.position));
    const expected = Matrix4.multiplyByPoint(expectedRoot, new Cartesian3(oi.x, -oi.z, oi.y), new Cartesian3());
    const actual = Matrix4.multiplyByPoint(Matrix4.multiply(actualRoot, Matrix4.fromArray(child.transform), new Matrix4()),
      Cartesian3.fromArray(centerZ), new Cartesian3());
    maxErrorMeters = Math.max(maxErrorMeters, Cartesian3.distance(expected, actual));
  }
  assert(maxErrorMeters <= 0.01, 'Placement disagrees with Cesium/Three oracle');
  await writeFile(path.join(evidenceDir, 'placement-validation.json'), JSON.stringify({ state: 'passed', maxErrorMeters, toleranceMeters: 0.01, anchor }, null, 2));
  for (const mode of ['cesium', 'three']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (request.url().includes('/export/')) requests.push({ state: 'request', url: request.url() }); });
    page.on('response', response => { if (response.url().includes('/export/')) requests.push({ state: response.status(), url: response.url() }); });
    page.on('requestfailed', request => requests.push({ state: 'failed', url: request.url(), error: request.failure() }));
    // The demo must operate without Cesium ion, imagery, or another network service.
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    console.log('Loading', mode);
    await page.goto('http://127.0.0.1:4194/?viewer=' + mode);
    console.log('Initialized', mode, await page.evaluate(() => ({
      status: document.querySelector('#status')?.textContent,
      version: window.Cesium?.VERSION,
      evidence: window.renderEvidence && { loaded: window.renderEvidence.loaded, errors: window.renderEvidence.errors },
    })), errors);
    try {
      await page.waitForFunction(() => window.renderEvidence?.loaded, null, { timeout: 60000 });
    } catch (error) {
      console.error(mode, errors, requests, await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, evidence: window.renderEvidence })));
      await page.screenshot({ path: path.join(evidenceDir, mode + '-failed.png'), timeout: 5000 }).catch(() => {});
      throw error;
    }
    // Actual screen-space geometry click; try bounded offsets around projected equipment.
    const point = await page.evaluate(() => window.renderEvidence.project('pipette'));
    assert(point, 'Equipment must project into the viewport');
    const rectangle = await page.locator('#view').boundingBox();
    let picked = false;
    const offsets = [[0, 0], ...[-20, -10, 0, 10, 20].flatMap(x => [-20, -10, 0, 10, 20].map(y => [x, y]))];
    for (const [dx, dy] of offsets) {
      await page.mouse.click(rectangle.x + point.x + dx, rectangle.y + point.y + dy);
      const selection = await page.evaluate(() => window.renderEvidence.picked);
      if (selection?.fromGeometry && selection.instanceId === 'pipette') { picked = true; break; }
    }
    if (!picked) {
      await page.screenshot({ path: path.join(evidenceDir, mode + '-pick-failed.png') });
      console.error('Pick failure', mode, point, await page.evaluate(point => ({ selected: window.renderEvidence.picked,
        lastPick: window.renderEvidence.lastPick, clicks: window.renderEvidence.clicks,
        clickPosition: window.renderEvidence.clickPosition,
        canvas: document.querySelector('#view canvas').getBoundingClientRect().toJSON(),
      }), point));
    }
    assert(picked, mode + ' must pick pipette geometry with exact instance identity');
    await page.screenshot({ path: path.join(evidenceDir, mode + '.png') });
    const result = await page.evaluate(() => {
      const { project, ...report } = window.renderEvidence;
      const canvas = document.querySelector('canvas');
      return { ...report, canvas: { width: canvas.width, height: canvas.height } };
    });
    assert.equal(result.instances, 21);
    assert.equal(result.loadedModels, 21);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(errors, [], 'Unexpected browser errors');
    reports.push({ state: 'passed', ...result, errors, browserVersion: browser.version() });
    await page.close();
  }
} finally {
  await writeFile(path.join(evidenceDir, 'browser-results.json'), JSON.stringify(reports, null, 2));
  await browser.close();
  await server.close();
}
console.log(JSON.stringify(reports.map(r => ({ viewer: r.viewer, state: r.state, version: r.version, picked: r.picked }))));
