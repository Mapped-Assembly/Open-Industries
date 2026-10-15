import type {
  DomainModule,
  SimulationInstance,
  SimulationEntity,
} from '../../server/simulation/contracts.js';
import { identifier, objectSchema } from '../../server/simulation/schema.js';

const projectionSchema = objectSchema({
  instance_id: identifier,
  domain: identifier,
  entities: {
    type: 'array',
    maxItems: 4096,
    items: objectSchema({ id: identifier, kind: identifier }),
  },
  observations: {
    type: 'array',
    maxItems: 4096,
    items: objectSchema({
      id: identifier,
      validity: { enum: ['unknown', 'modeled', 'observed'] },
      value: {},
    }),
  },
});
/** Contract exemplars only: no gameplay execution, database or scheduler is installed. */
export function fixtureModule(kind: 'tower-defense' | 'work-cell'): DomainModule {
  return {
    pin: { module_id: kind, module_version: 'fixture-v1', schema_version: 1 },
    stateSchema: objectSchema(
      kind === 'tower-defense'
        ? {
            phase: { enum: ['waiting', 'active', 'completed'] },
            slots: { type: 'array', maxItems: 2, items: identifier },
          }
        : { mode: { enum: ['idle', 'working'] } },
    ),
    commandSchema: objectSchema({
      action: { const: 'fixture-inspect' },
      payload: objectSchema({
        target: objectSchema({ instance_id: identifier, entity_id: identifier }),
      }),
    }),
    projectionSchema,
    validateInvariants(instance): void {
      if (
        kind === 'tower-defense' &&
        (!Array.isArray(instance.state.slots) ||
          instance.state.slots.some((id) => !instance.members.some((m) => m.principal_id === id)))
      )
        throw new Error('INVALID_GAME_SLOTS');
    },
    authorizeCommand: () => false,
    proposeTransition: () => {
      throw new Error('CONTRACT_FIXTURE_ONLY');
    },
    project(instance, context) {
      return {
        instance_id: instance.id,
        domain: kind,
        entities: instance.entities
          .filter((e) => e.access.read === 'members' || e.owner_id === context.principal_id)
          .map((e) => ({ id: e.id, kind: e.kind })),
        observations: instance.observations
          .filter((o) => o.owner_id === context.principal_id)
          .map((o) => ({ id: o.id, validity: o.validity, value: o.value })),
      };
    },
    migrations: [],
  };
}
/** Create one owned entity whose private domain attributes must never appear in projections. */
export function fixtureEntity(instanceId: string, id: string, owner: string): SimulationEntity {
  return {
    id,
    instance_id: instanceId,
    kind: 'instrument',
    revision: 1,
    owner_id: owner,
    access: { read: 'owner', write: 'owner' },
    location: { frame_id: 'floor', unit: 'm', x: 1, y: 2, z: 0 },
    references: [],
    data: { hidden_composition: 'private-fixture' },
  };
}
/** Single-operator neutral state demonstrates that the envelope requires no game fields. */
export function fixtureInstance(
  kind: 'tower-defense' | 'work-cell' = 'work-cell',
): SimulationInstance {
  const instance: SimulationInstance = {
    contract_version: 1,
    id: 'instance-1',
    pin: fixtureModule(kind).pin,
    revision: 1,
    simulation_time_ms: 1000,
    members: [{ principal_id: 'alice', role: 'owner' }],
    frames: [{ id: 'floor', unit: 'm', axes: 'xyz' }],
    entities: [fixtureEntity('instance-1', 'instrument-1', 'alice')],
    observations: [
      {
        id: 'unknown-1',
        target: { instance_id: 'instance-1', entity_id: 'instrument-1' },
        owner_id: 'alice',
        source_id: 'sensor-1',
        source_revision: 'fixture-v1',
        recorded_at_ms: 500,
        origin: 'external',
        validity: 'unknown',
        value: null,
      },
    ],
    state: kind === 'tower-defense' ? { phase: 'waiting', slots: ['alice'] } : { mode: 'idle' },
  };
  return instance;
}
