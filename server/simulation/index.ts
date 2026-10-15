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

export type {
  JobStatus,
  JobControl,
  JobPhase,
  SimulationJob,
  JobSchedule,
  JobStepContext,
  JobStepResult,
  JobPolicy,
  JobWorkerAdapter,
} from './job-contracts.js';
export {
  SimulationJobError,
  jobScheduleSchema,
  validateJobSchedule,
  createJobSchedule,
  enqueueJob,
  controlJob,
  advanceJobSchedule,
  runJobWorker,
} from './jobs.js';
export { authoritativeTime } from './time.mjs';
export type {
  EventLinks,
  EventProvenance,
  EventCheckpoint,
  EventTransition,
  SimulationEvent,
  EventProjection,
  EventReadRequest,
  EventPage,
} from './event-contracts.js';
export { SqliteEventHistory, SimulationEventError } from './events.mjs';
