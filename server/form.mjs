import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { scrubPortableData } from '../src/lib/portable-data.mjs';

export const FORM_VERSION = '0.3.5';
const exec = promisify(execFile);
export function pythonExecutable(root) {
  const local = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  return process.env.FORM_PYTHON || process.env.FORMA_PYTHON || (existsSync(local) ? local : 'python');
}
export async function formHealth(root) {
  try {
    const { stdout } = await exec(pythonExecutable(root), ['-c', 'import importlib.metadata; print(importlib.metadata.version("caid-forma-core"))'], { timeout: 15_000, windowsHide: true });
    const version = stdout.trim();
    return { available: version === FORM_VERSION, version, expectedVersion: FORM_VERSION,
      message: version === FORM_VERSION ? 'Form is ready' : `Install caid-forma-core==${FORM_VERSION}; found ${version}.` };
  } catch {
    return { available: false, expectedVersion: FORM_VERSION, message: 'Install the Form requirements in .venv to enable generation. File imports work independently.' };
  }
}

export function generationArgs(body, output) {
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000) throw new Error('Enter a project description (1–12,000 characters).');
  if (!['simulation', 'live'].includes(body.mode)) throw new Error('Choose live or simulation mode.');
  const args = ['-m', 'forma_core', 'generate', body.prompt.trim(), '--output', output];
  if (body.mode === 'simulation') args.push('--simulation');
  else {
    for (const key of ['provider', 'model']) {
      if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > 160 || body[key].trim().startsWith('-')) throw new Error(`Enter a valid ${key} for live generation.`);
      args.push(`--${key}`, body[key].trim());
    }
    if (body.provider.trim().toLowerCase() === 'simulation') throw new Error('Use simulation mode for the simulation provider.');
  }
  return args;
}

// Expose only the fields needed by the importer. Provider settings and generation logs stay server-side.
export function projectForClient(ir) {
  return scrubPortableData({ project_ir: ir, agent: ir.agent, hardware_ir_version: ir.hardware_ir_version, overview: ir.overview, mechanical: ir.mechanical,
    cad_model: ir.cad_model, part_definitions: ir.part_definitions, components: ir.components,
    assembly_metadata: { project_id: ir.assembly_metadata?.project_id } });
}

export async function runGeneration(root, request, job) {
  let directory;
  try {
    const health = await formHealth(root);
    if (!health.available) throw new Error(health.message);
    const parent = resolve(root, '.astra', 'jobs');
    await mkdir(parent, { recursive: true });
    directory = await mkdtemp(join(parent, 'generation-'));
    const output = join(directory, 'project.json');
    const args = generationArgs(request, output);
    job.message = request.mode === 'simulation' ? 'Running Form deterministic simulation…' : 'Form is building your project…';
    await new Promise((resolveJob, reject) => {
      const child = spawn(pythonExecutable(root), args, { cwd: directory, windowsHide: true, shell: false,
        env: { ...process.env, PYTHONUNBUFFERED: '1', FORMA_DEV_MODE: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
      // Drain output without returning provider diagnostics (which may contain credentials) to the browser.
      child.stdout.resume(); child.stderr.resume();
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else child.kill('SIGKILL');
        reject(new Error('Form generation timed out after 10 minutes. Try a smaller request.'));
      }, 600_000);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Could not start Form. Check FORM_PYTHON (or legacy FORMA_PYTHON) and the documented setup.')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolveJob();
        else reject(new Error('Form generation failed. Verify your provider, model, and server-side credentials, then retry.'));
      });
    });
    const ir = JSON.parse(await readFile(output, 'utf8'));
    job.project = projectForClient(ir);
    job.status = 'succeeded'; job.message = 'Project ready to import';
  } catch (error) {
    job.status = 'failed'; job.message = error.message;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
