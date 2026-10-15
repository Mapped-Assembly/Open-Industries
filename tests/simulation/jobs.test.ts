import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { JobPolicy, JobSchedule } from '../../server/simulation/job-contracts.js';
import {
  advanceJobSchedule,
  controlJob,
  enqueueJob,
  validateJobSchedule,
} from '../../server/simulation/jobs.js';
import {
  applyResourceOperation,
  resourceTotals,
  validateResourceLedger,
} from '../../server/simulation/resources.mjs';
import { JobFixture, jobDefinition, jobPolicy, jobSetup } from './job-fixture.js';
import { authoritativeTime } from '../../server/simulation/time.mjs';

/** Query one resource account without relying on ledger row order. */
function quantity(schedule: JobSchedule, account: string, resource: string): number {
  return validateResourceLedger(schedule.domain.resources)
    .balances.filter((b) => b.account_id === account && b.resource_id === resource)
    .reduce((n, b) => n + b.quantity, 0);
}
/** Move finite battery stock into machine charge under a trusted domain operation. */
function charge(schedule: JobSchedule): JobSchedule {
  const ledger = validateResourceLedger(schedule.domain.resources);
  schedule.domain.resources = JSON.parse(
    JSON.stringify(
      applyResourceOperation(
        ledger,
        {
          instance_id: schedule.instance_id,
          rule: schedule.rule,
          job_id: null,
          principal_id: 'alice',
          command_id: 'battery-delivery',
          simulation_time_ms: schedule.cursor_ms,
        },
        {
          id: 'battery-delivery',
          kind: 'transfer',
          source: 'cargo',
          destination: 'energy',
          items: [{ lot_id: 'charge-1', resource_id: 'energy', unit: 'mJ', quantity: 9000000 }],
        },
      ),
    ),
  );
  return schedule;
}

test('neutral process completes and exact frequent ticks equal long bounded catch-up', () => {
  const initial = jobSetup();
  let frequent = initial;
  for (let at = 1250; at <= 6000; at += 250)
    frequent = advanceJobSchedule(frequent, at, 100, jobPolicy);
  let catchup = advanceJobSchedule(initial, 6000, 2, jobPolicy);
  assert.equal(catchup.cursor_ms, 3000);
  assert.equal(catchup.observed_at_ms, 6000);
  assert.throws(() => enqueueJob(catchup, jobDefinition('job-2')), /INVALID_CONTROL/);
  catchup = advanceJobSchedule(catchup, 6000, 2, jobPolicy);
  catchup = advanceJobSchedule(catchup, 6000, 2, jobPolicy);
  assert.deepEqual(catchup, frequent);
  assert.equal(catchup.jobs[0]!.state, 'completed');
  assert.equal(quantity(catchup, 'product', 'copper'), 3000);
  assert.equal(quantity(catchup, 'spent', 'energy'), 4000000);
  assert.equal(quantity(catchup, 'waste', 'polymer'), 3500);
  assert.deepEqual(
    resourceTotals(validateResourceLedger(initial.domain.resources).opening),
    resourceTotals(validateResourceLedger(catchup.domain.resources).balances),
  );
  assert.deepEqual(initial, jobSetup());
});

test('rollback of the clock and identical worker retries cannot repeat effects', () => {
  const start = advanceJobSchedule(jobSetup(), 3000, 100, jobPolicy);
  assert.deepEqual(advanceJobSchedule(start, 2000, 100, jobPolicy), start);
  assert.deepEqual(advanceJobSchedule(start, 3000, 100, jobPolicy), start);
  assert.equal(quantity(start, 'product', 'copper'), 3000);
  const done = advanceJobSchedule(start, 5000, 100, jobPolicy);
  const retry = advanceJobSchedule(done, 5000, 100, jobPolicy);
  assert.deepEqual(retry, done);
  assert.throws(() => controlJob(done, 'job-1', 'alice', 'cancel', jobPolicy), /INVALID_CONTROL/);
});

test('energy wait discards partial reservation proposals; finite recharge resumes checkpoint', () => {
  let state = advanceJobSchedule(jobSetup(1000000), 4000, 100, jobPolicy);
  assert.equal(state.jobs[0]!.state, 'waiting-for-resource');
  assert.equal(state.jobs[0]!.reason, 'energy:need-1000000-mJ');
  assert.equal(state.jobs[0]!.completed_steps, 1);
  assert.equal(quantity(state, 'spent', 'energy'), 1000000);
  assert.equal(quantity(state, 'product', 'copper'), 0);
  state = advanceJobSchedule(charge(state), 7000, 100, jobPolicy);
  assert.equal(state.jobs[0]!.state, 'completed');
  assert.equal(quantity(state, 'spent', 'energy'), 4000000);
  assert.equal(quantity(state, 'product', 'copper'), 3000);
});

