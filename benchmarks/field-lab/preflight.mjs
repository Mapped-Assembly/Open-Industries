import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const args = process.argv.slice(2);
const renderRequested = args.includes('--render');
const outputArg = args.find((arg) => !arg.startsWith('--'));
const output = resolve(outputArg ?? join(repoRoot, 'deliverables', 'field-lab'));
const fixtureRoot = join(here, 'fixtures');
const reportPath = join(output, 'capability-report.json');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const commandAvailable = (command, versionArgs = ['--version']) => spawnSync(command, versionArgs, { stdio: 'ignore' }).status === 0;
const statuses = {};

function capability(id, status, detail, evidence = []) {
  statuses[id] = { status, detail, evidence };
}

function safe(path, fn) {
  try { return fn(path); } catch { return undefined; }
}

mkdirSync(output, { recursive: true });
let manifest;
try {
  manifest = readJson(join(here, 'manifest.json'));
  capability('manifest', 'passed', 'Versioned benchmark manifest is readable.', ['manifest.json']);
} catch (error) {
  capability('manifest', 'failed', String(error));
}

if (Number(process.versions.node.split('.')[0]) >= 22) {
  capability('interpreter', 'passed', `Node.js ${process.version} satisfies the Node 22+ requirement.`);
} else {
  capability('interpreter', 'failed', `Node.js ${process.version} is too old; install Node 22 or newer.`);
}

const requiredPackages = ['three', 'tsx', '@playwright/test', 'occt-import-js'];
const missingPackages = requiredPackages.filter((name) => !existsSync(join(repoRoot, 'node_modules', ...name.split('/'))));
capability('packages', missingPackages.length ? 'failed' : 'passed', missingPackages.length
  ? `Run npm ci; missing ${missingPackages.join(', ')}.`
  : 'Repository npm dependencies are installed.', missingPackages.length ? [] : ['node_modules']);

const vendorFiles = ['public/vendor/occt-import-js.js', 'public/vendor/occt-import-js.wasm'];
const missingVendor = vendorFiles.filter((relative) => !existsSync(join(repoRoot, relative)));
capability('stepVendorAssets', missingVendor.length ? 'failed' : 'passed', missingVendor.length
  ? `Run npm run postinstall; missing ${missingVendor.join(', ')}.`
  : 'OpenCascade worker assets are present.', vendorFiles);

const scenePath = join(fixtureRoot, 'field-lab.oi.json');
const formPath = join(fixtureRoot, 'field-lab-pipette.form.json');
const stepPath = join(fixtureRoot, 'field-lab-pipette.step');
const geometrySpecPath = join(fixtureRoot, 'pipette-geometry-spec.json');
const fixtureHashesPath = join(fixtureRoot, 'SHA256SUMS.json');
try {
  const scene = readJson(scenePath);
  const form = readJson(formPath);
  const fixtureHashes = readJson(fixtureHashesPath);
  const bom = form.project_ir?.bom;
  if (scene.instances?.length !== 21 || scene.animation?.tracks?.length !== 8) {
    throw new Error(`Expected 21 scene instances and 8 animation tracks; found ${scene.instances?.length ?? 0} and ${scene.animation?.tracks?.length ?? 0}.`);
  }
  if (!Array.isArray(bom) || bom.length < 6) throw new Error('Form fixture BOM is missing or incomplete.');
  if (!existsSync(stepPath) || safe(stepPath, (path) => readFileSync(path).length) <= 0) throw new Error('STEP fixture is missing or empty.');
  for (const [file, digest] of Object.entries(fixtureHashes.files)) {
    const path = join(fixtureRoot, file);
    if (!existsSync(path) || sha256(path) !== digest) throw new Error(`Fixture hash mismatch for ${file}.`);
  }
  capability('authoredFixtures', 'passed', 'Portable scene, Form/BOM fixture, and STEP fixture are present.', [
    'fixtures/field-lab.oi.json', 'fixtures/field-lab-pipette.form.json', 'fixtures/field-lab-pipette.step', 'fixtures/pipette-geometry-spec.json', 'fixtures/SHA256SUMS.json',
  ]);
} catch (error) {
  capability('authoredFixtures', 'failed', String(error));
}

const browserPath = process.env.ASTRA_CHROME_PATH?.trim();
let playwrightExecutable;
try {
  const { chromium } = await import('@playwright/test');
  playwrightExecutable = chromium.executablePath();
} catch {
  playwrightExecutable = undefined;
}
const browserReady = browserPath ? existsSync(browserPath) : Boolean(playwrightExecutable && existsSync(playwrightExecutable));
if (!renderRequested) {
  capability('browser', 'not-tested', 'Browser verification was not requested for this run.');
} else if (browserReady) {
  capability('browser', 'passed', `Chromium is available${browserPath ? ' through ASTRA_CHROME_PATH' : ' through Playwright'}.`, [browserPath ?? playwrightExecutable]);
} else {
  capability('browser', 'blocked', 'Install Playwright Chromium or set ASTRA_CHROME_PATH to an existing browser executable.');
}

capability('stepWorker', renderRequested && browserReady && missingVendor.length === 0 ? 'not-tested' : renderRequested ? 'blocked' : 'not-tested',
  renderRequested ? 'Actual worker conversion is exercised by verify.mjs.' : 'STEP worker conversion was not requested.');
capability('formGenerationBridge', 'blocked', 'Live provider generation is outside this fixture; the committed Form document is scenario-authored output.');
capability('kinematics', 'passed', 'The portable fixture contains authored animation tracks; collision and dynamics are outside scope.', ['fixtures/field-lab.oi.json']);
capability('perception', 'not-tested', 'The tip camera is geometry only; no image capture or perception result is claimed.');
capability('physicalEvidence', 'not-tested', 'No physical lab, assay, fluid, thermal or supply-chain measurement is included.');

capability('cadRecipe', commandAvailable('python') || commandAvailable('python3') ? 'not-tested' : 'blocked',
  'CadQuery export is an optional source-rebuild step; the committed STEP fixture is used for deterministic verification.');
capability('mediaEncoder', commandAvailable('ffmpeg') ? 'not-tested' : 'not-tested',
  commandAvailable('ffmpeg') ? 'ffmpeg is available for optional MP4 encoding.' : 'ffmpeg is unavailable; PNG frames and the native GIF remain the render evidence.');

const allStatuses = Object.values(statuses).map((entry) => entry.status);
const report = {
  schema: 'field-lab-benchmark/capability-report/v1',
  benchmarkId: manifest?.benchmarkId ?? 'FIELD-LAB-01',
  requested: { render: renderRequested },
  statuses,
  summary: Object.fromEntries(['passed', 'failed', 'blocked', 'not-tested'].map((status) => [status, allStatuses.filter((value) => value === status).length])),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  fixtureHashes: [scenePath, formPath, stepPath, geometrySpecPath].filter(existsSync).map((path) => ({
    file: path.slice(here.length + 1).replaceAll('\\', '/'),
    sha256: sha256(path),
  })),
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (statuses.interpreter?.status === 'failed' || statuses.packages?.status === 'failed' || statuses.authoredFixtures?.status === 'failed'
    || (renderRequested && statuses.browser?.status === 'blocked')) process.exitCode = 1;
