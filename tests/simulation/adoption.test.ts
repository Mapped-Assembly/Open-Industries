import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { GameDatabase } from '../../server/game-sqlite.mjs';
import { SqliteAuthority } from '../../server/simulation/sqlite-authority.mjs';
import { SimulationDatabase } from '../../server/simulation/sqlite-runtime.js';
import { startSimulationService } from '../../server/simulation-service.js';
import { startClient } from '../../scripts/lib/mcp-scene-workflows.mjs';

/** Native service request: actual HTTP, no in-memory projection substitute. */
async function post(
  origin: string,
  path: string,
  token: string | undefined,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const reply = await fetch(origin + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}
/** Fresh idempotency identity for each intent; failed revision retry is a new intent. */
const command = (id: string, revision: number, action = 'start', payload = {}) => ({
  command_id: randomUUID(),
  instance_id: id,
  expected_revision: revision,
  action,
  payload,
});

test('production work-cell HTTP has one owner, finite contention/waits, exact retries and authorized MCP history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-adopt-http-'));
  let clock = 1000;
  const service = await startSimulationService({
    database: join(dir, 'cell.sqlite'),
    port: 0,
    allowSignup: true,
    clock: () => clock,
    tickMs: 60000,
  });
  let client: ReturnType<typeof startClient> | undefined;
  try {
    const register = async (username: string) =>
      (
        await post(service.origin, '/auth/register', undefined, {
          username,
          password: 'only-a-fixture-password',
        })
      ).body.token as string;
    const alice = await register('one-operator'),
      outsider = await register('outsider');
    const creation = { command_id: randomUUID() };
    const created = await post(service.origin, '/simulation/instances', alice, creation);
    assert.equal(created.status, 200);
    assert.deepEqual(await post(service.origin, '/simulation/instances', alice, creation), created);
    const id = created.body.snapshot.instance_id;
    assert(service.db instanceof SqliteAuthority);
    assert.equal(service.db.load(id).members.length, 1);
    assert.equal(
      service.db.db.prepare("SELECT name FROM sqlite_master WHERE name='matches'").get(),
      undefined,
    );
    assert.equal(
      (await post(service.origin, '/simulation/read', outsider, { instance_id: id })).status,
      400,
    );
    const starts = await Promise.all([
      post(service.origin, '/simulation/command', alice, command(id, 1)),
      post(service.origin, '/simulation/command', alice, command(id, 1)),
    ]);
    assert.deepEqual(starts.map((r) => r.status).sort(), [200, 409]);
    const winner = starts.find((r) => r.status === 200)!;
    const second = command(id, winner.body.snapshot.revision);
    // Discard the first response body, then retry the exact same intent.
    const lost = await fetch(service.origin + '/simulation/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice}` },
      body: JSON.stringify(second),
    });
    await lost.body?.cancel();
    const replay = await post(service.origin, '/simulation/command', alice, second);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.snapshot.jobs.length, 2);
    assert.deepEqual(await post(service.origin, '/simulation/command', alice, second), replay);
    clock = 4000;
    service.db.tick();
    const read = async () =>
      (await post(service.origin, '/simulation/read', alice, { instance_id: id })).body.snapshot;
    let snapshot = await read();
    assert.equal(snapshot.jobs[0].reason, 'energy:need-1000-mJ');
    assert.equal(snapshot.jobs[1].reason, 'consumable:need-one-kit');
    assert.equal(snapshot.inventory.spent_energy_mj, 2000);
    const delivery = {
      ...command(id, snapshot.revision, 'deliver-energy'),
      command_id: 'job-1:step:0:energy',
    };
    const delivered = await post(service.origin, '/simulation/command', alice, delivery);
    assert.equal(delivered.status, 200);
    assert.deepEqual(await post(service.origin, '/simulation/command', alice, delivery), delivered);
    clock = 5000;
    service.db.tick();
    snapshot = await read();
    assert.equal(snapshot.results.length, 1);
    assert.equal(snapshot.results[0].validity, 'modeled');
    assert.equal(snapshot.inventory.spent_energy_mj, 3000);
    assert.equal(snapshot.inventory.battery_mj, 2000);
    assert.equal(snapshot.jobs[1].state, 'waiting-for-resource');
    assert(!JSON.stringify(snapshot).includes('winner'));
    assert(!JSON.stringify(snapshot).includes('tower'));
    client = startClient(
      { client: 'neutral-adoption', request_ids: 'string' },
      {
        env: {
          ASTRA_SIMULATION_TOOLS_ENABLED: 'true',
          ASTRA_SIMULATION_SERVICE_URL: service.origin,
          ASTRA_SIMULATION_SESSION: alice,
        },
      },
    );
    const description = await client.call('simulation_describe', {});
    assert.equal(description.structuredContent.modeled_fixture, true);
    const mcp = await client.call('simulation_read', { instance_id: id });
    assert.deepEqual(mcp.structuredContent.snapshot, snapshot);
    const history = await client.call('simulation_history', {
      instance_id: id,
      cursor: null,
      limit: 100,
    });
    assert(history.structuredContent.events.some((e: any) => e.command_id === delivery.command_id));
    assert(!JSON.stringify(history.structuredContent).includes('token_hash'));
    await post(service.origin, '/auth/logout', alice, {});
    const denied = await client.call('simulation_read', { instance_id: id });
    assert.equal(denied.structuredContent.error.code, 'AUTH_REQUIRED');
  } finally {
    await client?.close();
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Independent database writer; optionally die after both state and history writes. */
function writer(
  path: string,
  clock: number,
  token: string,
  request: unknown,
  crash = false,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const args = [
      '--import',
      'tsx',
      fileURLToPath(new URL('./runtime-writer.ts', import.meta.url)),
      path,
      String(clock),
      token,
      typeof request === 'string' ? request : JSON.stringify(request),
    ];
    if (crash) args.push('crash');
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '',
      errors = '',
      killed = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('writer timeout'));
    }, 30000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (crash && output.includes('before-commit')) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (killed) resolve(null);
      else if (code !== 0) reject(Error(errors));
      else resolve(output ? JSON.parse(output) : null);
    });
  });
}