test('pause, recovery and retreat retain checkpoints; cancellation releases only remaining input', () => {
  let state = advanceJobSchedule(jobSetup(), 3000, 100, jobPolicy);
  for (const action of ['pause', 'recover', 'retreat'] as const) {
    state = controlJob(state, 'job-1', 'alice', action, jobPolicy);
    state = advanceJobSchedule(state, state.cursor_ms + 1000, 100, jobPolicy);
    assert.equal(state.jobs[0]!.state, 'paused');
    assert.equal(state.jobs[0]!.completed_steps, 2);
    assert.equal(quantity(state, 'spent', 'energy'), 2000000);
  }
  assert.throws(() => controlJob(state, 'job-1', 'mallory', 'resume', jobPolicy), /NOT_AVAILABLE/);
  state = controlJob(state, 'job-1', 'alice', 'resume', jobPolicy);
  state = controlJob(state, 'job-1', 'alice', 'cancel', jobPolicy);
  assert.equal(state.jobs[0]!.state, 'cancelled');
  assert.equal(quantity(state, 'stock', 'copper'), 3000);
  assert.equal(quantity(state, 'product', 'copper'), 3000);
  assert.equal(quantity(state, 'spent', 'energy'), 2000000);
  assert.equal(quantity(state, 'hold-1', 'copper'), 0);
});

test('phase-defined controls deny unsupported interruptions and resume needs pause', () => {
  let state = jobSetup();
  assert.throws(() => controlJob(state, 'job-1', 'alice', 'resume', jobPolicy), /INVALID_CONTROL/);
  state.jobs[0]!.phases[0]!.interruptions = [];
  assert.throws(() => controlJob(state, 'job-1', 'alice', 'cancel', jobPolicy), /INVALID_CONTROL/);
});

test('priority and stable ID decide contention for the last finite stock', () => {
  const initial = enqueueJob(jobSetup(), jobDefinition('job-2', 10));
  const state = advanceJobSchedule(initial, 2000, 100, jobPolicy);
  assert.equal(state.jobs.find((j) => j.id === 'job-2')!.state, 'running');
  assert.equal(state.jobs.find((j) => j.id === 'job-1')!.reason, 'feedstock:need-10000-g');
  assert.equal(quantity(state, 'hold-2', 'copper'), 6000);
  assert.equal(quantity(state, 'hold-1', 'copper'), 0);
  const tie = enqueueJob(jobSetup(), jobDefinition('job-2'));
  tie.jobs.reverse();
  assert.equal(
    advanceJobSchedule(tie, 2000, 100, jobPolicy).jobs.find((j) => j.id === 'job-1')!.state,
    'running',
  );
});

test('dependencies start on the following boundary; failure and cancellation propagate with cleanup', () => {
  let state = enqueueJob(jobSetup(), { ...jobDefinition('job-2'), dependencies: ['job-1'] });
  const policy: JobPolicy = { ...jobPolicy, step: (domain) => ({ kind: 'worked', domain }) };
  state = advanceJobSchedule(state, 5000, 100, policy);
  assert.equal(state.jobs[0]!.state, 'completed');
  assert.equal(state.jobs[1]!.completed_steps, 0);
  state = advanceJobSchedule(state, 6000, 100, policy);
  assert.equal(state.jobs[1]!.completed_steps, 1);
  let failed = advanceJobSchedule(jobSetup(), 2000, 100, jobPolicy);
  failed = advanceJobSchedule(failed, 3000, 100, {
    ...jobPolicy,
    step: () => ({ kind: 'failed', reason: 'machine:needs-repair' }),
  });
  assert.equal(failed.jobs[0]!.state, 'failed');
  assert.equal(quantity(failed, 'stock', 'copper'), 6000);
  assert.equal(quantity(failed, 'spent', 'energy'), 1000000);
  let cancelled = enqueueJob(jobSetup(), { ...jobDefinition('job-2'), dependencies: ['job-1'] });
  cancelled = controlJob(cancelled, 'job-1', 'alice', 'cancel', jobPolicy);
  cancelled = advanceJobSchedule(cancelled, 2000, 100, jobPolicy);
  assert.equal(cancelled.jobs[1]!.reason, 'dependency-terminal');
  assert.equal(cancelled.jobs[1]!.state, 'failed');
});

test('invalid, cyclic, oversized and inconsistent checkpoints fail before proposal mutation', () => {
  const original = jobSetup();
  for (const mutate of [
    (s: JobSchedule) => {
      s.quantum_ms = 0;
    },
    (s: JobSchedule) => {
      s.jobs[0]!.completed_steps = 1;
    },
    (s: JobSchedule) => {
      s.jobs[0]!.phase_work_ms = NaN;
    },
    (s: JobSchedule) => {
      s.jobs[0]!.phases[0]!.duration_ms = 1500;
    },
    (s: JobSchedule) => {
      s.jobs[0]!.dependencies = ['job-1'];
    },
    (s: JobSchedule) => {
      s.jobs[0]!.updated_at_ms = 2000;
    },
  ]) {
    const bad = structuredClone(original);
    mutate(bad);
    assert.throws(() => validateJobSchedule(bad), /INVALID_SCHEDULE/);
  }
  const cyclic = enqueueJob(original, { ...jobDefinition('job-2'), dependencies: ['job-1'] });
  cyclic.jobs[0]!.dependencies = ['job-2'];
  assert.throws(() => validateJobSchedule(cyclic), /INVALID_SCHEDULE/);
  const oversized = structuredClone(original);
  oversized.jobs = Array.from({ length: 129 }, (_, i) => ({
    ...oversized.jobs[0]!,
    id: `job-${i}`,
  }));
  assert.throws(() => validateJobSchedule(oversized), /INVALID_SCHEDULE/);
  for (const now of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => advanceJobSchedule(original, now, 1, jobPolicy), /INVALID_SCHEDULE/);
  for (const budget of [0, 1001, 1.5])
    assert.throws(() => advanceJobSchedule(original, 2000, budget, jobPolicy), /INVALID_SCHEDULE/);
  assert.throws(
    () =>
      advanceJobSchedule(original, 2000, 1, {
        ...jobPolicy,
        step: () => {
          throw new Error('domain-fault');
        },
      }),
    /domain-fault/,
  );
  assert.deepEqual(original, jobSetup());
});

