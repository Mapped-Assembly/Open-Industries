import type { JsonObject } from '../../server/simulation/contracts.js';
import type {
  JobControl,
  JobPolicy,
  JobSchedule,
  JobWorkerAdapter,
  SimulationJob,
} from '../../server/simulation/job-contracts.js';
import {
  controlJob,
  createJobSchedule,
  enqueueJob,
  jobScheduleSchema,
  runJobWorker,
  validateJobSchedule,
} from '../../server/simulation/jobs.js';
import type {
  ResourceContext,
  ResourceOperation,
} from '../../server/simulation/resource-contracts.js';
import {
  applyResourceOperation,
  createResourceLedger,
  ResourceLedgerError,
  validateResourceLedger,
} from '../../server/simulation/resources.mjs';
import { objectSchema } from '../../server/simulation/schema.js';
import { CommandFixture } from './command-fixture.js';
import { fixtureInstance, fixtureModule } from './fixtures.js';
import { feedItems, resourcePin, resourcePolicy, resourceSetup } from './resource-fixture.js';

/** JSON boundary helper for embedding typed accounting in versioned domain state. */
function json(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

/** Declared two-phase process: spend energy each second, recover copper then allocate residue. */
export const jobPolicy: JobPolicy = {
  step(domain, context) {
    let ledger = validateResourceLedger(domain.resources);
    const job = context.job;
    const ctx: ResourceContext = {
      instance_id: context.instance_id,
      rule: context.rule,
      job_id: job.id,
      principal_id: job.owner_id,
      command_id: context.effect_id,
      simulation_time_ms: context.at_ms,
    };
    const apply = (suffix: string, op: ResourceOperation): void => {
      ledger = applyResourceOperation(
        ledger,
        ctx,
        { ...op, id: `${context.effect_id}:${suffix}` },
        resourcePolicy,
      );
    };
    const reservation = `${job.id}:reservation`;
    try {
      if (!ledger.reservations.some((r) => r.id === reservation))
        apply('reserve', {
          id: '',
          kind: 'reserve',
          reservation_id: reservation,
          source: 'stock',
          holding: job.id === 'job-1' ? 'hold-1' : 'hold-2',
          items: feedItems(),
        });
      apply('energy', {
        id: '',
        kind: 'spend',
        source: 'energy',
        destination: 'spent',
        items: [{ lot_id: 'charge-1', resource_id: 'energy', unit: 'mJ', quantity: 1000000 }],
      });
      if (context.completes_phase && job.phase_index === 0)
        apply('product', {
          id: '',
          kind: 'use',
          reservation_id: reservation,
          items: [{ lot_id: 'feed-1', resource_id: 'copper', unit: 'g', quantity: 3000 }],
          lots: [
            {
              id: `${job.id}:product`,
              kind: 'product',
              attributes: { grade: 'fixture-copper', contamination: 'clean' },
            },
          ],
          outputs: [
            {
              account_id: 'product',
              lot_id: `${job.id}:product`,
              resource_id: 'copper',
              unit: 'g',
              quantity: 3000,
            },
          ],
        });
      if (context.completes_phase && job.phase_index === 1) {
        const held = ledger.balances.filter(
          (b) => b.account_id === (job.id === 'job-1' ? 'hold-1' : 'hold-2'),
        );
        ledger = applyResourceOperation(
          ledger,
          ctx,
          {
            id: `${context.effect_id}:residue`,
            kind: 'use',
            reservation_id: reservation,
            items: held.map(({ account_id: _, ...item }) => item),
            lots: [],
            outputs: held.map((item) => ({ ...item, account_id: 'waste' })),
          },
          () => true,
        );
        apply('complete', { id: '', kind: 'complete', reservation_id: reservation });
      }
      return { kind: 'worked', domain: { resources: json(ledger) } };
    } catch (error) {
      if (error instanceof ResourceLedgerError && error.code === 'INSUFFICIENT_RESOURCE')
        return {
          kind: 'waiting',
          reason: ledger.reservations.some((r) => r.id === reservation)
            ? 'energy:need-1000000-mJ'
            : 'feedstock:need-10000-g',
        };
      throw error;
    }
  },
  interrupt(domain, job, action, atMs) {
    let ledger = validateResourceLedger(domain.resources);
    const reservation = ledger.reservations.find((r) => r.job_id === job.id && r.state === 'open');
    if (reservation && (action === 'cancel' || action === 'fail'))
      ledger = applyResourceOperation(
        ledger,
        {
          instance_id: ledger.instance_id,
          rule: ledger.rule,
          job_id: job.id,
          principal_id: job.owner_id,
          command_id: `${job.id}:stop:${job.completed_steps}`,
          simulation_time_ms: atMs,
        },
        {
          id: `${job.id}:stop:${job.completed_steps}`,
          kind: 'cancel',
          reservation_id: reservation.id,
        },
      );
    return { resources: json(ledger) };
  },
  validate(domain) {
    validateResourceLedger(domain.resources);
  },
};

/** Fixed phase definitions belong to this neutral fixture, never to shared scheduling code. */
export function jobDefinition(
  id = 'job-1',
  priority = 0,
): Pick<SimulationJob, 'id' | 'owner_id' | 'priority' | 'dependencies' | 'phases'> {
  return {
    id,
    owner_id: 'alice',
    priority,
    dependencies: [],
    phases: ['recover-copper', 'allocate-residue'].map((id) => ({
      id,
      duration_ms: 2000,
      interruptions: ['pause', 'resume', 'recover', 'retreat', 'cancel'] as JobControl[],
    })),
  };
}

/** Finite inventory includes a separate battery; charging is a transfer, never a top-up. */
export function jobSetup(energy = 10000000): JobSchedule {
  const original = resourceSetup();
  const resources = createResourceLedger({
    ...original,
    lots: original.opening_lots,
    opening: original.opening.flatMap((row) =>
      row.resource_id === 'energy'
        ? [
            { ...row, quantity: energy },
            ...(energy < 10000000
              ? [{ ...row, account_id: 'cargo', quantity: 10000000 - energy }]
              : []),
          ]
        : [row],
    ),
  });
  return enqueueJob(
    createJobSchedule('instance-1', resourcePin, 1000, 1000, { resources: json(resources) }),
    jobDefinition(),
  );
}

/** Real SQLite command/worker transaction fixture; no match, second player or browser exists. */
export class JobFixture extends CommandFixture {
  constructor(
    path: string,
    public wallNow = 1000,
  ) {
    super(path);
    const module = fixtureModule('work-cell');
    module.pin = resourcePin;
    module.stateSchema = objectSchema({ schedule: jobScheduleSchema() });
    module.commandSchema = objectSchema({
      action: { enum: ['pause', 'resume', 'recover', 'retreat', 'cancel'] },
      payload: objectSchema({ job_id: { type: 'string' } }),
    });
    module.authorizeCommand = (instance, _command, context) =>
      instance.members.some((m) => m.principal_id === context.principal_id && m.role !== 'viewer');
    module.validateInvariants = (instance) => {
      const schedule = validateJobSchedule(instance.state.schedule);
      if (schedule.instance_id !== instance.id) throw new Error('WRONG_INSTANCE');
      jobPolicy.validate(schedule.domain);
    };
    module.proposeTransition = (instance, command, context) => ({
      state: {
        schedule: json(
          controlJob(
            validateJobSchedule(instance.state.schedule),
            String(command.payload.job_id),
            context.principal_id,
            command.action as JobControl,
            jobPolicy,
          ),
        ),
      },
      events: [],
    });
    this.registry.register(module);
  }
  /** Initialize a single-owner schedule before any worker runs. */
  seedJobs(schedule = jobSetup()): void {
    const instance = fixtureInstance();
    instance.pin = resourcePin;
    instance.state = { schedule: json(schedule) };
    this.seed(instance);
  }
  /** Load the durable authoritative checkpoint. */
  schedule(): JobSchedule {
    return validateJobSchedule(this.read().state.schedule);
  }
  /** Use the same lock as commands; fault injection runs after the write, before commit. */
  tick(maxSteps = 100, beforeCommit?: () => void): JobSchedule {
    const adapter: JobWorkerAdapter = {
      transaction: (work) => {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const result = work();
          this.db.exec('COMMIT');
          return result;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      },
      clock: () => this.wallNow,
      load: (id) => validateJobSchedule(this.read(id).state.schedule),
      policy: () => jobPolicy,
      save: (schedule) => {
        const instance = this.read(schedule.instance_id);
        instance.revision++;
        instance.simulation_time_ms = schedule.cursor_ms;
        instance.state.schedule = json(schedule);
        this.registry.validateInstance(instance);
        this.db
          .prepare('UPDATE instances SET state=? WHERE id=?')
          .run(JSON.stringify(instance), instance.id);
        beforeCommit?.();
      },
    };
    return runJobWorker('instance-1', maxSteps, adapter);
  }
}
