import { createHash } from 'node:crypto';
import type {
  DomainModule,
  DomainPin,
  JsonObject,
  SimulationInstance,
} from '../simulation/contracts.js';
import type { JobPolicy, JobSchedule } from '../simulation/job-contracts.js';
import type {
  ResourceAccount,
  ResourceContext,
  ResourceItem,
} from '../simulation/resource-contracts.js';
import {
  controlJob,
  createJobSchedule,
  enqueueJob,
  jobScheduleSchema,
  validateJobSchedule,
} from '../simulation/jobs.js';
import {
  applyResourceOperation,
  createResourceLedger,
  ResourceLedgerError,
  resourceLedgerSchema,
  resourceTotals,
  validateResourceLedger,
} from '../simulation/resources.mjs';
import { identifier, objectSchema } from '../simulation/schema.js';
import { canonicalCommand } from '../simulation/commands.mjs';

export const workCellPin: DomainPin = {
  module_id: 'work-cell',
  module_version: 'fixture-v1',
  schema_version: 1,
};
/** Explicit fixture limits keep initialization grants and retained histories finite. */
export const workCellLimits = Object.freeze({
  jobs: 8,
  quantum_ms: 1000,
  duration_ms: 3000,
  step_energy_mj: 1000,
});
/** Typed state enters JSON only at the shared contract boundary. */
export function asJson(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
const kit: ResourceItem = { resource_id: 'kit', lot_id: 'kit', unit: 'count', quantity: 1 };
const energy: ResourceItem = {
  resource_id: 'energy',
  lot_id: 'charge',
  unit: 'mJ',
  quantity: 1000,
};

/** Neutral policy: one finite assay kit and three paid steps yield one explicitly modeled result. */
export const workCellPolicy: JobPolicy = {
  step(domain, step) {
    let ledger = validateResourceLedger(domain.resources);
    const context: ResourceContext = {
      instance_id: step.instance_id,
      rule: step.rule,
      principal_id: step.job.owner_id,
      job_id: step.job.id,
      command_id: step.effect_id,
      simulation_time_ms: step.at_ms,
    };
    const reservation = `${step.job.id}:kit`;
    let reserving = false;
    try {
      if (!ledger.reservations.some((r) => r.id === reservation)) {
        reserving = true;
        ledger = applyResourceOperation(ledger, context, {
          id: `${step.effect_id}:reserve`,
          kind: 'reserve',
          reservation_id: reservation,
          source: 'kits',
          holding: `hold-${step.job.id}`,
          items: [kit],
        });
      }
      reserving = false;
      ledger = applyResourceOperation(ledger, context, {
        id: `${step.effect_id}:energy`,
        kind: 'spend',
        source: 'energy',
        destination: 'spent',
        items: [energy],
      });
      const results = JSON.parse(JSON.stringify(domain.results)) as JsonObject[];
      if (step.completes_phase) {
        ledger = applyResourceOperation(
          ledger,
          context,
          {
            id: `${step.effect_id}:kit`,
            kind: 'use',
            reservation_id: reservation,
            items: [kit],
            outputs: [{ ...kit, account_id: 'spent' }],
            lots: [],
          },
          () => true,
        );
        ledger = applyResourceOperation(ledger, context, {
          id: `${step.effect_id}:complete`,
          kind: 'complete',
          reservation_id: reservation,
        });
        if (results.some((r) => r.job_id === step.job.id)) throw Error('DUPLICATE_RESULT');
        results.push({
          job_id: step.job.id,
          instrument_id: 'instrument',
          completed_at_ms: step.at_ms,
          origin: 'simulated',
          validity: 'modeled',
          value: 'fixture-complete',
        });
      }
      return { kind: 'worked', domain: { resources: asJson(ledger), results } };
    } catch (error) {
      if (error instanceof ResourceLedgerError && error.code === 'INSUFFICIENT_RESOURCE')
        return {
          kind: 'waiting',
          reason: reserving ? 'consumable:need-one-kit' : 'energy:need-1000-mJ',
        };
      throw error;
    }
  },
  interrupt(domain, job, action, at) {
    let ledger = validateResourceLedger(domain.resources);
    const reservation = ledger.reservations.find((r) => r.job_id === job.id && r.state === 'open');
    if (reservation && (action === 'cancel' || action === 'fail'))
      ledger = applyResourceOperation(
        ledger,
        {
          instance_id: ledger.instance_id,
          rule: ledger.rule,
          principal_id: job.owner_id,
          job_id: job.id,
          command_id: `${job.id}:stop:${job.completed_steps}`,
          simulation_time_ms: at,
        },
        {
          id: `${job.id}:stop:${job.completed_steps}`,
          kind: 'cancel',
          reservation_id: reservation.id,
        },
      );
    return { ...domain, resources: asJson(ledger) };
  },
  validate(domain) {
    validateResourceLedger(domain.resources);
  },
};

/** Initialize a one-owner envelope; the second energy account is a finite delivery source. */
export function createWorkCell(id: string, owner: string, now: number): SimulationInstance {
  const accounts: ResourceAccount[] = [
    'kits',
    'energy',
    'battery',
    'spent',
    ...Array.from({ length: 8 }, (_, i) => `hold-job-${i + 1}`),
  ].map((name) => ({
    id: name,
    kind: name === 'spent' ? 'spent' : name.startsWith('hold-') ? 'reserved' : 'stock',
    owner_id: owner,
    job_id: name.startsWith('hold-') ? name.slice(5) : null,
    allowed_resources: ['kit', 'energy'],
    lot_kinds: ['consumable', 'charge'],
    requirements: {},
    capacities: [],
  }));
  const resources = createResourceLedger({
    instance_id: id,
    rule: workCellPin,
    resources: [
      { id: 'kit', dimension: 'count', unit: 'count' },
      { id: 'energy', dimension: 'energy', unit: 'mJ' },
    ],
    accounts,
    lots: [
      { id: 'kit', kind: 'consumable', attributes: {} },
      { id: 'charge', kind: 'charge', attributes: {} },
    ],
    opening: [
      { ...kit, account_id: 'kits' },
      { ...energy, quantity: 2000, account_id: 'energy' },
      { ...energy, quantity: 3000, account_id: 'battery' },
    ],
  });
  return {
    contract_version: 1,
    id,
    pin: { ...workCellPin },
    revision: 1,
    simulation_time_ms: now,
    members: [{ principal_id: owner, role: 'owner' }],
    frames: [{ id: 'floor', unit: 'm', axes: 'xyz' }],
    entities: [
      {
        id: 'instrument',
        instance_id: id,
        kind: 'modeled-instrument',
        revision: 1,
        owner_id: owner,
        access: { read: 'owner', write: 'owner' },
        location: { frame_id: 'floor', unit: 'm', x: 0, y: 0, z: 0 },
        references: [],
        data: { status: 'ready', fixture_revision: 'v1' },
      },
    ],
    observations: [],
    state: {
      schedule: asJson(
        createJobSchedule(id, workCellPin, now, workCellLimits.quantum_ms, {
          resources: asJson(resources),
          results: [],
        }),
      ),
    },
  };
}

const resultSchema = objectSchema({
  job_id: identifier,
  instrument_id: { const: 'instrument' },
  completed_at_ms: { type: 'integer', minimum: 0 },
  origin: { const: 'simulated' },
  validity: { const: 'modeled' },
  value: { const: 'fixture-complete' },
});
const scheduleSchema = jobScheduleSchema();
scheduleSchema.properties.domain = objectSchema({
  resources: resourceLedgerSchema(),
  results: { type: 'array', maxItems: 8, items: resultSchema },
});
const projectionSchema = objectSchema({
  instance_id: identifier,
  revision: { type: 'integer', minimum: 1 },
  rule: objectSchema({
    module_id: { const: 'work-cell' },
    module_version: { const: 'fixture-v1' },
    schema_version: { const: 1 },
  }),
  simulation_time_ms: { type: 'integer', minimum: 0 },
  work_cursor_ms: { type: 'integer', minimum: 0 },
  catchup_pending_ms: { type: 'integer', minimum: 0 },
  instrument: objectSchema({ id: { const: 'instrument' }, kind: { const: 'modeled-instrument' } }),
  inventory: objectSchema({
    kits: { type: 'integer', minimum: 0 },
    energy_mj: { type: 'integer', minimum: 0 },
    battery_mj: { type: 'integer', minimum: 0 },
    spent_energy_mj: { type: 'integer', minimum: 0 },
  }),
  jobs: {
    type: 'array',
    maxItems: 8,
    items: objectSchema({
      id: identifier,
      state: { type: 'string' },
      reason: { anyOf: [{ type: 'null' }, { type: 'string' }] },
      work_ms: { type: 'integer', minimum: 0 },
    }),
  },
  results: { type: 'array', maxItems: 8, items: resultSchema },
});

/** Trusted statically registered non-game domain; no game map, opponent or victory hooks. */
export const workCellModule: DomainModule = {
  pin: workCellPin,
  stateSchema: objectSchema({ schedule: scheduleSchema }),
  commandSchema: objectSchema({
    action: { enum: ['start', 'deliver-energy', 'pause', 'resume', 'cancel'] },
    payload: {
      type: 'object',
      additionalProperties: false,
      properties: { job_id: identifier },
      required: [],
    },
  }),
  projectionSchema,
  migrations: [],
  validateInvariants(instance) {
    const schedule = validateJobSchedule(instance.state.schedule),
      ledger = validateResourceLedger(schedule.domain.resources);
    if (
      instance.members.length !== 1 ||
      instance.members[0]!.role !== 'owner' ||
      instance.entities.length !== 1 ||
      instance.entities[0]!.id !== 'instrument' ||
      schedule.instance_id !== instance.id ||
      ledger.instance_id !== instance.id ||
      canonicalCommand(schedule.rule) !== canonicalCommand(workCellPin) ||
      canonicalCommand(ledger.rule) !== canonicalCommand(workCellPin) ||
      schedule.jobs.length > 8 ||
      schedule.quantum_ms !== 1000 ||
      schedule.jobs.some(
        (j) =>
          j.owner_id !== instance.members[0]!.principal_id ||
          j.phases.length !== 1 ||
          j.phases[0]!.duration_ms !== 3000,
      )
    )
      throw Error('INVALID_WORK_CELL');
    if (
      canonicalCommand(resourceTotals(ledger.opening)) !==
      canonicalCommand({ kit: 1, energy: 5000 })
    )
      throw Error('INVALID_OPENING_STOCK');
    const results = schedule.domain.results as JsonObject[];
    if (
      results.length !== schedule.jobs.filter((j) => j.state === 'completed').length ||
      new Set(results.map((r) => r.job_id)).size !== results.length ||
      results.some((r) => !schedule.jobs.some((j) => j.id === r.job_id && j.state === 'completed'))
    )
      throw Error('INVALID_RESULTS');
    const spent = ledger.balances
      .filter((b) => b.account_id === 'spent' && b.resource_id === 'energy')
      .reduce((n, b) => n + b.quantity, 0);
    const consumedKits = ledger.balances
      .filter((b) => b.account_id === 'spent' && b.resource_id === 'kit')
      .reduce((n, b) => n + b.quantity, 0);
    if (consumedKits !== results.length) throw Error('INVALID_CONSUMABLE_SPENDING');
    if (spent !== schedule.jobs.reduce((n, j) => n + j.completed_steps * 1000, 0))
      throw Error('INVALID_SPENDING');
  },
  authorizeCommand: (instance, _command, context) =>
    instance.members[0]?.principal_id === context.principal_id,
  proposeTransition(instance, command, context) {
    let schedule = validateJobSchedule(instance.state.schedule);
    const hasJob = Object.hasOwn(command.payload, 'job_id');
    if (command.action === 'start') {
      if (hasJob) throw Error('INVALID_PAYLOAD');
      const id = `job-${schedule.jobs.length + 1}`;
      if (schedule.jobs.length >= 8) throw Error('JOB_LIMIT');
      schedule = enqueueJob(schedule, {
        id,
        owner_id: context.principal_id,
        priority: 0,
        dependencies: [],
        phases: [
          { id: 'modeled-assay', duration_ms: 3000, interruptions: ['pause', 'resume', 'cancel'] },
        ],
      });
    } else if (command.action === 'deliver-energy') {
      if (hasJob) throw Error('INVALID_PAYLOAD');
      const ledger = applyResourceOperation(
        schedule.domain.resources,
        {
          instance_id: instance.id,
          rule: instance.pin,
          job_id: null,
          principal_id: context.principal_id,
          command_id: command.command_id,
          simulation_time_ms: context.simulation_time_ms,
        },
        {
          id: `delivery:${createHash('sha256').update(command.command_id).digest('hex')}`,
          kind: 'transfer',
          source: 'battery',
          destination: 'energy',
          items: [energy],
        },
      );
      schedule.domain.resources = asJson(ledger);
    } else {
      if (!hasJob) throw Error('INVALID_PAYLOAD');
      schedule = controlJob(
        schedule,
        String(command.payload.job_id),
        context.principal_id,
        command.action as 'pause' | 'resume' | 'cancel',
        workCellPolicy,
      );
    }
    return { state: { schedule: asJson(schedule) }, events: [] };
  },
  project(instance) {
    const schedule = validateJobSchedule(instance.state.schedule),
      ledger = validateResourceLedger(schedule.domain.resources);
    const quantity = (account: string, resource: string): number =>
      ledger.balances
        .filter((b) => b.account_id === account && b.resource_id === resource)
        .reduce((n, b) => n + b.quantity, 0);
    return {
      instance_id: instance.id,
      revision: instance.revision,
      rule: asJson(instance.pin),
      simulation_time_ms: instance.simulation_time_ms,
      work_cursor_ms: schedule.cursor_ms,
      catchup_pending_ms:
        Math.floor((schedule.observed_at_ms - schedule.cursor_ms) / schedule.quantum_ms) *
        schedule.quantum_ms,
      instrument: { id: 'instrument', kind: 'modeled-instrument' },
      inventory: {
        kits: quantity('kits', 'kit'),
        energy_mj: quantity('energy', 'energy'),
        battery_mj: quantity('battery', 'energy'),
        spent_energy_mj: quantity('spent', 'energy'),
      },
      jobs: schedule.jobs.map((job) => ({
        id: job.id,
        state: job.state,
        reason: job.reason,
        work_ms: job.completed_steps * 1000,
      })),
      results: schedule.domain.results!,
    };
  },
};