test('shared game/server time guard rejects invalid clocks and preserves rollback clamp', () => {
  assert.equal(authoritativeTime(2000, 3000), 3000);
  assert.equal(authoritativeTime(4000, 3000), 4000);
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => authoritativeTime(value, 1000), /INVALID_SIMULATION_TIME/);
    assert.throws(() => authoritativeTime(1000, value), /INVALID_SIMULATION_TIME/);
  }
});

test('fractional-time enqueue and resume cannot earn work from before the operator action', () => {
  const policy: JobPolicy = { ...jobPolicy, step: (domain) => ({ kind: 'worked', domain }) };
  let state = advanceJobSchedule(jobSetup(), 1500, 100, policy);
  state = enqueueJob(state, jobDefinition('job-2', 10));
  state = advanceJobSchedule(state, 2000, 100, policy);
  assert.equal(state.jobs[0]!.completed_steps, 1);
  assert.equal(state.jobs[1]!.completed_steps, 0);
  state = advanceJobSchedule(state, 2500, 100, policy);
  state = controlJob(state, 'job-1', 'alice', 'pause', policy);
  state = controlJob(state, 'job-1', 'alice', 'resume', policy);
  state = advanceJobSchedule(state, 3000, 100, policy);
  assert.equal(state.jobs[0]!.completed_steps, 1);
  assert.equal(state.jobs[1]!.completed_steps, 1);
  state = advanceJobSchedule(state, 4000, 100, policy);
  assert.equal(state.jobs[0]!.completed_steps, 2);
});

/** Start an independent service writer, optionally kill it with an open transaction. */
function worker(path: string, now: number, crash = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./job-worker.ts', import.meta.url)),
        path,
        String(now),
        ...(crash ? ['crash'] : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let errors = '',
      killed = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('worker timeout'));
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
      else reject(new Error(errors));
    });
  });
}

test('independent worker survives hard kill, restart, replay and concurrent writer ticks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-jobs-')),
    path = join(dir, 'state.sqlite');
  try {
    let fixture = new JobFixture(path);
    fixture.seedJobs();
    fixture.wallNow = 2000;
    fixture.tick();
    fixture.db.close();
    await worker(path, 3000, true);
    fixture = new JobFixture(path);
    assert.equal(fixture.schedule().jobs[0]!.completed_steps, 1);
    fixture.db.close();
    await worker(path, 3000);
    fixture = new JobFixture(path);
    assert.equal(quantity(fixture.schedule(), 'product', 'copper'), 3000);
    fixture.db.close();
    await Promise.all([worker(path, 5000), worker(path, 5000)]);
    fixture = new JobFixture(path);
    assert.deepEqual(fixture.schedule(), advanceJobSchedule(jobSetup(), 5000, 100, jobPolicy));
    assert.equal(quantity(fixture.schedule(), 'spent', 'energy'), 4000000);
    fixture.db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('worker persistence failure rolls back; authorized control receipt replay is exact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-job-commands-'));
  const fixture = new JobFixture(join(dir, 'state.sqlite'));
  try {
    fixture.seedJobs();
    fixture.wallNow = 3000;
    assert.throws(
      () =>
        fixture.tick(100, () => {
          throw new Error('disk-fault');
        }),
      /disk-fault/,
    );
    assert.deepEqual(fixture.schedule(), jobSetup());
    fixture.tick();
    const command = {
      command_id: randomUUID(),
      instance_id: 'instance-1',
      expected_revision: fixture.read().revision,
      action: 'pause',
      payload: { job_id: 'job-1' },
    };
    const result = fixture.execute(command);
    const paused = fixture.schedule();
    assert.deepEqual(fixture.execute(command), result);
    assert.deepEqual(fixture.schedule(), paused);
    fixture.wallNow = 5000;
    fixture.tick();
    assert.equal(quantity(fixture.schedule(), 'spent', 'energy'), 2000000);
    fixture.execute({
      ...command,
      command_id: randomUUID(),
      expected_revision: fixture.read().revision,
      action: 'resume',
    });
    fixture.wallNow = 7000;
    fixture.tick();
    assert.equal(fixture.schedule().jobs[0]!.state, 'completed');
  } finally {
    fixture.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
