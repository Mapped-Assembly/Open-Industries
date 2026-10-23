import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { startSimulationService } from '../../server/simulation-service.js';

const execute = promisify(execFile);
const python = process.env.PYTHON ?? 'python3';

/** Start the actual shipped entry point, choosing an unused loopback port. */
async function startProcess(database: string, signup = false): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/simulation-service.ts'], {
    env: {
      ...process.env,
      ASTRA_SIMULATION_DB: database,
      ASTRA_SIMULATION_PORT: '0',
      ASTRA_SIMULATION_ALLOW_SIGNUP: String(signup),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr!.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  for (let attempt = 0; attempt < 200; attempt++) {
    const origin = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
    if (origin) return { child, origin };
    if (child.exitCode !== null) throw new Error(`Service startup failed: ${errors}`);
    await delay(50);
  }
  await stopProcess(child, 'SIGKILL');
  throw new Error(`Service startup timed out: ${errors}`);
}

/** Await process exit so a replacement never races the old database connection. */
async function stopProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

/** Make one server-to-server request and retain the status for denial assertions. */
async function post(origin: string, path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> {
  const reply = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { status: reply.status, body: await reply.json() };
}

/** Poll only to obtain a current revision; retries represent fresh command intents. */
async function command(origin: string, token: string, id: string, action: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const read = await post(origin, '/simulation/read', { instance_id: id }, token);
    assert.equal(read.status, 200);
    const result = await post(origin, '/simulation/command', {
      command_id: `${action}-${id}-${attempt}`,
      instance_id: id,
      expected_revision: read.body.snapshot.revision,
      action,
      payload: {},
    }, token);
    if (result.status === 200) return;
    assert.equal(result.status, 409, JSON.stringify(result));
    await delay(50);
  }
  throw new Error(`Could not issue ${action}`);
}

