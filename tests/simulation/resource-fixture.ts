import type { JsonObject, SimulationInstance } from '../../server/simulation/contracts.js';
import type {
  ResourceAccount,
  ResourceContext,
  ResourceItem,
  ResourceLedger,
  ResourceOperation,
  ResourcePolicy,
} from '../../server/simulation/resource-contracts.js';
import {
  applyResourceOperation,
  createResourceLedger,
  resourceLedgerSchema,
  resourceOperationSchema,
  resourceTotals,
  validateResourceLedger,
} from '../../server/simulation/resources.mjs';
import { objectSchema } from '../../server/simulation/schema.js';
import { CommandFixture } from './command-fixture.js';
import { fixtureInstance, fixtureModule } from './fixtures.js';

export const resourcePin = {
  module_id: 'resource-work-cell',
  module_version: 'fixture-v1',
  schema_version: 1,
};
/** Domain fixture distinguishes feedstock, graded product, mixed waste and electrical charge. */
export function resourceSetup(): ResourceLedger {
  const accounts: ResourceAccount[] = [
    'stock',
    'cargo',
    'wip',
    'product',
    'waste',
    'energy',
    'spent',
    'spill',
    'hold-1',
    'hold-2',
  ].map((id) => ({
    id,
    kind: id.startsWith('hold')
      ? 'reserved'
      : id === 'product'
        ? 'output'
        : id === 'energy'
          ? 'stock'
          : (id as ResourceAccount['kind']),
    owner_id: 'alice',
    job_id: id === 'hold-1' ? 'job-1' : id === 'hold-2' ? 'job-2' : null,
    allowed_resources: ['copper', 'polymer', 'dirt', 'energy', 'kit'],
    lot_kinds: ['feed', 'product', 'charge', 'consumable'],
    requirements: {},
    capacities: [],
  }));
  accounts.find((a) => a.id === 'cargo')!.capacities = [{ unit: 'g', quantity: 10000 }];
  const product = accounts.find((a) => a.id === 'product')!;
  product.allowed_resources = ['copper'];
  product.lot_kinds = ['product'];
  product.requirements = { grade: 'fixture-copper', contamination: 'clean' };
  return createResourceLedger({
    instance_id: 'instance-1',
    rule: resourcePin,
    resources: [
      { id: 'copper', dimension: 'mass', unit: 'g' },
      { id: 'polymer', dimension: 'mass', unit: 'g' },
      { id: 'dirt', dimension: 'mass', unit: 'g' },
      { id: 'energy', dimension: 'energy', unit: 'mJ' },
      { id: 'kit', dimension: 'count', unit: 'count' },
    ],
    accounts,
    lots: [
      { id: 'feed-1', kind: 'feed', attributes: { grade: null, contamination: 'mixed' } },
      { id: 'charge-1', kind: 'charge', attributes: {} },
      { id: 'kit-1', kind: 'consumable', attributes: {} },
    ],
    opening: [
      { account_id: 'stock', lot_id: 'feed-1', resource_id: 'copper', unit: 'g', quantity: 6000 },
      { account_id: 'stock', lot_id: 'feed-1', resource_id: 'polymer', unit: 'g', quantity: 3500 },
      { account_id: 'stock', lot_id: 'feed-1', resource_id: 'dirt', unit: 'g', quantity: 500 },
      {
        account_id: 'energy',
        lot_id: 'charge-1',
        resource_id: 'energy',
        unit: 'mJ',
        quantity: 10000000,
      },
      { account_id: 'stock', lot_id: 'kit-1', resource_id: 'kit', unit: 'count', quantity: 1 },
    ],
  });
}
/** Initial 10 kg constituents, keeping each material separately accountable. */
export function feedItems(): ResourceItem[] {
  return [
    { lot_id: 'feed-1', resource_id: 'copper', unit: 'g', quantity: 6000 },
    { lot_id: 'feed-1', resource_id: 'polymer', unit: 'g', quantity: 3500 },
    { lot_id: 'feed-1', resource_id: 'dirt', unit: 'g', quantity: 500 },
  ];
}
/** Context is constructed from authenticated command/job state, never accepted as payload identity. */
export function resourceContext(commandId = 'resource-command', job = 'job-1'): ResourceContext {
  return {
    instance_id: 'instance-1',
    command_id: commandId,
    principal_id: 'alice',
    job_id: job,
    simulation_time_ms: 2000,
    rule: resourcePin,
  };
}
/** Fixture-only recipe authorization; real inspection/grade rules stay in domain modules. */
export const resourcePolicy: ResourcePolicy = (_ledger, _context, operation) =>
  operation.kind === 'use' &&
  operation.lots.every(
    (l) =>
      l.kind === 'product' &&
      l.attributes.grade === 'fixture-copper' &&
      l.attributes.contamination === 'clean',
  );
