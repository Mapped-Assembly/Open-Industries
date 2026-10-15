import type { AnySchemaObject } from 'ajv';

/** JSON-only domain data; executable code belongs to trusted module definitions. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** Exact module/rule and state-schema versions pinned in each simulation instance. */
export interface DomainPin {
  module_id: string;
  module_version: string;
  schema_version: number;
}
/** Authentication resolves these principals server-side; memberships are stored state. */
export interface Membership {
  principal_id: string;
  role: 'owner' | 'operator' | 'viewer';
}
/** A frame defines the unit and coordinate convention; conversion is never implicit. */
export interface SpatialFrame {
  id: string;
  unit: 'm' | 'mm' | 'cell';
  axes: 'xyz' | 'xy-grid';
}
/** Stable references always include the instance namespace. */
export interface EntityReference {
  instance_id: string;
  entity_id: string;
}
/** Location references a declared frame, with exactly matching units. */
export interface SpatialReference {
  frame_id: string;
  unit: SpatialFrame['unit'];
  x: number;
  y: number;
  z: number;
}
/** Shared identity and authorization; domain-specific attributes stay in data. */
export interface SimulationEntity {
  id: string;
  instance_id: string;
  kind: string;
  revision: number;
  owner_id: string | null;
  access: { read: 'members' | 'owner'; write: 'operators' | 'owner' };
  location: SpatialReference | null;
  references: EntityReference[];
  data: JsonObject;
}
/** Evidence records retain provenance and unknown values independently of outcomes. */
export interface Observation {
  id: string;
  target: EntityReference;
  owner_id: string;
  source_id: string;
  source_revision: string;
  recorded_at_ms: number;
  origin: 'simulated' | 'external';
  validity: 'unknown' | 'modeled' | 'observed';
  value: JsonValue;
}
/** A generic persisted envelope: no required player count, towers or game results. */
export interface SimulationInstance {
  contract_version: 1;
  id: string;
  pin: DomainPin;
  revision: number;
  simulation_time_ms: number;
  members: Membership[];
  frames: SpatialFrame[];
  entities: SimulationEntity[];
  observations: Observation[];
  state: JsonObject;
}
/** Common command envelope; the shared executor owns persistence and revisions. */
export interface SimulationCommand {
  command_id: string;
  instance_id: string;
  expected_revision: number;
  action: string;
  payload: JsonObject;
}
/** Trusted context; clients never choose authenticated principal or simulation time. */
export interface DomainContext {
  principal_id: string;
  simulation_time_ms: number;
}
/** A proposed transition, not a committed mutation; #29 supplies transactional execution. */
export interface TransitionProposal {
  state: JsonObject;
  events: JsonObject[];
}
/** Future migrations are explicit offline proposals, never invoked on reads. */
export interface MigrationHook {
  from: DomainPin;
  migrate: (instance: Readonly<SimulationInstance>) => SimulationInstance;
}
/** Versioned trusted application module. No dynamic imports or uploaded scripts. */
export interface DomainModule {
  pin: DomainPin;
  stateSchema: AnySchemaObject;
  /** Schema for the domain {action, payload} object; common identity/revision fields are core-owned. */
  commandSchema: AnySchemaObject;
  projectionSchema: AnySchemaObject;
  validateInvariants: (instance: Readonly<SimulationInstance>) => void;
  authorizeCommand: (
    instance: Readonly<SimulationInstance>,
    command: Readonly<SimulationCommand>,
    context: DomainContext,
  ) => boolean;
  proposeTransition: (
    instance: Readonly<SimulationInstance>,
    command: Readonly<SimulationCommand>,
    context: DomainContext,
  ) => TransitionProposal;
  project: (instance: Readonly<SimulationInstance>, context: DomainContext) => JsonObject;
  migrations: readonly MigrationHook[];
}
