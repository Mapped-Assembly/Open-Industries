import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SimulationCommandError } from '../../server/simulation/commands.mjs';
import { SimulationContractError } from '../../server/simulation/registry.js';
import { GameDatabase, canonical } from '../../server/game-sqlite.mjs';
import { CommandFixture } from './command-fixture.js';
import { fixtureInstance } from './fixtures.js';

/** Create a strict common command with a fresh identity. */
function command(action = 'start', revision = 1) {
  return {
    command_id: randomUUID(),
    instance_id: 'instance-1',
    expected_revision: revision,
    action,
    payload: {},
  };
}
/** Independent child processes exercise SQLite's writer lock rather than an in-memory queue. */
function writer(
  path: string,
  request: unknown,
): Promise<{ ok: boolean; code?: string; result?: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./command-writer.ts', import.meta.url)),
        path,
        JSON.stringify(request),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (exit) => {
      if (exit !== 0) reject(new Error(errors));
      else {
        try {
          resolve(JSON.parse(output));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}
/** Per-test file-backed database with no production data. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'oi-command-'));
  const path = join(dir, 'state.sqlite');
  const fixture = new CommandFixture(path);
  fixture.seed(fixtureInstance());
  return {
    dir,
    path,
    fixture,
    close: async () => {
      fixture.db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('command state, event append and immutable receipts commit once; restart preserves replay', async () => {
  const { fixture, path, close } = await setup();
  try {
    const request = command(),
      result = fixture.execute(request);
    assert.equal(fixture.read().state.mode, 'working');
    assert.equal(fixture.read().revision, 2);
    assert.deepEqual(fixture.execute({ ...request, payload: {} }), result);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM test_events').get()!.n, 1);
    const second = new CommandFixture(path);
    try {
      assert.deepEqual(second.execute(request), result);
      second.execute(command('stop', 2));
      assert.deepEqual(second.execute(request), result);
    } finally {
      second.db.close();
    }
    assert.throws(() => fixture.execute({ ...request, action: 'stop' }), {
      code: 'COMMAND_ID_REUSED',
    });
    assert.throws(() => fixture.execute(command('start', 1)), { code: 'CONFLICT' });
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM command_receipts').get()!.n, 2);
  } finally {
    await close();
  }
});

test('authentication, scoped membership and strict command payloads cannot be spoofed', async () => {
  const { fixture, close } = await setup();
  try {
    for (const patch of [
      { principal_id: 'alice' },
      { owner_id: 'alice' },
      { expected_revision: 0 },
      { payload: { owner_id: 'alice' } },
      { payload: { bad: Infinity } },
    ])
      assert.throws(() => fixture.execute({ ...command(), ...patch }));
    fixture.token = 'unrecognized';
    assert.throws(() => fixture.execute(command()), { code: 'AUTH_REQUIRED' });
    fixture.db.prepare('INSERT INTO test_sessions VALUES(?,?)').run('bob-token', 'bob');
    fixture.token = 'bob-token';
    assert.throws(() => fixture.execute(command()), { code: 'NOT_AVAILABLE' });
    fixture.token = 'alice-test-token';
    assert.throws(() => fixture.execute({ ...command(), instance_id: 'other-instance' }), {
      code: 'NOT_AVAILABLE',
    });
    const request = command();
    fixture.execute(request);
    fixture.db.prepare('DELETE FROM test_sessions').run();
    assert.throws(() => fixture.execute(request), { code: 'AUTH_REQUIRED' });
    assert.equal(fixture.read().revision, 2);
  } finally {
    await close();
  }
});

test('domain authorization, illegal transitions and invalid output invariants roll back', async () => {
  const { fixture, close } = await setup();
  try {
    assert.throws(() => fixture.execute(command('stop')), { code: 'INVALID_TRANSITION' });
    assert.throws(() => fixture.execute(command('invalid-state')), { code: 'INVALID_TRANSITION' });
    assert.throws(() => fixture.execute(command('invalid-event')), { code: 'INVALID_TRANSITION' });
    const state = fixture.read();
    state.members[0].role = 'viewer';
    fixture.db.prepare('UPDATE instances SET state=?').run(JSON.stringify(state));
    assert.throws(() => fixture.execute(command()), { code: 'NOT_AVAILABLE' });
    assert.equal(fixture.read().revision, 1);
    assert.equal(fixture.read().state.mode, 'idle');
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM command_receipts').get()!.n, 0);
  } finally {
    await close();
  }
});

test('faults in state, event and receipt writes roll back the complete transaction', async () => {
  const { fixture, close } = await setup();
  try {
    for (const [table, timing, operation] of [
      ['instances', 'BEFORE', 'UPDATE'],
      ['test_events', 'BEFORE', 'INSERT'],
      ['command_receipts', 'BEFORE', 'INSERT'],
    ]) {
      const request = command();
      fixture.db.exec(
        `CREATE TRIGGER injected ${timing} ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'injected'); END;`,
      );
      assert.throws(() => fixture.execute(request));
      fixture.db.exec('DROP TRIGGER injected');
      assert.equal(fixture.read().state.mode, 'idle');
      assert.equal(fixture.read().revision, 1);
      assert.equal(fixture.db.prepare('SELECT count(*) n FROM test_events').get()!.n, 0);
      assert.equal(fixture.db.prepare('SELECT count(*) n FROM command_receipts').get()!.n, 0);
    }
    assert.throws(
      () =>
        fixture.execute(command(), (adapter) => {
          delete adapter.appendEvents;
        }),
      { code: 'EVENTS_UNSUPPORTED' },
    );
    assert.equal(fixture.read().revision, 1);
    const result = fixture.execute(command());
    assert.equal(result.revision, 2);
  } finally {
    await close();
  }
});

test('two process writers serialize stale commands and identical commands replay one receipt', async () => {
  const { fixture, path, close } = await setup();
  try {
    const requests = [command(), command()];
    const outcomes = await Promise.all(requests.map((request) => writer(path, request)));
    assert.equal(outcomes.filter((o) => o.ok).length, 1);
    assert.equal(outcomes.find((o) => !o.ok)?.code, 'CONFLICT');
    const won = requests[outcomes.findIndex((o) => o.ok)];
    const replays = await Promise.all([writer(path, won), writer(path, won)]);
    assert.deepEqual(replays[0], replays[1]);
    assert(replays[0].ok);
    assert.equal(fixture.read().revision, 2);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM test_events').get()!.n, 1);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM command_receipts').get()!.n, 1);
    const same = command('stop', 2);
    const duplicate = await Promise.all([writer(path, same), writer(path, same)]);
    assert(duplicate.every((o) => o.ok));
    assert.deepEqual(duplicate[0].result, duplicate[1].result);
    assert.equal(fixture.read().revision, 3);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM command_receipts').get()!.n, 2);
    assert.equal(fixture.db.prepare('SELECT count(*) n FROM test_events').get()!.n, 2);
  } finally {
    await close();
  }
});

test('adapter cannot silently change instance identity, command revision or bypass validation', async () => {
  const { fixture, close } = await setup();
  try {
    for (const field of ['id', 'revision'] as const)
      assert.throws(
        () =>
          fixture.execute(command(), (adapter) => {
            const original = adapter.apply;
            adapter.apply = (state, request, context) => {
              const next = original(state, request, context);
              if (field === 'id') next.state.id = 'wrong';
              else next.state.revision = 999;
              return next;
            };
          }),
        { code: 'INVARIANT_FAILED' },
      );
    assert.equal(fixture.read().revision, 1);
    const result = fixture.execute(command(), (adapter) => {
      const original = adapter.result;
      adapter.result = (state, request, context) => {
        const result = original(state, request, context);
        state.state.mode = 'corrupted';
        return result;
      };
    });
    assert.equal(result.revision, 2);
    assert.equal(fixture.read().state.mode, 'working', 'projection receives an isolated copy');
  } finally {
    await close();
  }
});

test('adopted game inspection preserves its original response, fingerprint and rollback semantics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-game-command-'));
  const path = join(dir, 'game.sqlite');
  let time = 1000000;
  const db = new GameDatabase(path, { clock: () => time });
  try {
    const a = (
      await db.authenticate({ username: 'alice', password: 'test-command-password' }, true)
    ).token;
    const b = (
      await db.authenticate({ username: 'bobby', password: 'test-command-password' }, true)
    ).token;
    db.tick();
    const request = () => ({ version: 5, command_id: randomUUID() });
    const created = db.dispatch(a, 'astra.game_create_match', request()),
      id = created.snapshot.match_id;
    const legacy = db.load(id); legacy.legacy_recovery = true; db.save(legacy);
    db.dispatch(b, 'astra.game_join_match', {
      ...request(),
      match_id: id,
      invite_code: created.invite_code,
    });
    const before = db.dispatch(a, 'astra.game_read_match', { version: 5, match_id: id }).snapshot;
    const args = {
      ...request(),
      match_id: id,
      expected_revision: before.revision,
      action: 'inspect_deposit',
      deposit_id: before.deposits[0].id,
    };
    db.db.exec(
      "CREATE TRIGGER failed_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'fault'); END;",
    );
    assert.throws(() => db.dispatch(a, 'astra.game_command', args));
    db.db.exec('DROP TRIGGER failed_receipt');
    assert.equal(db.load(id).players[0].deposit.observation, null);
    const result = db.dispatch(a, 'astra.game_command', args);
    assert.equal(result.version, 5);
    assert.equal(result.balance_version, 'dump-world-v1');
    assert.equal(result.invite_code, null);
    assert.equal(result.snapshot.revision, before.revision + 1);
    assert.deepEqual(
      Object.keys(result).sort(),
      ['version', 'balance_version', 'snapshot', 'command_id', 'invite_code'].sort(),
    );
    assert(result.snapshot.deposits[0].observation.id);
    const receipt = db.db
      .prepare('SELECT request,result FROM receipts WHERE owner=? AND command_id=?')
      .get(db.identity(a), args.command_id)!;
    assert.equal(receipt.request, canonical({ name: 'astra.game_command', arguments: args }));
    assert.equal(receipt.result, JSON.stringify(result));
    const other = new GameDatabase(path, { clock: () => time });
    try {
      assert.deepEqual(other.dispatch(a, 'astra.game_command', args), result);
    } finally {
      other.close();
    }
    assert.throws(
      () => db.dispatch(a, 'astra.game_command', { ...args, deposit_id: randomUUID() }),
      { code: 'COMMAND_ID_REUSED' },
    );
    assert.throws(() => db.dispatch(a, 'astra.game_command', { ...args, match_id: randomUUID() }), {
      code: 'COMMAND_ID_REUSED',
    });
    assert.throws(
      () => db.dispatch(b, 'astra.game_command', { ...args, command_id: randomUUID() }),
      { code: 'CONFLICT' },
    );
    assert.throws(
      () =>
        db.dispatch(b, 'astra.game_command', {
          ...args,
          command_id: randomUUID(),
          expected_revision: result.snapshot.revision,
        }),
      { code: 'NOT_AVAILABLE' },
    );
    time += 1000;
    db.tick();
    assert.deepEqual(db.dispatch(a, 'astra.game_command', args), result);
    assert.equal(
      db.load(id).players[0].deposit.observation,
      result.snapshot.deposits[0].observation.id,
    );
  } finally {
    db.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
