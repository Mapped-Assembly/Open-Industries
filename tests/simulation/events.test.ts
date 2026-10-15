import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { EventProjection, EventTransition } from '../../server/simulation/event-contracts.js';
import { SqliteEventHistory } from '../../server/simulation/events.mjs';
import { enqueueJob } from '../../server/simulation/jobs.js';
import { startGameService } from '../../server/game-service.mjs';
import { EventFixture, startEventFixtureService } from './event-fixture.js';
import { jobSetup, jobDefinition } from './job-fixture.js';

const pin = { module_id: 'counter', module_version: 'fixture-v1', schema_version: 1 };
const request = (cursor: string | null = null, limit = 100) => ({
  instance_id: 'counter-1',
  cursor,
  limit,
});
/** Real transaction helper; errors must roll back every write. */
function tx<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
/** Counter policy intentionally hides raw state, links, evidence, source actor and hashes. */
function policy(): EventProjection {
  return {
    version: 'counter-view-v1',
    authorize: (_state, principal) => principal === 'alice',
    validateState: (state) => {
      assert(Number.isSafeInteger(state.n));
    },
    snapshot: (state) => ({ n: state.n! }),
    event: (event) =>
      event.payload.private
        ? null
        : { n: event.state.n!, at_ms: event.simulation_time_ms, origin: event.provenance.origin },
  };
}
/** Private raw event deliberately includes secrets that must never be merged into a projection. */
function transition(n: number): EventTransition {
  return {
    instance_id: 'counter-1',
    expected_sequence: n - 1,
    rule: pin,
    simulation_time_ms: n * 1000,
    revision: n + 1,
    source: { kind: 'command', id: `command-${n}`, principal_id: 'alice' },
    links: { entity_ids: ['private-entity-canary'], job_ids: ['private-job-canary'] },
    provenance: { origin: 'simulated', validity: 'modeled', evidence: [] },
    units: [{ field: 'work', unit: 'ms' }],
    payload: { secret: 'private-payload-canary' },
    state: { n, hidden_seed: 'private-seed-canary', composition: 'private-composition-canary' },
  };
}
/** Small private stream with a finite retention policy. */
function setup(maxEvents = 256, maxBytes = 16 * 1024 * 1024) {
  const db = new DatabaseSync(':memory:'),
    history = new SqliteEventHistory(db, { maxEvents, maxBytes });
  tx(db, () =>
    history.initialize({
      instance_id: 'counter-1',
      rule: pin,
      simulation_time_ms: 0,
      revision: 1,
      state: { n: 0, secret: 'private-checkpoint-canary' },
    }),
  );
  return { db, history };
}

test('checkpoint plus persisted replacements replays exactly; authorized views omit every private field', () => {
  const { db, history } = setup();
  try {
    tx(db, () => {
      for (let n = 1; n <= 3; n++) history.append(transition(n));
      assert.deepEqual(history.replay('counter-1').state, transition(3).state);
      const page = history.read(request(), 'alice', policy());
      assert.deepEqual(page.checkpoint, { n: 0 });
      assert.deepEqual(page.snapshot, { n: 3 });
      assert.deepEqual(
        page.events.map((e) => e.n),
        [1, 2, 3],
      );
      assert(!JSON.stringify(page).includes('canary'));
      assert(!JSON.stringify(page).includes('hash'));
      assert.throws(() => history.read(request(), 'mallory', policy()), /NOT_AVAILABLE/);
    });
  } finally {
    db.close();
  }
});

