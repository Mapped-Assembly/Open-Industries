import { copyJson } from './json.mjs';
import Ajv, { type ValidateFunction } from 'ajv';
import type {
  DomainModule,
  DomainPin,
  EntityReference,
  JsonObject,
  SimulationCommand,
  TransitionProposal,
  SimulationEntity,
  SimulationInstance,
} from './contracts.js';
import {
  instanceSchema,
  pinSchema,
  referenceSchema,
  commandSchema,
  objectSchema,
} from './schema.js';

/** Stable boundary errors contain no domain state or validator value dumps. */
export class SimulationContractError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_CONTRACT'
      | 'UNKNOWN_MODULE'
      | 'UNSUPPORTED_VERSION'
      | 'DUPLICATE_MODULE'
      | 'INVALID_REFERENCE'
      | 'UNIT_MISMATCH'
      | 'NOT_AVAILABLE'
      | 'INVALID_PROJECTION'
      | 'INVALID_TRANSITION'
      | 'CONFLICT',
  ) {
    super(code);
    this.name = 'SimulationContractError';
  }
}
/** Raise a public-safe boundary failure without state or validator diagnostics. */
function fail(code: SimulationContractError['code']): never {
  throw new SimulationContractError(code);
}
const ajv = new Ajv({ strict: true, allErrors: false, validateFormats: false });
const validEnvelope = ajv.compile(instanceSchema);
const validPin = ajv.compile(pinSchema);
const validReference = ajv.compile(referenceSchema);
const validCommand = ajv.compile(commandSchema);
const validProposal = ajv.compile(
  objectSchema({
    state: { type: 'object' },
    events: { type: 'array', maxItems: 256, items: { type: 'object' } },
  }),
);
const key = (pin: DomainPin): string =>
  JSON.stringify([pin.module_id, pin.module_version, pin.schema_version]);

/** Clone contract data using the same JSON boundary as transactional commands. */
function cloneJson<T>(value: T): T {
  return copyJson(value, () => fail('INVALID_CONTRACT'));
}
/** Recursively freeze data handed to trusted module callbacks. */
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
interface Registered {
  module: DomainModule;
  state: ValidateFunction;
  command: ValidateFunction;
  projection: ValidateFunction;
}

/** Internal validation/projection registry; does not schedule, migrate or commit commands. */
export class DomainRegistry {
  private readonly modules = new Map<string, Registered>();

  /** Register one exact trusted module/schema version without overwriting existing pins. */
  register(definition: DomainModule): void {
    if (!validPin(definition.pin)) fail('INVALID_CONTRACT');
    const pin = freeze(cloneJson(definition.pin));
    if (this.modules.has(key(pin))) fail('DUPLICATE_MODULE');
    if (
      !['validateInvariants', 'authorizeCommand', 'proposeTransition', 'project'].every(
        (name) => typeof definition[name as keyof DomainModule] === 'function',
      ) ||
      !Array.isArray(definition.migrations)
    )
      fail('INVALID_CONTRACT');
    try {
      for (const hook of definition.migrations)
        if (!validPin(hook.from) || typeof hook.migrate !== 'function') fail('INVALID_CONTRACT');
      // Compile cloned schemas so later caller mutation cannot change this registration.
      const schemas = [
        definition.stateSchema,
        definition.commandSchema,
        definition.projectionSchema,
      ].map((schema) => {
        if (schema.type !== 'object' || schema.additionalProperties !== false)
          fail('INVALID_CONTRACT');
        return freeze(cloneJson(schema));
      });
      const validators = schemas.map((schema) => ajv.compile(schema));
      const module = Object.freeze({
        ...definition,
        pin,
        stateSchema: schemas[0],
        commandSchema: schemas[1],
        projectionSchema: schemas[2],
        migrations: Object.freeze(
          definition.migrations.map((hook) =>
            Object.freeze({ ...hook, from: freeze(cloneJson(hook.from)) }),
          ),
        ),
      });
      this.modules.set(key(pin), {
        module,
        state: validators[0],
        command: validators[1],
        projection: validators[2],
      });
    } catch {
      fail('INVALID_CONTRACT');
    }
  }

  /** Resolve an exact pin; never substitute latest code or silently run migrations. */
  resolve(pin: DomainPin): Readonly<DomainModule> {
    if (!validPin(pin)) fail('INVALID_CONTRACT');
    const entry = this.modules.get(key(pin));
    if (!entry)
      fail(
        [...this.modules.values()].some((e) => e.module.pin.module_id === pin.module_id)
          ? 'UNSUPPORTED_VERSION'
          : 'UNKNOWN_MODULE',
      );
    return entry.module;
  }

