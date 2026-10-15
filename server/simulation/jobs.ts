import Ajv from 'ajv';
import { advanceEventClock } from './event-clock.mjs';
import type { DomainPin, JsonObject } from './contracts.js';
import type {
  JobControl,
  JobPolicy,
  JobSchedule,
  JobWorkerAdapter,
  SimulationJob,
} from './job-contracts.js';
import { copyJson } from './json.mjs';
import { identifier, objectSchema, pinSchema } from './schema.js';

/** Invalid persisted checkpoints and unsupported controls fail closed, without a partial proposal. */
export class SimulationJobError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_SCHEDULE'
      | 'INVALID_CONTROL'
      | 'NOT_AVAILABLE'
      | 'LIMIT_REACHED',
  ) {
    super(code);
    this.name = 'SimulationJobError';
  }
}
function invalid(): never {
  throw new SimulationJobError('INVALID_SCHEDULE');
}
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const controls: JobControl[] = ['pause', 'resume', 'recover', 'retreat', 'cancel'];
const terminal = new Set(['completed', 'cancelled', 'failed']);
const schema = objectSchema({
  version: { const: 1 },
  instance_id: identifier,
  rule: pinSchema,
  quantum_ms: { ...integer, minimum: 1, maximum: 60000 },
  observed_at_ms: integer,
  cursor_ms: integer,
  jobs: {
    type: 'array',
    maxItems: 128,
    items: objectSchema({
      id: { ...identifier, maxLength: 64 },
      owner_id: identifier,
      priority: { type: 'integer', minimum: -1000, maximum: 1000 },
      dependencies: { type: 'array', maxItems: 128, uniqueItems: true, items: identifier },
      phases: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: objectSchema({
          id: identifier,
          duration_ms: { ...integer, minimum: 1 },
          interruptions: {
            type: 'array',
            uniqueItems: true,
            maxItems: 5,
            items: { enum: controls },
          },
        }),
      },
      state: {
        enum: [
          'queued',
          'running',
          'waiting-for-resource',
          'paused',
          'completed',
          'cancelled',
          'failed',
        ],
      },
      reason: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 256 }] },
      phase_index: integer,
      phase_work_ms: integer,
      completed_steps: integer,
      created_at_ms: integer,
      ready_at_ms: integer,
      updated_at_ms: integer,
    }),
  },
  domain: { type: 'object' },
});
const validate = new Ajv({ strict: true }).compile<JobSchedule>(schema);

/** Isolated schema for embedding checkpoints in a domain's versioned state schema. */
export function jobScheduleSchema(): typeof schema {
  return copyJson(schema, invalid);
}

/** Return an isolated, bounded checkpoint after structural and temporal consistency checks. */
export function validateJobSchedule(raw: unknown): JobSchedule {
  const copied = copyJson(raw, invalid);
  if (!validate(copied)) invalid();
  const value = copied as JobSchedule;
  if (value.cursor_ms > value.observed_at_ms) invalid();
  const jobs = new Map(value.jobs.map((job) => [job.id, job]));
  if (jobs.size !== value.jobs.length) invalid();
  for (const job of value.jobs) {
    if (
      job.created_at_ms > job.ready_at_ms ||
      job.ready_at_ms > job.updated_at_ms ||
      job.updated_at_ms > value.observed_at_ms ||
      job.phase_index > job.phases.length ||
      new Set(job.phases.map((p) => p.id)).size !== job.phases.length ||
      job.phases.some((p) => p.duration_ms % value.quantum_ms !== 0) ||
      job.phase_work_ms % value.quantum_ms !== 0 ||
      job.dependencies.some((id) => !jobs.has(id) || id === job.id)
    )
      invalid();
    const finished = job.phase_index === job.phases.length;
    if (
      finished !== (job.state === 'completed') ||
      (finished
        ? job.phase_work_ms !== 0
        : job.phase_work_ms >= job.phases[job.phase_index]!.duration_ms)
    )
      invalid();
    const work =
      job.phases.slice(0, job.phase_index).reduce((n, p) => n + BigInt(p.duration_ms), 0n) +
      BigInt(job.phase_work_ms);
    if (work !== BigInt(job.completed_steps) * BigInt(value.quantum_ms)) invalid();
    if (work > BigInt(Math.max(0, value.cursor_ms - job.created_at_ms))) invalid();
    if (
      ['paused', 'waiting-for-resource', 'failed', 'cancelled'].includes(job.state) !==
      (job.reason !== null)
    )
      invalid();
    if (job.state === 'queued' && job.completed_steps !== 0) invalid();
  }
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) invalid();
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of jobs.get(id)!.dependencies) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of jobs.keys()) visit(id);
  return value;
}