test('encrypted fixed-head cursors survive append and reject tampering, principal/instance/projection reuse', () => {
  const { db, history } = setup();
  try {
    tx(db, () => {
      for (let n = 1; n <= 3; n++) history.append(transition(n));
      const first = history.read(request(null, 1), 'alice', policy()),
        cursor = first.next_cursor!;
      assert(cursor && !cursor.includes('alice') && !cursor.includes('counter'));
      history.append(transition(4));
      const next = history.read(request(cursor, 1), 'alice', policy());
      assert.deepEqual(next.snapshot, { n: 3 });
      assert.deepEqual(
        next.events.map((e) => e.n),
        [2],
      );
      const last = history.read(request(next.next_cursor, 1), 'alice', policy());
      assert.deepEqual(
        last.events.map((e) => e.n),
        [3],
      );
      assert.equal(last.next_cursor, null);
      assert.throws(
        () =>
          history.read(request(cursor.slice(0, 20) + '!' + cursor.slice(21), 1), 'alice', policy()),
        /NOT_AVAILABLE/,
      );
      assert.throws(
        () => history.read(request(cursor, 1), 'bob', { ...policy(), authorize: () => true }),
        /NOT_AVAILABLE/,
      );
      assert.throws(
        () =>
          history.read(request(cursor, 1), 'alice', { ...policy(), version: 'counter-view-v2' }),
        /NOT_AVAILABLE/,
      );
      history.initialize({
        instance_id: 'other',
        rule: pin,
        simulation_time_ms: 0,
        revision: 1,
        state: { n: 0 },
      });
      assert.throws(
        () => history.read({ ...request(cursor), instance_id: 'other' }, 'alice', policy()),
        /NOT_AVAILABLE/,
      );
    });
  } finally {
    db.close();
  }
});

test('retention moves the checkpoint, preserves replay, and expires an overtaken cursor', () => {
  const { db, history } = setup(3);
  try {
    tx(db, () => {
      for (let n = 1; n <= 3; n++) history.append(transition(n));
      const first = history.read(request(null, 1), 'alice', policy());
      for (let n = 4; n <= 7; n++) history.append(transition(n));
      assert.equal(history.head('counter-1').checkpoint.sequence, 4);
      assert.deepEqual(history.replay('counter-1').state, transition(7).state);
      assert.equal(db.prepare('SELECT count(*) n FROM simulation_events').get()!.n, 3);
      assert.throws(
        () => history.read(request(first.next_cursor), 'alice', policy()),
        /CURSOR_EXPIRED/,
      );
      const refreshed = history.read(request(), 'alice', policy());
      assert.deepEqual(refreshed.checkpoint, { n: 4 });
      assert.deepEqual(
        refreshed.events.map((e) => e.n),
        [5, 6, 7],
      );
    });
  } finally {
    db.close();
  }
});

test('byte retention advances a complete checkpoint without exceeding the configured tail bound', () => {
  const { db, history } = setup(256, 2 * 1024 * 1024);
  try {
    tx(db, () => {
      for (let n = 1; n <= 3; n++)
        history.append({ ...transition(n), state: { n, blob: 'x'.repeat(700000) } });
      assert.equal(history.head('counter-1').checkpoint.sequence, 1);
      assert.equal(history.replay('counter-1').state.n, 3);
      const bytes = Number(
        db.prepare('SELECT sum(length(CAST(event AS BLOB))) n FROM simulation_events').get()!.n,
      );
      assert(bytes <= 2 * 1024 * 1024);
      assert.deepEqual(
        history.read(request(), 'alice', policy()).events.map((event) => event.n),
        [2, 3],
      );
    });
  } finally {
    db.close();
  }
});

test('private events do not create visible pagination gaps; revocation rechecks current authority', () => {
  const { db, history } = setup();
  try {
    tx(db, () => {
      history.append(transition(1));
      history.append({ ...transition(2), payload: { private: true } });
      history.append(transition(3));
      const first = history.read(request(null, 1), 'alice', policy());
      const second = history.read(request(first.next_cursor, 1), 'alice', policy());
      assert.deepEqual(
        second.events.map((e) => e.n),
        [3],
      );
      assert.equal(second.next_cursor, null);
      assert.throws(
        () =>
          history.read(request(first.next_cursor), 'alice', {
            ...policy(),
            authorize: () => false,
          }),
        /NOT_AVAILABLE/,
      );
      assert.throws(
        () =>
          history.read(request(), 'alice', {
            ...policy(),
            event: () => {
              throw Error('private-diagnostic-canary');
            },
          }),
        (error) => error instanceof Error && error.message === 'INVALID_HISTORY',
      );
    });
  } finally {
    db.close();
  }
});