test('deployed entry point progresses without clients, survives kill/redeploy, and restores online backup', {
  skip: process.platform === 'win32' ? 'Linux deployment and POSIX durable backup' : false,
  timeout: 60000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oi-deploy-'));
  const database = join(directory, 'runtime.sqlite');
  let service: Awaited<ReturnType<typeof startProcess>> | undefined;
  const credentials = { username: 'deployment-operator', password: 'deployment-only-fixture-password' };
  try {
    service = await startProcess(database, true);
    const registered = await post(service.origin, '/auth/register', credentials);
    assert.equal(registered.status, 200);
    let token = registered.body.token;
    const outsider = await post(service.origin, '/auth/register', { ...credentials, username: 'outsider' });
    const creation = { command_id: 'deployment-create-1' };
    const created = await post(service.origin, '/simulation/instances', creation, token);
    assert.equal(created.status, 200);
    const id = created.body.snapshot.instance_id;
    assert.equal((await post(service.origin, '/simulation/read', { instance_id: id })).status, 401);
    assert.equal((await post(service.origin, '/simulation/read', { instance_id: id }, outsider.body.token)).body.error.code, 'NOT_AVAILABLE');
    await command(service.origin, token, id, 'deliver-energy');
    await command(service.origin, token, id, 'start');
    // Observe committed state read-only, without any HTTP request that could drive work.
    // Wait for completion rather than assuming timer callbacks run exactly on schedule.
    const observer = new DatabaseSync(database, { readOnly: true });
    try {
      const deadline = Date.now() + 20000;
      const state = observer.prepare("SELECT json_extract(state, '$.state.schedule.jobs[0].state') status FROM simulation_instances WHERE id=?");
      while (state.get(id)?.status !== 'completed' && Date.now() < deadline) await delay(100);
      assert.equal(state.get(id)?.status, 'completed');
    } finally {
      observer.close();
    }
    const completed = await post(service.origin, '/simulation/read', { instance_id: id }, token);
    assert.equal(completed.body.snapshot.jobs[0].state, 'completed');
    assert.equal(completed.body.snapshot.results.length, 1);
    assert.equal(completed.body.snapshot.inventory.spent_energy_mj, 3000);
    assert.equal(completed.body.snapshot.inventory.battery_mj, 2000);

    // Start a second independent instance, kill while work is pending, then catch up.
    const second = await post(service.origin, '/simulation/instances', { command_id: 'deployment-create-2' }, token);
    assert.equal(second.status, 200);
    const secondId = second.body.snapshot.instance_id;
    await command(service.origin, token, secondId, 'deliver-energy');
    await command(service.origin, token, secondId, 'start');
    await stopProcess(service.child, 'SIGKILL');
    service = undefined;
    await delay(4500);
    service = await startProcess(database);
    token = (await post(service.origin, '/auth/login', credentials)).body.token;
    const recovered = await post(service.origin, '/simulation/read', { instance_id: secondId }, token);
    assert.equal(recovered.body.snapshot.results.length, 1);
    assert.equal(recovered.body.snapshot.inventory.spent_energy_mj, 3000);
    assert.deepEqual((await post(service.origin, '/simulation/instances', creation, token)), created);
    assert.equal((await post(service.origin, '/auth/register', { ...credentials, username: 'disabled-signup' })).body.error.code, 'NOT_AVAILABLE');
    const health = await fetch(service.origin + '/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).registration_enabled, false);
    await execute(python, ['scripts/runtime_health.py', service.origin]);
    const originDenied = await fetch(service.origin + '/health', { headers: { origin: 'https://example.com' } });
    assert.equal(originDenied.status, 400);

    // Back up while WAL writer remains alive. The backup must be independently usable.
    const backup = join(directory, 'backup.sqlite');
    const result = await execute(python, ['scripts/runtime_backup.py', database, backup]);
    assert.equal(JSON.parse(result.stdout).schema_version, 100);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    await assert.rejects(execute(python, ['scripts/runtime_backup.py', database, backup]));
    await stopProcess(service.child);
    service = await startProcess(database); // compatible redeploy on the same persistent path
    token = (await post(service.origin, '/auth/login', credentials)).body.token;
    assert.deepEqual((await post(service.origin, '/simulation/read', { instance_id: secondId }, token)).body.snapshot.inventory, recovered.body.snapshot.inventory);
    await stopProcess(service.child);
    const restored = join(directory, 'restored.sqlite');
    await execute(python, ['scripts/runtime_backup.py', backup, restored]);
    service = await startProcess(restored);
    token = (await post(service.origin, '/auth/login', credentials)).body.token;
    const snapshot = (await post(service.origin, '/simulation/read', { instance_id: secondId }, token)).body.snapshot;
    assert.deepEqual(snapshot.results, recovered.body.snapshot.results);
    assert.deepEqual(snapshot.inventory, recovered.body.snapshot.inventory);
    assert.deepEqual(await post(service.origin, '/simulation/instances', creation, token), created);
    const history = await post(service.origin, '/simulation/history', { instance_id: secondId, cursor: null, limit: 20 }, token);
    assert.equal(history.status, 200);
    assert(history.body.events.length > 0);
  } finally {
    if (service) await stopProcess(service.child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('readiness and probe fail for a stale or unreadable worker heartbeat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oi-health-'));
  let now = 1000;
  const service = await startSimulationService({ database: join(directory, 'health.sqlite'), port: 0, clock: () => now, tickMs: 60000 });
  try {
    assert.equal((await fetch(service.origin + '/health')).status, 200);
    now += 16000;
    const stale = await fetch(service.origin + '/health');
    assert.equal(stale.status, 503);
    assert.equal((await stale.json()).scheduler_healthy, false);
    if (process.platform !== 'win32') await assert.rejects(execute(python, ['scripts/runtime_health.py', service.origin]));
    service.db.tick();
    assert.equal((await fetch(service.origin + '/health')).status, 200);
    service.db.db.exec('DROP TABLE runtime');
    assert.equal((await fetch(service.origin + '/health')).status, 503);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('backup refuses missing/corrupt sources and never overwrites an existing destination', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oi-backup-'));
  try {
    const source = join(directory, 'invalid.sqlite');
    const destination = join(directory, 'destination.sqlite');
    await assert.rejects(execute(python, ['scripts/runtime_backup.py', source, destination]));
    await assert.rejects(stat(source));
    await assert.rejects(stat(destination));
    await writeFile(source, 'not a SQLite database');
    await assert.rejects(execute(python, ['scripts/runtime_backup.py', source, destination]));
    await assert.rejects(stat(destination));
    await writeFile(destination, 'preserve this file');
    await assert.rejects(execute(python, ['scripts/runtime_backup.py', source, destination]));
    assert.equal(await readFile(destination, 'utf8'), 'preserve this file');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
