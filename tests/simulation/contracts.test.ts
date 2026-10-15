import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainRegistry, SimulationContractError } from '../../server/simulation/registry.js';
import type { DomainModule, SimulationInstance } from '../../server/simulation/contracts.js';
import { fixtureEntity, fixtureInstance, fixtureModule } from './fixtures.js';

/** Test a safe code without depending on private validator diagnostics. */
function code(expected: SimulationContractError['code']): (error: unknown) => boolean {
  return (error) =>
    error instanceof SimulationContractError &&
    error.code === expected &&
    error.message === expected;
}
/** Each test gets independent module registrations and fixture state. */
function setup(): { registry: DomainRegistry; instance: SimulationInstance; module: DomainModule } {
  const registry = new DomainRegistry(),
    module = fixtureModule('work-cell');
  registry.register(module);
  registry.register(fixtureModule('tower-defense'));
  return { registry, instance: fixtureInstance(), module };
}

test('one registry accepts a game and a single-operator work cell without game-required envelope fields', () => {
  const { registry, instance } = setup();
  assert.equal(registry.validateInstance(instance).members.length, 1);
  assert.equal(registry.validateInstance(fixtureInstance('tower-defense')).state.phase, 'waiting');
  assert.deepEqual(registry.project(instance, 'alice'), {
    instance_id: 'instance-1',
    domain: 'work-cell',
    entities: [{ id: 'instrument-1', kind: 'instrument' }],
    observations: [{ id: 'unknown-1', validity: 'unknown', value: null }],
  });
  for (const field of ['players', 'towers', 'winner_slot', 'match_id'])
    assert(!Object.hasOwn(instance, field));
  assert.throws(
    () => registry.validateInstance({ ...instance, towers: [] }),
    code('INVALID_CONTRACT'),
  );
});

test('exact module/schema pins reject latest fallback, duplicate registrations and implicit migrations', () => {
  const { registry, instance, module } = setup();
  assert.throws(() => registry.register(module), code('DUPLICATE_MODULE'));
  assert.throws(
    () => registry.resolve({ ...instance.pin, module_id: 'missing' }),
    code('UNKNOWN_MODULE'),
  );
  for (const pin of [
    { ...instance.pin, module_version: 'fixture-v2' },
    { ...instance.pin, schema_version: 2 },
  ])
    assert.throws(
      () => registry.validateInstance({ ...instance, pin }),
      code('UNSUPPORTED_VERSION'),
    );
  const next = fixtureModule('work-cell');
  next.pin.module_version = 'fixture-v2';
  next.pin.schema_version = 2;
  let migrations = 0;
  next.migrations = [
    {
      from: instance.pin,
      migrate: (old) => {
        migrations++;
        return structuredClone(old);
      },
    },
  ];
  registry.register(next);
  assert.equal(registry.validateInstance(instance).pin.module_version, 'fixture-v1');
  assert.equal(migrations, 0);
  assert.throws(
    () => registry.resolve({ ...instance.pin, schema_version: 0 }),
    code('INVALID_CONTRACT'),
  );
  assert.throws(() => {
    registry.resolve(instance.pin).pin.schema_version = 7;
  }, TypeError);
});

test('registration clones schemas/pins and rejects malformed definitions without partial registration', () => {
  const registry = new DomainRegistry(),
    module = fixtureModule('work-cell');
  registry.register(module);
  module.pin.schema_version = 99;
  (module.stateSchema.properties as Record<string, unknown>).mode = { const: 'corrupted' };
  assert.equal(registry.validateInstance(fixtureInstance()).state.mode, 'idle');
  for (const patch of [
    { stateSchema: { type: 'object' } },
    { projectionSchema: { type: 'object', additionalProperties: false, brokenKeyword: true } },
    { migrations: [{ from: {}, migrate: () => null }] },
  ]) {
    const bad = { ...fixtureModule('tower-defense'), ...patch } as unknown as DomainModule;
    assert.throws(() => registry.register(bad), code('INVALID_CONTRACT'));
    assert.throws(() => registry.resolve(bad.pin), code('UNKNOWN_MODULE'));
  }
});

test('entity references reject nonexistent, duplicate and cross-instance targets before domain callbacks', () => {
  const { registry, instance } = setup();
  for (const ref of [
    { instance_id: 'elsewhere', entity_id: 'instrument-1' },
    { instance_id: instance.id, entity_id: 'missing' },
  ]) {
    const value = structuredClone(instance);
    value.entities[0].references.push(ref);
    assert.throws(() => registry.validateInstance(value), code('INVALID_REFERENCE'));
    assert.throws(() => registry.entity(instance, 'alice', ref), code('NOT_AVAILABLE'));
  }
  const duplicate = structuredClone(instance);
  duplicate.entities.push(structuredClone(duplicate.entities[0]));
  assert.throws(() => registry.validateInstance(duplicate), code('INVALID_CONTRACT'));
  const foreign = structuredClone(instance);
  foreign.entities[0].instance_id = 'elsewhere';
  assert.throws(() => registry.validateInstance(foreign), code('INVALID_REFERENCE'));
  const danglingObservation = structuredClone(instance);
  danglingObservation.observations[0].target.entity_id = 'missing';
  assert.throws(() => registry.validateInstance(danglingObservation), code('INVALID_REFERENCE'));
});

