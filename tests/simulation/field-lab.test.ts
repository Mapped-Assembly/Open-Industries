import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainRegistry } from '../../server/simulation/registry.js';
import {
  advanceLab,
  createLab,
  fieldLabModule,
  labScenarios,
  labDayMs,
  labSlotMs,
  labState,
} from '../../server/domains/field-lab.js';
import { FieldLabDatabase } from '../../server/simulation/field-lab-runtime.js';
import { simulate } from '../../benchmarks/field-lab/simulate.mjs';
import { startFieldLabService } from '../../server/field-lab-service.js';
import { canonicalCommand } from '../../server/simulation/commands.mjs';

/** Every original slot, shortage and utility quantity must survive the durable adapter unchanged. */
test('all six frozen FIELD-LAB days match the original full timeline and exact utility balances', async () => {
  const input = JSON.parse(
    await readFile(
      new URL('../../benchmarks/field-lab/inputs/scenarios.json', import.meta.url),
      'utf8',
    ),
  );
  const registry = new DomainRegistry();
  registry.register(fieldLabModule);
  for (const scenario of input.scenarios) {
    const original = simulate(scenario.changes),
      instance = createLab('lab-1', 'alice', scenario.id, 1000);
    registry.validateInstance(instance);
    const end = advanceLab(instance, 1000 + labDayMs);
    registry.validateInstance(end);
    const s = labState(end);
    assert.deepEqual(s.timeline, original.timeline, scenario.id);
    assert.deepEqual(s.blocked, original.blockedMinutes, scenario.id);
    const t = s.totals;
    assert.deepEqual(
      {
        generatedWh: t.generated_mj / 3600000,
        spillWh: t.spill_mj / 3600000,
        baseServedWh: t.base_served_mj / 3600000,
        baseUnservedWh: t.base_unmet_mj / 3600000,
        processWh: t.process_mj / 3600000,
        sampleWaterL: t.sample_water_ul / 1000000,
        serviceWaterL: t.service_water_ul / 1000000,
        deliveredWaterL: t.delivered_water_ul / 1000000,
        deliveredTips: t.delivered_tips,
        deliveredKits: t.delivered_kits,
      },
      original.ledger,
    );
    assert.equal(end.observations.length, original.processed);
    for (const patch of [
      (x: typeof end) => {
        labState(x).totals.process_mj++;
      },
      (x: typeof end) => {
        labState(x).jobs[0]!.checkpoint.instrument_id = 'foreign';
      },
      (x: typeof end) => {
        labState(x).jobs[0]!.progress_ms--;
      },
      (x: typeof end) => {
        x.entities[0]!.data.scene_sha256 = 'invented';
      },
    ]) {
      const corrupt = structuredClone(end);
      patch(corrupt);
      assert.throws(() => registry.validateInstance(corrupt));
    }
    assert.deepEqual(advanceLab(end, 1000 + labDayMs + 1), end);
    let partial = advanceLab(instance, 1000 + labDayMs, 3);
    assert(labState(partial).cursor_ms < labState(partial).observed_at_ms);
    while (labState(partial).cursor_ms < 1000 + labDayMs) partial = advanceLab(partial, 0, 3);
    partial.revision = end.revision;
    assert.deepEqual(partial, end);
  }
});
/** Pause/cancel retains paid work and treats opened kits as waste, with finite reservations. */
test('field-lab pause, resume, cancellation, modeled failure and horizon have explicit finite semantics', () => {
  const registry = new DomainRegistry();
  registry.register(fieldLabModule);
  let s = createLab('lab-1', 'alice', 'baseline', 1000);
  s = advanceLab(s, 1000 + labSlotMs / 2);
  const run = (action: string, job_id = 'sample-1') => {
    const proposal = registry.transition(s, 'alice', {
      command_id: randomUUID(),
      instance_id: s.id,
      expected_revision: s.revision,
      action,
      payload: { job_id },
    });
    s = { ...s, state: proposal.state };
    registry.validateInstance(s);
  };
  run('pause');
  const paid = labState(s).totals.process_mj;
  s = advanceLab(s, 1000 + 3 * labSlotMs);
  assert.equal(labState(s).jobs[0]!.progress_ms, labSlotMs / 2);
  assert.equal(labState(s).totals.process_mj, paid);
  run('resume');
  s = advanceLab(s, 1000 + 3 * labSlotMs + 1000);
  run('cancel');
  assert.equal(labState(s).jobs[0]!.state, 'cancelled');
  assert.equal(s.observations.length, 0);
  assert(labState(s).totals.process_mj > paid);
  assert.throws(() => run('resume'), { code: 'JOB_NOT_PAUSED' });
  run('fail', 'sample-2');
  assert.equal(labState(s).jobs[1]!.reason, 'modeled-instrument-fault');
  s = advanceLab(s, 1000 + labDayMs);
  registry.validateInstance(s);
  assert(labState(s).jobs.every((j) => ['completed', 'cancelled', 'failed'].includes(j.state)));
  const untouched = advanceLab(
    createLab('manual', 'alice', 'baseline', 1000, 'manual'),
    1000 + labDayMs,
  );
  assert(labState(untouched).jobs.every((j) => j.reason === 'day-ended-review-unserved-work'));
});
/** Real file-backed authority rolls the entire proposal back if its immutable receipt cannot be stored. */
test('field-lab SQLite rollback/retry preserves reservations, journals, deliveries and unsupported-pin remedies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-lab-'));
  const path = join(dir, 'lab.sqlite');
  let time = 1000,
    db = new FieldLabDatabase(path, { clock: () => time });
  try {
    const a = await db.authenticate({ username: 'alice', password: 'lab-test-password-123' }, true);
    db.tick();
    const create = { command_id: randomUUID(), scenario: 'baseline', dispatch: 'manual' },
      result = db.create(a.token, create),
      id = (result.snapshot as any).instance_id;
    assert.deepEqual(db.create(a.token, create), result);
    const command = {
      command_id: randomUUID(),
      instance_id: id,
      expected_revision: 1,
      action: 'start',
      payload: { job_id: 'sample-1' },
    };
    const before = canonicalCommand(db.load(id)),
      journal = db.transaction(() => canonicalCommand(db.history.replay(id)));
    db.db.exec(
      "CREATE TRIGGER reject_lab_receipt BEFORE INSERT ON lab_receipts BEGIN SELECT RAISE(ABORT,'lab-fault'); END;",
    );
    assert.throws(() => db.execute(a.token, command));
    assert.equal(canonicalCommand(db.load(id)), before);
    assert.equal(
      db.transaction(() => canonicalCommand(db.history.replay(id))),
      journal,
    );
    db.db.exec('DROP TRIGGER reject_lab_receipt');
    const receipt = db.execute(a.token, command);
    assert.deepEqual(db.execute(a.token, command), receipt);
    assert.throws(() => db.execute(a.token, { ...command, action: 'cancel' }), {
      code: 'COMMAND_ID_REUSED',
    });
    time += 3 * 60 * 60 * 1000;
    db.tick();
    assert.equal(labState(db.load(id)).delivery_arrived, true);
    const balances = structuredClone(labState(db.load(id)).resources);
    db.close();
    db = new FieldLabDatabase(path, { clock: () => time });
    db.tick();
    assert.deepEqual(labState(db.load(id)).resources, balances);
    assert.deepEqual(db.execute(a.token, command), receipt);
    const valid = db.load(id),
      bad = structuredClone(valid);
    bad.pin.module_version = 'latest';
    db.db.prepare('UPDATE labs SET state=? WHERE id=?').run(JSON.stringify(bad), id);
    db.close();
    assert.throws(
      () => new FieldLabDatabase(path, { clock: () => time }),
      /restore a complete compatible backup/,
    );
    db = new FieldLabDatabase(':memory:', { clock: () => time });
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
/** Exercise production HTTP identity, strict inputs, own snapshots and lost-response replay. */
test('actual field-lab HTTP service enforces identity, private labs, controls, receipts and clock rollback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-lab-http-'));
  let time = 1000000;
  const service = await startFieldLabService({
    database: join(dir, 'lab.sqlite'),
    port: 0,
    allowSignup: true,
    clock: () => time,
    tickMs: 1000000,
  });
  const post = async (path: string, body: unknown, token = '') => {
    const r = await fetch(service.origin + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, value: (await r.json()) as any };
  };
  try {
    const a = (
        await post('/auth/register', { username: 'alice', password: 'lab-http-password-123' })
      ).value.token,
      b = (await post('/auth/register', { username: 'bobby', password: 'lab-http-password-123' }))
        .value.token;
    const describe = await fetch(service.origin + '/simulation/describe');
    assert.equal(describe.status, 200);
    assert.equal(((await describe.json()) as any).module.module_id, 'field-lab');
    const created = await post(
        '/simulation/instances',
        { command_id: randomUUID(), scenario: 'missed_delivery', dispatch: 'automatic' },
        a,
      ),
      snapshot = created.value.snapshot,
      id = snapshot.instance_id;
    assert.equal(created.status, 200);
    assert.equal((await post('/simulation/read', { instance_id: id }, b)).status, 400);
    assert.equal((await post('/simulation/read', { instance_id: id })).status, 401);
    assert.equal(
      (
        await post(
          '/simulation/instances',
          { command_id: randomUUID(), scenario: 'baseline', dispatch: 'automatic', clock_ms: 1 },
          a,
        )
      ).status,
      400,
    );
    const command = {
      command_id: randomUUID(),
      instance_id: id,
      expected_revision: snapshot.revision,
      action: 'pause',
      payload: { job_id: 'sample-1' },
    };
    // Discard the committed HTTP response body; recover only through identical-intent retry.
    const lost = await fetch(service.origin + '/simulation/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a}` },
      body: JSON.stringify(command),
    });
    assert.equal(lost.status, 200);
    await lost.body?.cancel();
    const result = await post('/simulation/command', command, a);
    assert.equal(result.status, 200);
    assert.deepEqual(await post('/simulation/command', command, a), result);
    assert.equal(
      (await post('/simulation/command', { ...command, command_id: randomUUID() }, a)).value.error
        .code,
      'CONFLICT',
    );
    time += labSlotMs;
    service.db.tick();
    const paused = (await post('/simulation/read', { instance_id: id }, a)).value.snapshot;
    assert.equal(paused.jobs[0].progress_ms, 0);
    time -= 1000;
    service.db.tick();
    assert.deepEqual(
      (await post('/simulation/read', { instance_id: id }, a)).value.snapshot,
      paused,
    );
    const history = await post(
      '/simulation/history',
      { instance_id: id, cursor: null, limit: 20 },
      a,
    );
    assert.equal(history.status, 200);
    await post('/auth/logout', {}, a);
    assert.equal((await post('/simulation/command', command, a)).status, 401);
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Independent processes contend for the final kit under the same production command adapter. */
test('two independent lab writers cannot reserve the final kit twice', async () => {
  const { spawn } = await import('node:child_process'),
    { fileURLToPath } = await import('node:url'),
    { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'oi-lab-race-')),
    path = join(dir, 'lab.sqlite'),
    timeFile = join(dir, 'time');
  let time = 1000;
  const db = new FieldLabDatabase(path, { clock: () => time });
  try {
    const a = await db.authenticate({ username: 'alice', password: 'lab-race-password-123' }, true),
      id = (
        db.create(a.token, {
          command_id: randomUUID(),
          scenario: 'missed_delivery',
          dispatch: 'manual',
        }).snapshot as any
      ).instance_id;
    for (let n = 1; n <= 11; n++) {
      time = Math.max(time, 1000 + Math.floor((n - 1) / 6) * 120 * 60000);
      db.tick();
      db.execute(a.token, {
        command_id: randomUUID(),
        instance_id: id,
        expected_revision: db.load(id).revision,
        action: 'start',
        payload: { job_id: `sample-${n}` },
      });
      time += labSlotMs;
      db.tick();
    }
    time = 1000 + 16 * labSlotMs;
    db.tick();
    await writeFile(timeFile, String(time));
    const command = {
      command_id: randomUUID(),
      instance_id: id,
      expected_revision: db.load(id).revision,
      action: 'start',
      payload: { job_id: 'sample-12' },
    };
    const writer = (job: string) =>
      new Promise<any>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('./field-lab-process.ts', import.meta.url)),
            'writer',
            path,
            timeFile,
            a.token,
            JSON.stringify({ ...command, command_id: randomUUID(), payload: { job_id: job } }),
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '',
          errors = '';
        child.stdout.on('data', (c) => (output += c));
        child.stderr.on('data', (c) => (errors += c));
        child.once('close', (code) => {
          if (code !== 0) reject(Error(errors));
          else resolve(JSON.parse(output));
        });
        child.once('error', reject);
      });
    const results = await Promise.all([writer('sample-12'), writer('sample-13')]);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.find((r) => !r.ok).code, 'CONFLICT');
    time += labSlotMs;
    db.tick();
    assert.equal(labState(db.load(id)).jobs.filter((j) => j.state === 'completed').length, 12);
    assert.throws(
      () =>
        db.execute(a.token, {
          ...command,
          command_id: randomUUID(),
          expected_revision: db.load(id).revision,
          payload: { job_id: 'sample-14' },
        }),
      { code: 'RESOURCE_REQUIRED' },
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Hard kill at an uncommitted checkpoint and with every client absent must preserve exactly-once work. */
test('real lab service survives hard kill, no-client progress, delivery restart and pre-COMMIT process death', async () => {
  const { spawn } = await import('node:child_process'),
    { fileURLToPath } = await import('node:url'),
    { writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'oi-lab-process-')),
    path = join(dir, 'lab.sqlite'),
    timeFile = join(dir, 'time');
  await writeFile(timeFile, '1000');
  const script = fileURLToPath(new URL('./field-lab-process.ts', import.meta.url));
  let child: ReturnType<typeof spawn> | undefined;
  const kill = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>((done) => child!.once('exit', () => done()));
      child.kill('SIGKILL');
      await ended;
    }
  };
  const start = () =>
    new Promise<string>((resolve, reject) => {
      child = spawn(process.execPath, ['--import', 'tsx', script, 'service', path, timeFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '',
        errors = '';
      const timer = setTimeout(
        () => reject(Error('Lab process startup timeout: ' + errors)),
        15000,
      );
      child.stdout!.on('data', (c) => {
        output += c;
        const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
        if (url) {
          clearTimeout(timer);
          resolve(url[0]);
        }
      });
      child.stderr!.on('data', (c) => (errors += c));
      child.once('exit', () => {
        clearTimeout(timer);
        reject(Error(errors));
      });
    });
  let origin = await start();
  const waitForStored = async (
    id: string,
    check: (state: ReturnType<typeof labState>) => boolean,
  ) => {
    const { DatabaseSync } = await import('node:sqlite'),
      deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const saved = new DatabaseSync(path, { readOnly: true });
      let state;
      try {
        const row = saved.prepare('SELECT state FROM labs WHERE id=?').get(id);
        state = row ? labState(JSON.parse(String(row.state))) : null;
      } finally {
        saved.close();
      }
      if (state && check(state)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error('Independent lab worker did not persist its checkpoint');
  };
  const post = async (route: string, body: unknown, token = '') => {
    const r = await fetch(origin + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json() as Promise<any>;
  };
  try {
    const a = (
      await post('/auth/register', { username: 'alice', password: 'lab-process-password-123' })
    ).token;
    const create = { command_id: randomUUID(), scenario: 'baseline', dispatch: 'automatic' },
      created = await post('/simulation/instances', create, a),
      id = created.snapshot.instance_id;
    await writeFile(timeFile, String(1000 + labSlotMs / 2));
    // No HTTP/MCP clients cause progress; wait only for the independent server timer checkpoint.
    await waitForStored(id, (s) => s.jobs[0]!.progress_ms === labSlotMs / 2);
    await kill();
    let db = new FieldLabDatabase(path, { clock: () => 1000 + labSlotMs / 2 });
    const before = canonicalCommand(db.load(id));
    assert.equal(labState(db.load(id)).jobs[0]!.progress_ms, labSlotMs / 2);
    db.close();
    await writeFile(timeFile, String(1000 + labSlotMs));
    const doomed = spawn(
      process.execPath,
      ['--import', 'tsx', script, 'kill-before-commit', path, timeFile],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let marker = '';
    doomed.stdout!.on('data', (chunk) => (marker += chunk.toString()));
    await new Promise<void>((done) => doomed.once('close', () => done()));
    assert.match(marker, /KILL_BEFORE_COMMIT/);
    db = new FieldLabDatabase(path, { clock: () => 1000 + labSlotMs });
    assert.equal(canonicalCommand(db.load(id)), before);
    db.close();
    origin = await start();
    assert.deepEqual(await post('/simulation/instances', create, a), created);
    let read = await post('/simulation/read', { instance_id: id }, a);
    assert.equal(read.snapshot.results.length, 1);
    await writeFile(timeFile, String(1000 + 3 * 60 * 60 * 1000));
    await waitForStored(id, (s) => s.delivery_arrived);
    await kill();
    origin = await start();
    read = await post('/simulation/read', { instance_id: id }, a);
    assert.equal(read.snapshot.delivery.arrived, true);
    assert.equal(read.snapshot.totals.delivered_kits, 12);
    const receipts = await post('/simulation/instances', create, a);
    assert.deepEqual(receipts, created);
    await kill();
    db = new FieldLabDatabase(path, { clock: () => 1000 });
    const persisted = canonicalCommand(db.load(id));
    db.tick();
    assert.equal(canonicalCommand(db.load(id)), persisted);
    db.close();
  } finally {
    await kill();
    await rm(dir, { recursive: true, force: true });
  }
});