test('invalid provenance, time, units, pins, sequence and corrupted replay fail without mutation', () => {
  const { db, history } = setup();
  try {
    assert.throws(() => history.append(transition(1)), /TRANSACTION_REQUIRED/);
    assert.throws(() => history.read(request(), 'alice', policy()), /TRANSACTION_REQUIRED/);
    tx(db, () => history.append(transition(1)));
    for (const mutate of [
      (e: EventTransition) => {
        e.provenance.validity = 'observed';
      },
      (e: EventTransition) => {
        e.provenance.origin = 'external';
      },
      (e: EventTransition) => {
        e.rule = { ...pin, module_version: 'other' };
      },
      (e: EventTransition) => {
        e.simulation_time_ms = 999;
      },
      (e: EventTransition) => {
        e.expected_sequence = 0;
      },
      (e: EventTransition) => {
        e.source.principal_id = null;
      },
      (e: EventTransition) => {
        e.revision = NaN;
      },
      (e: EventTransition) => {
        e.units = [{ field: 'energy', unit: 'kilowatt' as 'mJ' }];
      },
    ]) {
      const bad = transition(2);
      mutate(bad);
      assert.throws(() => tx(db, () => history.append(bad)));
    }
    assert.equal(
      tx(db, () => history.head('counter-1').sequence),
      1,
    );
    const raw = JSON.parse(String(db.prepare('SELECT event FROM simulation_events').get()!.event));
    raw.state.n = 99;
    db.prepare('UPDATE simulation_events SET event=?').run(JSON.stringify(raw));
    assert.throws(
      () => tx(db, () => history.read(request(), 'alice', policy())),
      /INVALID_HISTORY/,
    );
  } finally {
    db.close();
  }
});

test('external and observation-derived records keep source provenance without claiming simulated observation', () => {
  const { db, history } = setup();
  try {
    tx(db, () => {
      history.append({
        ...transition(1),
        provenance: {
          origin: 'external',
          validity: 'observed',
          evidence: [
            { observation_id: 'sensor-1', source_id: 'instrument', source_revision: 'v1' },
          ],
        },
      });
      history.append({
        ...transition(2),
        provenance: {
          origin: 'observation-derived',
          validity: 'modeled',
          evidence: [
            { observation_id: 'sensor-1', source_id: 'instrument', source_revision: 'v1' },
          ],
        },
      });
      assert.deepEqual(
        history.read(request(), 'alice', policy()).events.map((e) => e.origin),
        ['external', 'observation-derived'],
      );
    });
  } finally {
    db.close();
  }
});

test('real SQL event, state and receipt faults roll back all three; exact command retry emits once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-event-fault-')),
    fixture = new EventFixture(join(dir, 'state.sqlite'));
  try {
    fixture.seedJobs();
    const command = {
      command_id: randomUUID(),
      instance_id: 'instance-1',
      expected_revision: 1,
      action: 'pause',
      payload: { job_id: 'job-1' },
    };
    for (const table of [
      'simulation_events',
      'simulation_history',
      'command_receipts',
      'instances',
    ]) {
      const operation =
        table === 'simulation_history' || table === 'instances' ? 'UPDATE' : 'INSERT';
      fixture.db.exec(
        `CREATE TRIGGER injected_fault BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'private-sql-canary'); END;`,
      );
      assert.throws(() => fixture.execute(command));
      fixture.db.exec('DROP TRIGGER injected_fault');
      assert.equal(fixture.read().revision, 1);
      assert.equal(fixture.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n, 0);
      assert.equal(fixture.db.prepare('SELECT count(*) n FROM command_receipts').get()!.n, 0);
    }
    const result = fixture.execute(command);
    assert.deepEqual(fixture.execute(command), result);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n, 1);
    tx(fixture.db, () =>
      assert.deepEqual(fixture.history.replay('instance-1').state, fixture.read()),
    );
  } finally {
    fixture.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Independent writer can be killed after state and history writes, before transaction commit. */
function worker(path: string, now: number, crash = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./event-worker.ts', import.meta.url)),
        path,
        String(now),
        ...(crash ? ['crash'] : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let killed = false,
      errors = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('worker timeout'));
    }, 30000);
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      if (crash && String(chunk).includes('before-commit')) {
        killed = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 || killed) resolve();
      else reject(Error(errors));
    });
  });
}