test('spatial units and frame conventions are explicit; no implicit scale conversion', () => {
  const { registry, instance } = setup();
  for (const unit of ['mm', 'cell']) {
    const value = structuredClone(instance);
    value.entities[0].location!.unit = unit as 'mm' | 'cell';
    assert.throws(() => registry.validateInstance(value), code('UNIT_MISMATCH'));
  }
  const grid = fixtureInstance('tower-defense');
  grid.frames[0] = { id: 'floor', unit: 'cell', axes: 'xy-grid' };
  grid.entities[0].location!.unit = 'cell';
  registry.validateInstance(grid);
  grid.entities[0].location!.x = 1.5;
  assert.throws(() => registry.validateInstance(grid), code('UNIT_MISMATCH'));
  grid.entities[0].location!.x = 1;
  grid.entities[0].location!.frame_id = 'absent';
  assert.throws(() => registry.validateInstance(grid), code('INVALID_REFERENCE'));
  const mm = structuredClone(instance);
  mm.frames[0].unit = 'mm';
  mm.entities[0].location!.unit = 'mm';
  assert.equal(
    registry.validateInstance(mm).entities[0].location!.x,
    1,
    'valid units do not silently rescale coordinates',
  );
});

test('cross-instance access and private entity reads/writes do not gain a host-owner bypass', () => {
  const { registry, instance } = setup();
  instance.members.push(
    { principal_id: 'bob', role: 'operator' },
    { principal_id: 'viewer', role: 'viewer' },
  );
  instance.entities.push(fixtureEntity(instance.id, 'bob-private', 'bob'));
  const ref = { instance_id: instance.id, entity_id: 'bob-private' };
  assert.throws(() => registry.entity(instance, 'alice', ref), code('NOT_AVAILABLE'));
  assert.equal(registry.entity(instance, 'bob', ref, 'write').id, 'bob-private');
  instance.entities[1].access = { read: 'members', write: 'operators' };
  assert.equal(registry.entity(instance, 'alice', ref, 'write').id, 'bob-private');
  assert.throws(() => registry.entity(instance, 'viewer', ref, 'write'), code('NOT_AVAILABLE'));
  assert.throws(() => registry.project(instance, 'outsider'), code('NOT_AVAILABLE'));
  assert.throws(() => registry.entity(instance, 'outsider', ref), code('NOT_AVAILABLE'));
  assert.throws(
    () =>
      registry.project(
        { ...instance, pin: { ...instance.pin, module_id: 'secret-module' } },
        'outsider',
      ),
    code('NOT_AVAILABLE'),
  );
});

test('unknown observations retain null/provenance and simulated outputs cannot become external evidence', () => {
  const { registry, instance } = setup();
  const checked = registry.validateInstance(instance);
  assert.equal(checked.observations[0].value, null);
  assert.equal(checked.observations[0].source_revision, 'fixture-v1');
  for (const patch of [
    { origin: 'simulated', validity: 'observed' },
    { origin: 'external', validity: 'modeled' },
    { validity: 'unknown', value: 42 },
  ]) {
    const bad = structuredClone(instance);
    Object.assign(bad.observations[0], patch);
    assert.throws(() => registry.validateInstance(bad), code('INVALID_CONTRACT'));
  }
  const future = structuredClone(instance);
  future.observations[0].recorded_at_ms = 1001;
  assert.throws(() => registry.validateInstance(future), code('INVALID_REFERENCE'));
});

test('authorized projections omit private state and callbacks cannot mutate validated inputs', () => {
  const { registry, instance } = setup();
  instance.members.push({ principal_id: 'bob', role: 'operator' });
  const visible = registry.project(instance, 'bob');
  assert.deepEqual(visible.entities, []);
  assert.deepEqual(visible.observations, []);
  assert(!JSON.stringify(visible).includes('private-fixture'));
  const original = structuredClone(instance);
  registry.project(instance, 'alice');
  assert.deepEqual(instance, original);
  assert.throws(() => {
    registry.validateInstance(instance).entities[0].data.secret = true;
  }, TypeError);
  const bad = fixtureModule('work-cell');
  bad.pin.module_version = 'bad-projection';
  bad.project = () => ({
    instance_id: instance.id,
    domain: 'work-cell',
    entities: [],
    observations: [],
    hidden_seed: 'leak',
  });
  registry.register(bad);
  assert.throws(
    () => registry.project({ ...instance, pin: bad.pin }, 'alice'),
    code('INVALID_PROJECTION'),
  );
});

test('non-JSON, nonfinite and malformed state is rejected at the boundary', () => {
  const { registry, instance } = setup();
  for (const state of [
    { mode: 'idle', extra: true },
    { mode: undefined },
    { mode: 'idle', value: NaN },
    { mode: 'idle', value: () => 1 },
    { mode: 'idle', value: 1n },
    { mode: 'idle', value: new Date() },
    { toJSON: () => ({ mode: 'idle' }) },
  ])
    assert.throws(
      () => registry.validateInstance({ ...instance, state }),
      code('INVALID_CONTRACT'),
    );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => registry.validateInstance(circular), code('INVALID_CONTRACT'));
  assert.throws(
    () => registry.validateInstance({ ...instance, revision: 0 }),
    code('INVALID_CONTRACT'),
  );
  assert.throws(
    () =>
      registry.validateInstance({
        ...instance,
        state: { mode: 'working' },
        simulation_time_ms: Infinity,
      }),
    code('INVALID_CONTRACT'),
  );
});

test('domain callback failures expose stable contract errors without private diagnostics', () => {
  const registry = new DomainRegistry(),
    module = fixtureModule('work-cell'),
    instance = fixtureInstance();
  module.validateInvariants = () => {
    throw new Error('secret-deposit-composition');
  };
  registry.register(module);
  assert.throws(() => registry.validateInstance(instance), code('INVALID_CONTRACT'));
  const projected = fixtureModule('work-cell');
  projected.pin.module_version = 'projection-error';
  projected.project = () => {
    throw new Error('secret-observation');
  };
  registry.register(projected);
  assert.throws(
    () => registry.project({ ...instance, pin: projected.pin }, 'alice'),
    code('INVALID_PROJECTION'),
  );
});