  /** Validate a trusted stored envelope and its domain invariants; not a public read API. */
  validateInstance(raw: unknown): Readonly<SimulationInstance> {
    const instance = cloneJson(raw);
    if (!validEnvelope(instance)) fail('INVALID_CONTRACT');
    const value = instance as SimulationInstance;
    this.resolve(value.pin);
    const members = new Set(value.members.map((m) => m.principal_id));
    const entities = new Map(value.entities.map((e) => [e.id, e]));
    const frames = new Map(value.frames.map((f) => [f.id, f]));
    for (const frame of value.frames)
      if ((frame.axes === 'xy-grid') !== (frame.unit === 'cell')) fail('UNIT_MISMATCH');
    if (
      !members.size ||
      members.size !== value.members.length ||
      entities.size !== value.entities.length ||
      frames.size !== value.frames.length ||
      new Set(value.observations.map((o) => o.id)).size !== value.observations.length
    )
      fail('INVALID_CONTRACT');
    const reference = (ref: EntityReference): void => {
      if (ref.instance_id !== value.id || !entities.has(ref.entity_id)) fail('INVALID_REFERENCE');
    };
    for (const entity of value.entities) {
      if (
        entity.instance_id !== value.id ||
        (entity.owner_id !== null && !members.has(entity.owner_id))
      )
        fail('INVALID_REFERENCE');
      if (
        entity.owner_id === null &&
        (entity.access.read === 'owner' || entity.access.write === 'owner')
      )
        fail('INVALID_CONTRACT');
      for (const ref of entity.references) reference(ref);
      if (entity.location) {
        const frame = frames.get(entity.location.frame_id);
        if (!frame) fail('INVALID_REFERENCE');
        if (
          frame.unit !== entity.location.unit ||
          (frame.axes === 'xy-grid' &&
            (entity.location.z !== 0 ||
              !Number.isInteger(entity.location.x) ||
              !Number.isInteger(entity.location.y)))
        )
          fail('UNIT_MISMATCH');
      }
    }
    for (const observation of value.observations) {
      reference(observation.target);
      if (
        !members.has(observation.owner_id) ||
        observation.recorded_at_ms > value.simulation_time_ms
      )
        fail('INVALID_REFERENCE');
      if (
        (observation.origin === 'simulated' && observation.validity === 'observed') ||
        (observation.origin === 'external' && observation.validity === 'modeled') ||
        (observation.validity === 'unknown' && observation.value !== null)
      )
        fail('INVALID_CONTRACT');
    }
    const entry = this.modules.get(key(value.pin))!;
    if (!entry.state(value.state)) fail('INVALID_CONTRACT');
    freeze(value);
    try {
      entry.module.validateInvariants(value);
    } catch {
      fail('INVALID_CONTRACT');
    }
    return value;
  }

  /** Deny unknown principals before invoking any domain callback or exposing private state. */
  private authorized(raw: unknown, principal: string): Readonly<SimulationInstance> {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('members' in raw) ||
      !Array.isArray(raw.members) ||
      !raw.members.some(
        (m: unknown) =>
          m && typeof m === 'object' && 'principal_id' in m && m.principal_id === principal,
      )
    )
      fail('NOT_AVAILABLE');
    return this.validateInstance(raw);
  }

  /** Resolve references only within one instance, enforcing entity visibility and write rights. */
  entity(
    raw: unknown,
    principal: string,
    ref: EntityReference,
    mode: 'read' | 'write' = 'read',
  ): Readonly<SimulationEntity> {
    const instance = this.authorized(raw, principal);
    if (!validReference(ref) || ref.instance_id !== instance.id) fail('NOT_AVAILABLE');
    const entity = instance.entities.find((e) => e.id === ref.entity_id);
    if (!entity || (entity.access.read === 'owner' && entity.owner_id !== principal))
      fail('NOT_AVAILABLE');
    if (
      mode === 'write' &&
      (instance.members.find((m) => m.principal_id === principal)?.role === 'viewer' ||
        (entity.access.write === 'owner' && entity.owner_id !== principal))
    )
      fail('NOT_AVAILABLE');
    return entity;
  }

  /** Propose a pure domain-state transition; storage/receipts remain the executor's responsibility. */
  transition(raw: unknown, principal: string, input: unknown): TransitionProposal {
    const instance = this.authorized(raw, principal);
    const command = cloneJson(input);
    if (!validCommand(command)) fail('INVALID_TRANSITION');
    const value = command as SimulationCommand;
    if (value.instance_id !== instance.id) fail('NOT_AVAILABLE');
    if (value.expected_revision !== instance.revision) fail('CONFLICT');
    const entry = this.modules.get(key(instance.pin))!;
    if (!entry.command({ action: value.action, payload: value.payload }))
      fail('INVALID_TRANSITION');
    const context = { principal_id: principal, simulation_time_ms: instance.simulation_time_ms };
    freeze(value);
    freeze(context);
    let proposal: TransitionProposal;
    try {
      if (entry.module.authorizeCommand(instance, value, context) !== true) fail('NOT_AVAILABLE');
      proposal = cloneJson(entry.module.proposeTransition(instance, value, context));
    } catch (error) {
      if (error instanceof SimulationContractError && error.code === 'NOT_AVAILABLE') throw error;
      return fail('INVALID_TRANSITION');
    }
    if (!validProposal(proposal)) fail('INVALID_TRANSITION');
    try {
      this.validateInstance({ ...instance, state: proposal.state });
    } catch {
      return fail('INVALID_TRANSITION');
    }
    return proposal;
  }

  /** Return only a module's schema-checked authorized projection, never the raw envelope. */
  project(raw: unknown, principal: string): JsonObject {
    const instance = this.authorized(raw, principal);
    const entry = this.modules.get(key(instance.pin))!;
    let projection: JsonObject;
    try {
      projection = cloneJson(
        entry.module.project(instance, {
          principal_id: principal,
          simulation_time_ms: instance.simulation_time_ms,
        }),
      );
    } catch {
      return fail('INVALID_PROJECTION');
    }
    if (!entry.projection(projection)) fail('INVALID_PROJECTION');
    return projection;
  }
}