/** Initialize once at trusted server time; enqueue and controls must run under authorized commands. */
export function createJobSchedule(
  instanceId: string,
  rule: DomainPin,
  now: number,
  quantumMs: number,
  domain: JsonObject,
): JobSchedule {
  return validateJobSchedule({
    version: 1,
    instance_id: instanceId,
    rule,
    quantum_ms: quantumMs,
    observed_at_ms: now,
    cursor_ms: now,
    jobs: [],
    domain,
  });
}

/** Enqueue only at a caught-up boundary so historical debt cannot advance newly submitted work. */
export function enqueueJob(
  raw: JobSchedule,
  definition: Pick<SimulationJob, 'id' | 'owner_id' | 'priority' | 'dependencies' | 'phases'>,
): JobSchedule {
  const schedule = validateJobSchedule(raw);
  if (schedule.observed_at_ms - schedule.cursor_ms >= schedule.quantum_ms)
    throw new SimulationJobError('INVALID_CONTROL');
  if (schedule.jobs.length >= 128) throw new SimulationJobError('LIMIT_REACHED');
  schedule.jobs.push({
    ...copyJson(definition, invalid),
    state: 'queued',
    reason: null,
    phase_index: 0,
    phase_work_ms: 0,
    completed_steps: 0,
    created_at_ms: schedule.observed_at_ms,
    ready_at_ms: schedule.observed_at_ms,
    updated_at_ms: schedule.observed_at_ms,
  });
  return validateJobSchedule(schedule);
}

/** Operate at a committed checkpoint; recovery/retreat are domain actions and leave the job paused. */
export function controlJob(
  raw: JobSchedule,
  jobId: string,
  principal: string,
  action: JobControl,
  policy: JobPolicy,
): JobSchedule {
  const schedule = validateJobSchedule(raw);
  const job = schedule.jobs.find((j) => j.id === jobId);
  if (!job || job.owner_id !== principal) throw new SimulationJobError('NOT_AVAILABLE');
  if (
    !controls.includes(action) ||
    terminal.has(job.state) ||
    !job.phases[job.phase_index]!.interruptions.includes(action) ||
    (action === 'resume' && job.state !== 'paused')
  )
    throw new SimulationJobError('INVALID_CONTROL');
  // Controls cannot reach backward into unprocessed time; caller drains bounded debt first.
  if (schedule.observed_at_ms - schedule.cursor_ms >= schedule.quantum_ms)
    throw new SimulationJobError('INVALID_CONTROL');
  schedule.domain = copyJson(
    policy.interrupt(
      copyJson(schedule.domain, invalid),
      copyJson(job, invalid),
      action,
      schedule.observed_at_ms,
    ),
    invalid,
  );
  job.state =
    action === 'cancel'
      ? 'cancelled'
      : action === 'resume'
        ? job.completed_steps
          ? 'running'
          : 'queued'
        : 'paused';
  job.reason = action === 'resume' ? null : `operator:${action}`;
  job.updated_at_ms = schedule.observed_at_ms;
  if (action === 'resume') job.ready_at_ms = schedule.observed_at_ms;
  policy.validate(schedule.domain);
  return validateJobSchedule(schedule);
}

/**
 * Advance fixed event boundaries in deterministic priority/creation/id order. Waiting jobs retry
 * each boundary; failed proposals discard domain mutations. No unbounded offline jump or lost debt.
 */
