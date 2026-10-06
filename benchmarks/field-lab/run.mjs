import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const args = process.argv.slice(2);
const render = args.includes('--render');
const cad = args.includes('--cad');
const outputArg = args.find((arg) => !arg.startsWith('--'));
const output = resolve(outputArg ?? join(repoRoot, 'deliverables', 'field-lab'));
const logs = join(output, 'logs');
mkdirSync(logs, { recursive: true });
for (const relative of ['manifest.json', 'inputs/scenarios.json', 'expected/results.json', 'fixtures/SHA256SUMS.json']) {
  const destination = join(output, relative);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(here, relative), destination);
}

const steps = [];
function run(name, command, commandArgs) {
  const started = Date.now();
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  writeFileSync(join(logs, `${name}.stdout.log`), stdout);
  writeFileSync(join(logs, `${name}.stderr.log`), stderr);
  const step = { name, command: [command, ...commandArgs], exitCode: result.status ?? 1, durationMs: Date.now() - started };
  steps.push(step);
  console.log(`${name}: exit ${step.exitCode} (${step.durationMs} ms)`);
  if (stdout) console.log(stdout.trim());
  if (stderr) console.error(stderr.trim());
  if (step.exitCode !== 0) throw new Error(`${name} failed with exit code ${step.exitCode}. See ${join(logs, `${name}.stderr.log`)}.`);
}

function allFiles(root, result = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) allFiles(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function writeChecksums() {
  const checksumPath = join(output, 'checksums.json');
  const files = allFiles(output).filter((path) => path !== checksumPath).sort();
  writeFileSync(checksumPath, JSON.stringify({
    schema: 'field-lab-benchmark/checksums/v1',
    files: files.map((path) => ({
      file: relative(output, path).replaceAll('\\', '/'),
      bytes: statSync(path).size,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    })),
  }, null, 2));
}

function version(command, commandArgs = ['--version']) {
  const result = spawnSync(command, commandArgs, { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? (result.stdout || result.stderr).trim() : 'unavailable';
}

let failed;
try {
  run('preflight', process.execPath, [join(here, 'preflight.mjs'), output, ...(render ? ['--render'] : [])]);
  run('build-scene', process.execPath, ['--import', 'tsx', join(here, 'build-scene.ts'), output]);
  run('simulate', process.execPath, [join(here, 'simulate.mjs'), output]);
  if (cad) {
    const python = version('python') !== 'unavailable' ? 'python' : 'python3';
    if (version(python) === 'unavailable') throw new Error('CAD export requested but Python is unavailable.');
    run('export-cad', python, [join(here, 'export-cad.py'), output]);
  }
  if (render) {
    run('verify', process.execPath, [join(here, 'verify.mjs'), output]);
    run('capture', process.execPath, [join(here, 'capture.mjs'), output, 'film']);
  }
} catch (error) {
  failed = String(error);
}

const summary = {
  schema: 'field-lab-benchmark/run-summary/v1',
  benchmarkId: 'FIELD-LAB-01',
  output,
  renderRequested: render,
  cadRequested: cad,
  steps,
  status: failed ? 'failed' : 'passed',
  error: failed,
  versions: {
    node: process.version,
    npm: version('npm'),
    python: version('python') === 'unavailable' ? version('python3') : version('python'),
    ffmpeg: version('ffmpeg'),
  },
};
writeFileSync(join(output, 'run-summary.json'), JSON.stringify(summary, null, 2));
if (!failed) writeChecksums();
if (failed) process.exitCode = 1;