test('production SQLite authority serializes process writers and preserves receipts, reservations and result across hard restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-adopt-restart-')),
    path = join(dir, 'cell.sqlite');
  let clock = 1000,
    runtime = new SimulationDatabase(path, { clock: () => clock });
  try {
    const account = await runtime.authenticate(
      { username: 'native-owner', password: 'native-test-password' },
      true,
    );
    const created = runtime.create(account.token, { command_id: 'create-1' }) as any,
      id = created.snapshot.instance_id;
    const start = command(id, 1);
    const replies = await Promise.all([
      writer(path, 1000, account.token, start),
      writer(path, 1000, account.token, start),
    ]);
    assert.deepEqual(replies[0], replies[1]);
    assert.equal(runtime.load(id).revision, 2);
    clock = 4000;
    runtime.tick();
    runtime.execute(account.token, command(id, runtime.load(id).revision, 'deliver-energy'));
    const before = runtime.load(id);
    const receipts = runtime.db
      .prepare('SELECT * FROM simulation_receipts ORDER BY command_id')
      .all();
    runtime.close();
    await writer(path, 5000, 'tick', 'crash', true);
    runtime = new SimulationDatabase(path, { clock: () => clock });
    assert.deepEqual(runtime.load(id), before);
    assert.deepEqual(
      runtime.db.prepare('SELECT * FROM simulation_receipts ORDER BY command_id').all(),
      receipts,
    );
    assert.deepEqual(runtime.execute(account.token, start), replies[0]);
    runtime.close();
    await Promise.all([writer(path, 5000, 'tick', ''), writer(path, 5000, 'tick', '')]);
    runtime = new SimulationDatabase(path, { clock: () => 5000 });
    const snapshot = runtime.read(account.token, id) as any;
    assert.equal(snapshot.results.length, 1);
    assert.equal(snapshot.inventory.spent_energy_mj, 3000);
    const eventCount = runtime.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n;
    runtime.tick();
    assert.equal(
      runtime.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n,
      eventCount,
    );
  } finally {
    runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('production work-cell write faults cannot commit state, resource effects or history without the receipt', async () => {
  const runtime = new SimulationDatabase(':memory:', { clock: () => 1000 });
  try {
    const account = await runtime.authenticate(
      { username: 'fault-owner', password: 'native-test-password' },
      true,
    );
    const created = runtime.create(account.token, { command_id: 'creation' }) as any,
      id = created.snapshot.instance_id;
    const before = runtime.load(id),
      request = command(id, 1);
    runtime.db.exec(
      "CREATE TRIGGER fail_adoption_receipt BEFORE INSERT ON simulation_receipts BEGIN SELECT RAISE(ABORT,'fault'); END;",
    );
    assert.throws(() => runtime.execute(account.token, request));
    runtime.db.exec('DROP TRIGGER fail_adoption_receipt');
    assert.deepEqual(runtime.load(id), before);
    assert.equal(runtime.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n, 1);
    runtime.execute(account.token, request);
    assert.equal((runtime.read(account.token, id) as any).jobs.length, 1);
  } finally {
    runtime.close();
  }
});

test('unsupported database and module versions fail with recovery instructions without rewriting saved state or receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-adopt-version-')),
    path = join(dir, 'cell.sqlite');
  try {
    let runtime = new SimulationDatabase(path, { clock: () => 1000 });
    const account = await runtime.authenticate(
      { username: 'version-owner', password: 'native-test-password' },
      true,
    );
    const created = runtime.create(account.token, { command_id: 'create' }) as any,
      id = created.snapshot.instance_id;
    const state = runtime.load(id);
    state.pin.module_version = 'future-version';
    runtime.db
      .prepare('UPDATE simulation_instances SET state=? WHERE id=?')
      .run(JSON.stringify(state), id);
    runtime.close();
    assert.throws(() => new SimulationDatabase(path), /restore a compatible backup/);
    const inspect = new DatabaseSync(path);
    assert.equal(
      inspect.prepare('SELECT state FROM simulation_instances').get()!.state,
      JSON.stringify(state),
    );
    assert.equal(inspect.prepare('SELECT count(*) n FROM simulation_receipts').get()!.n, 1);
    inspect.close();
    assert.throws(() => new GameDatabase(path), /restore a compatible backup/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy game IDs, inventory, jobs, observations and immutable receipt bytes survive the module separation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-adopt-game-')),
    path = join(dir, 'game.sqlite');
  let clock = 1000;
  let runtime = new GameDatabase(path, { clock: () => clock });
  try {
    const a = await runtime.authenticate(
        { username: 'legacy-one', password: 'legacy-password-123' },
        true,
      ),
      b = await runtime.authenticate(
        { username: 'legacy-two', password: 'legacy-password-123' },
        true,
      );
    runtime.tick();
    const created = runtime.dispatch(a.token, 'astra.game_create_match', {
        version: 5,
        command_id: randomUUID(),
      }),
      id = created.snapshot.match_id;
    const legacy = runtime.load(id); legacy.legacy_recovery = true; runtime.save(legacy);
    let result = runtime.dispatch(b.token, 'astra.game_join_match', {
      version: 5,
      command_id: randomUUID(),
      match_id: id,
      invite_code: created.invite_code,
    });
    const action = (action: string, extra = {}) => {
      result = runtime.dispatch(a.token, 'astra.game_command', {
        version: 5,
        command_id: randomUUID(),
        match_id: id,
        expected_revision: runtime.load(id).revision,
        action,
        ...extra,
      });
    };
    action('inspect_deposit', { deposit_id: created.snapshot.deposits[0].id });
    action('collect_deposit', { deposit_id: created.snapshot.deposits[0].id });
    const start = {
      version: 5,
      command_id: randomUUID(),
      match_id: id,
      expected_revision: result.snapshot.revision,
      action: 'start_processing',
      batch_id: result.snapshot.batches[0].id,
      machine_id: result.snapshot.machines[0].id,
    };
    const receipt = runtime.dispatch(a.token, 'astra.game_command', start);
    clock = 2000;
    runtime.tick();
    const state = runtime.load(id),
      stored = runtime.db.prepare('SELECT * FROM receipts ORDER BY owner,command_id').all();
    runtime.close();
    runtime = new GameDatabase(path, { clock: () => clock });
    assert(runtime instanceof SqliteAuthority);
    assert.deepEqual(runtime.load(id), state);
    assert.deepEqual(
      runtime.db.prepare('SELECT * FROM receipts ORDER BY owner,command_id').all(),
      stored,
    );
    assert.deepEqual(runtime.dispatch(a.token, 'astra.game_command', start), receipt);
    assert.equal(runtime.domainPin.module_version, 'dump-world-v1');
  } finally {
    runtime.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('neutral CLI worker continues a job across process kill/restart without another participant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-adopt-cli-')),
    path = join(dir, 'cell.sqlite');
  const children: ReturnType<typeof spawn>[] = [];
  const start = async (): Promise<{ child: ReturnType<typeof spawn>; origin: string }> => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../../server/simulation-service.ts', import.meta.url)),
      ],
      {
        env: {
          ...process.env,
          ASTRA_SIMULATION_DB: path,
          ASTRA_SIMULATION_PORT: '0',
          ASTRA_SIMULATION_ALLOW_SIGNUP: 'true',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    children.push(child);
    child.stderr!.resume();
    const origin = await new Promise<string>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('startup timeout')), 15000);
      child.on('exit', () => {
        clearTimeout(timer);
        reject(Error('service exited'));
      });
      child.stdout!.on('data', (chunk) => {
        output += String(chunk);
        const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    return { child, origin };
  };
  try {
    let service = await start();
    const auth = await post(service.origin, '/auth/register', undefined, {
        username: 'restart-owner',
        password: 'restart-password-123',
      }),
      token = auth.body.token;
    const created = await post(service.origin, '/simulation/instances', token, {
        command_id: 'creation',
      }),
      id = created.body.snapshot.instance_id;
    const startCommand = command(id, 1);
    assert.equal(
      (await post(service.origin, '/simulation/command', token, startCommand)).status,
      200,
    );
    const exit = once(service.child, 'exit');
    service.child.kill('SIGKILL');
    await exit;
    service = await start();
    const replay = await post(service.origin, '/simulation/command', token, startCommand);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.snapshot.jobs.length, 1);
    const until = async (predicate: (snapshot: any) => boolean) => {
      for (let n = 0; n < 100; n++) {
        const snapshot = (
          await post(service.origin, '/simulation/read', token, { instance_id: id })
        ).body.snapshot;
        if (predicate(snapshot)) return snapshot;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw Error('job progress timeout');
    };
    const waiting = await until((snapshot) => snapshot.jobs[0].state === 'waiting-for-resource');
    assert.equal(waiting.inventory.spent_energy_mj, 2000);
    assert.equal(
      (
        await post(
          service.origin,
          '/simulation/command',
          token,
          command(id, waiting.revision, 'deliver-energy'),
        )
      ).status,
      200,
    );
    const completed = await until((snapshot) => snapshot.results.length === 1);
    assert.equal(completed.inventory.spent_energy_mj, 3000);
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
      }
    await rm(dir, { recursive: true, force: true });
  }
});
