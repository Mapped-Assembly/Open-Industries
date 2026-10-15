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

export type { CommandAdapter, CommandProposal, CommandReceipt } from './command-contracts.js';
export { executeTransactionalCommand, SimulationCommandError } from './commands.mjs';

export type {
  ResourceUnit,
  ResourceDefinition,
  ResourceLot,
  ResourceAccount,
  ResourceItem,
  ResourceAllocation,
  ResourcePosting,
  ResourceContext,
  ResourceReservation,
  ResourceOperation,
  ResourceEntry,
  ResourceLedger,
  ResourcePolicy,
} from './resource-contracts.js';
export {
  ResourceLedgerError,
  createResourceLedger,
  validateResourceLedger,
  applyResourceOperation,
  resourceTotals,
  energyForPower,
  splitQuantity,
  assertResourceConservation,
} from './resources.mjs';