/** File-backed neutral integration fixture using the actual shared command and ledger APIs. */
export class ResourceFixture extends CommandFixture {
  constructor(path: string, token = 'alice-test-token') {
    super(path, token);
    const module = fixtureModule('work-cell');
    module.pin = resourcePin;
    module.stateSchema = objectSchema({ resources: resourceLedgerSchema() });
    module.commandSchema = objectSchema({
      action: { const: 'resource' },
      payload: resourceOperationSchema(),
    });
    module.validateInvariants = (instance) => {
      validateResourceLedger(instance.state.resources);
    };
    module.authorizeCommand = (instance, _command, context) =>
      instance.members.some((m) => m.principal_id === context.principal_id && m.role !== 'viewer');
    module.proposeTransition = (instance, command, context) => {
      const ledger = validateResourceLedger(instance.state.resources),
        op = command.payload as unknown as ResourceOperation;
      const job =
        op.kind === 'reserve'
          ? ledger.accounts.find((a) => a.id === op.holding)?.job_id
          : 'reservation_id' in op
            ? ledger.reservations.find((r) => r.id === op.reservation_id)?.job_id
            : 'job-1';
      const resourceContext = {
        instance_id: instance.id,
        principal_id: context.principal_id,
        command_id: command.command_id,
        job_id: job ?? null,
        simulation_time_ms: context.simulation_time_ms,
        rule: instance.pin,
      };
      // The domain couples its declared energy cost and output into one command transaction.
      const powered =
        op.kind === 'use'
          ? applyResourceOperation(ledger, resourceContext, {
              id: `${op.id}:energy`,
              kind: 'spend',
              source: 'energy',
              destination: 'spent',
              items: [{ lot_id: 'charge-1', resource_id: 'energy', unit: 'mJ', quantity: 1000000 }],
            })
          : ledger;
      const next = applyResourceOperation(powered, resourceContext, op, resourcePolicy);
      return {
        state: { resources: JSON.parse(JSON.stringify(next)) as JsonObject },
        events: [{ kind: 'resource-operation', operation_id: op.id }],
      };
    };
    this.registry.register(module);
  }
  /** Seed finite inventory; no resource top-up method exists after commands start. */
  seedResources(): void {
    const instance = fixtureInstance();
    instance.pin = resourcePin;
    instance.state = { resources: JSON.parse(JSON.stringify(resourceSetup())) as JsonObject };
    this.seed(instance);
  }
  /** Inspect private authoritative state in tests, not a production client projection. */
  ledger(): ResourceLedger {
    return validateResourceLedger(this.read().state.resources);
  }
  /** Preserve standard command execution while returning a bounded test summary. */
  run(command: unknown): JsonObject {
    return this.execute(command, (adapter) => {
      adapter.result = (state: SimulationInstance) => ({
        revision: state.revision,
        totals: resourceTotals(validateResourceLedger(state.state.resources).balances),
      });
    });
  }
}