export function advanceJobSchedule(
  raw: JobSchedule,
  wallNow: number,
  maxSteps: number,
  policy: JobPolicy,
): JobSchedule {
  const schedule = validateJobSchedule(raw);
  if (
    !Number.isSafeInteger(wallNow) ||
    wallNow < 0 ||
    !Number.isSafeInteger(maxSteps) ||
    maxSteps < 1 ||
    maxSteps > 1000
  )
    invalid();
  policy.validate(schedule.domain);
  return advanceEventClock(schedule, wallNow, maxSteps, {
    validate: (state) => { validateJobSchedule(state); policy.validate(state.domain); },
    next: (state, remaining) => remaining >= state.quantum_ms ? state.quantum_ms : 0,
    step: (schedule, {at_ms: at}) => {
    // Snapshot eligibility avoids dependency-order effects within one global boundary.
    const states = new Map(schedule.jobs.map((j) => [j.id, j.state]));
    const ordered = [...schedule.jobs].sort(
      (a, b) =>
        b.priority - a.priority ||
        a.created_at_ms - b.created_at_ms ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const job of ordered) {
      if (terminal.has(job.state) || job.state === 'paused') continue;
      if (at - job.ready_at_ms < schedule.quantum_ms) continue;
      const deps = job.dependencies.map((id) => states.get(id)!);
      if (deps.some((s) => s === 'failed' || s === 'cancelled')) {
        schedule.domain = copyJson(
          policy.interrupt(copyJson(schedule.domain, invalid), copyJson(job, invalid), 'fail', at),
          invalid,
        );
        job.state = 'failed';
        job.reason = 'dependency-terminal';
        job.updated_at_ms = at;
        continue;
      }
      if (deps.some((s) => s !== 'completed')) {
        job.state = 'waiting-for-resource';
        job.reason = 'dependency-incomplete';
        job.updated_at_ms = at;
        continue;
      }
      const phase = job.phases[job.phase_index]!;
      const completes = job.phase_work_ms + schedule.quantum_ms === phase.duration_ms;
      const result = policy.step(copyJson(schedule.domain, invalid), {
        instance_id: schedule.instance_id,
        rule: copyJson(schedule.rule, invalid),
        job: copyJson(job, invalid),
        phase: copyJson(phase, invalid),
        effect_id: `${job.id}:step:${job.completed_steps}`,
        at_ms: at,
        duration_ms: schedule.quantum_ms,
        completes_phase: completes,
      });
      job.updated_at_ms = at;
      if (result.kind === 'worked') {
        schedule.domain = copyJson(result.domain, invalid);
        job.completed_steps++;
        job.phase_work_ms += schedule.quantum_ms;
        if (completes) {
          job.phase_index++;
          job.phase_work_ms = 0;
        }
        job.state = job.phase_index === job.phases.length ? 'completed' : 'running';
        job.reason = null;
      } else if (result.kind === 'waiting') {
        job.state = 'waiting-for-resource';
        job.reason = result.reason;
      } else if (result.kind === 'failed') {
        schedule.domain = copyJson(
          policy.interrupt(copyJson(schedule.domain, invalid), copyJson(job, invalid), 'fail', at),
          invalid,
        );
        job.state = 'failed';
        job.reason = result.reason;
      } else invalid();
      policy.validate(schedule.domain);
    }
    },
  });
}

/** Server timer/service calls this under the existing storage lock, independently of sessions. */
export function runJobWorker(
  instanceId: string,
  maxSteps: number,
  adapter: JobWorkerAdapter,
): JobSchedule {
  return adapter.transaction(() => {
    const state = validateJobSchedule(adapter.load(instanceId));
    if (state.instance_id !== instanceId) throw new SimulationJobError('NOT_AVAILABLE');
    const next = advanceJobSchedule(
      state,
      adapter.clock(),
      maxSteps,
      adapter.policy(copyJson(state, invalid)),
    );
    adapter.save(next);
    return copyJson(next, invalid);
  });
}
