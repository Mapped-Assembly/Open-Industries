/** Internal simulation contract surface; no persistence or command execution is installed. */
export type {
  DomainContext,
  DomainModule,
  DomainPin,
  EntityReference,
  JsonObject,
  JsonValue,
  Membership,
  MigrationHook,
  Observation,
  SimulationCommand,
  SimulationEntity,
  SimulationInstance,
  SpatialFrame,
  SpatialReference,
  TransitionProposal,
} from './contracts.js';
export { DomainRegistry, SimulationContractError } from './registry.js';
export { commandSchema, instanceSchema, pinSchema, referenceSchema } from './schema.js';