test('hard restart rolls back event/output spending together; cursor key and ordering persist across writers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-event-restart-')),
    path = join(dir, 'state.sqlite');
  let fixture = new EventFixture(path);
  try {
    fixture.seedJobs();
    fixture.wallNow = 2000;
    fixture.tick();
    fixture.wallNow = 3000;
    fixture.tick();
    const first = fixture.page({ instance_id: 'instance-1', cursor: null, limit: 1 });
    fixture.db.close();
    await worker(path, 4000, true);
    fixture = new EventFixture(path);
    assert.equal(fixture.schedule().jobs[0]!.completed_steps, 2);
    const resumed = fixture.page({
      instance_id: 'instance-1',
      cursor: first.next_cursor,
      limit: 1,
    });
    assert.equal(resumed.events.length, 1);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n, 2);
    fixture.db.close();
    await Promise.all([worker(path, 5000), worker(path, 5000)]);
    fixture = new EventFixture(path);
    assert.equal(fixture.schedule().jobs[0]!.state, 'completed');
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n, 3);
    tx(fixture.db, () =>
      assert.deepEqual(fixture.history.replay('instance-1').state, fixture.read()),
    );
    const page = fixture.page({ instance_id: 'instance-1', cursor: null, limit: 100 });
    assert(!JSON.stringify(page).includes('hidden-observation-canary'));
  } finally {
    fixture.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Request actual service transports; no mocked database or projected canned response. */
async function post(
  origin: string,
  path: string,
  token: string | undefined,
  body: unknown,
): Promise<{ status: number; value: any }> {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
}

test('neutral HTTP commands and worker shortfalls/pause/cancel preserve ordered presentation time and receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-event-http-')),
    path = join(dir, 'state.sqlite');
  const service = await startEventFixtureService(path),
    fixture = service.fixture;
  try {
    fixture.seedJobs(
      enqueueJob(jobSetup(1000000), { ...jobDefinition('job-2'), dependencies: ['job-1'] }),
    );
    await post(service.origin, '/tick', 'alice-test-token', { now: 3000 });
    let response = await post(service.origin, '/simulation/history', 'alice-test-token', {
      instance_id: 'instance-1',
      cursor: null,
      limit: 100,
    });
    assert.equal(response.status, 200);
    assert.equal(response.value.events[0].snapshot.jobs[0].state, 'waiting-for-resource');
    const command = {
      command_id: randomUUID(),
      instance_id: 'instance-1',
      expected_revision: fixture.read().revision,
      action: 'pause',
      payload: { job_id: 'job-1' },
    };
    const paused = await post(service.origin, '/command', 'alice-test-token', command);
    assert.deepEqual(await post(service.origin, '/command', 'alice-test-token', command), paused);
    await post(service.origin, '/command', 'alice-test-token', {
      ...command,
      command_id: randomUUID(),
      expected_revision: fixture.read().revision,
      action: 'cancel',
    });
    response = await post(service.origin, '/simulation/history', 'alice-test-token', {
      instance_id: 'instance-1',
      cursor: null,
      limit: 100,
    });
    assert.deepEqual(
      response.value.events.map((e: any) => e.snapshot.jobs[0].state),
      ['waiting-for-resource', 'paused', 'cancelled'],
    );
    assert.deepEqual(
      response.value.events.map((e: any) => e.simulation_time_ms),
      [3000, 3000, 3000],
    );
    assert.equal(response.value.events[1].command_id, command.command_id);
    assert(!JSON.stringify(response.value).includes('canary'));
    await post(service.origin, '/tick', 'alice-test-token', { now: 4000 });
    const failed = await post(service.origin, '/simulation/history', 'alice-test-token', {
      instance_id: 'instance-1',
      cursor: null,
      limit: 100,
    });
    assert.equal(failed.value.events.at(-1).snapshot.jobs[1].state, 'failed');
    assert.equal(failed.value.events.at(-1).simulation_time_ms, 4000);
    fixture.db.prepare('DELETE FROM test_sessions WHERE token=?').run('alice-test-token');
    assert.equal(
      (
        await post(service.origin, '/simulation/history', 'alice-test-token', {
          instance_id: 'instance-1',
          cursor: null,
          limit: 1,
        })
      ).status,
      401,
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('production game HTTP history shares command identity, hides opponent data, replays and rolls back with receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-game-history-'));
  let service = await startGameService({
    database: join(dir, 'game.sqlite'),
    port: 0,
    allowSignup: true,
    tickMs: 60000,
  });
  try {
    const register = async (username: string) =>
      (
        await post(service.origin, '/auth/register', undefined, {
          username,
          password: 'history-test-password-123',
        })
      ).value.token as string;
    const alice = await register('history-alice'),
      bob = await register('history-bob'),
      outsider = await register('history-outsider');
    const creation = { version: 3, command_id: randomUUID() };
    const created = (
      await post(service.origin, '/game', alice, {
        name: 'astra.game_create_match',
        arguments: creation,
      })
    ).value;
    const joined = (
      await post(service.origin, '/game', bob, {
        name: 'astra.game_join_match',
        arguments: {
          version: 3,
          command_id: randomUUID(),
          match_id: created.snapshot.match_id,
          invite_code: created.invite_code,
        },
      })
    ).value;
    const command = {
      version: 3,
      command_id: randomUUID(),
      match_id: created.snapshot.match_id,
      expected_revision: joined.snapshot.revision,
      action: 'inspect_deposit',
      deposit_id: created.snapshot.deposits[0].id,
    };
    const inspected = await post(service.origin, '/game', alice, {
      name: 'astra.game_command',
      arguments: command,
    });
    assert.equal(inspected.status, 200);
    const eventsBefore = service.db.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n;
    assert.deepEqual(
      await post(service.origin, '/game', alice, {
        name: 'astra.game_command',
        arguments: command,
      }),
      inspected,
    );
    assert.equal(
      service.db.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n,
      eventsBefore,
    );
    const input = { instance_id: created.snapshot.match_id, cursor: null, limit: 100 };
    const own = await post(service.origin, '/simulation/history', alice, input);
    assert.equal(own.status, 200);
    assert(own.value.events.some((e: any) => e.command_id === command.command_id));
    const other = await post(service.origin, '/simulation/history', bob, input);
    assert.equal(other.status, 200);
    assert(!JSON.stringify(other.value).includes(command.command_id));
    // Deposit positions/IDs are public map data; the assay and machine are private.
    assert(
      !JSON.stringify(other.value).includes(inspected.value.snapshot.deposits[0].observation.id),
    );
    assert(!JSON.stringify(other.value).includes(created.snapshot.machines[0].id));
    assert.equal(other.value.snapshot.deposits[0].observation, null);
    assert(!JSON.stringify(other.value).includes('"truth"'));
    assert(!JSON.stringify(other.value).includes('invite_hash'));
    assert(!JSON.stringify(other.value).includes('hidden_composition'));
    assert.equal(
      (await post(service.origin, '/simulation/history', outsider, input)).value.error.code,
      'NOT_AVAILABLE',
    );
    tx(service.db.db, () =>
      assert.deepEqual(
        service.db.history.replay(created.snapshot.match_id).state,
        service.db.load(created.snapshot.match_id),
      ),
    );
    const before = service.db.load(created.snapshot.match_id);
    service.db.db.exec(
      "CREATE TRIGGER history_receipt_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'private-error-canary'); END;",
    );
    const failed = await post(service.origin, '/game', alice, {
      name: 'astra.game_command',
      arguments: {
        ...command,
        command_id: randomUUID(),
        expected_revision: before.revision,
        action: 'collect_deposit',
      },
    });
    assert.equal(failed.status, 503);
    assert(!JSON.stringify(failed.value).includes('canary'));
    service.db.db.exec('DROP TRIGGER history_receipt_fault');
    assert.deepEqual(service.db.load(created.snapshot.match_id), before);
    assert.equal(
      service.db.db.prepare('SELECT count(*) n FROM simulation_events').get()!.n,
      eventsBefore,
    );
    const firstPage = await post(service.origin, '/simulation/history', alice, {
      ...input,
      limit: 1,
    });
    assert(firstPage.value.next_cursor);
    await service.close();
    service = await startGameService({
      database: join(dir, 'game.sqlite'),
      port: 0,
      allowSignup: true,
      tickMs: 60000,
    });
    const resumed = await post(service.origin, '/simulation/history', alice, {
      ...input,
      cursor: firstPage.value.next_cursor,
    });
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.value.snapshot, firstPage.value.snapshot);
    await post(service.origin, '/auth/logout', alice, {});
    assert.equal((await post(service.origin, '/simulation/history', alice, input)).status, 401);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});
