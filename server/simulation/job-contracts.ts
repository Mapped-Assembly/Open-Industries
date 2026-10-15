import type { DomainPin, JsonObject } from './contracts.js';

/** Terminal jobs retain checkpoints; only explicit domain hooks may release held resources. */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting-for-resource'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'failed';
export type JobControl = 'pause' | 'resume' | 'recover' | 'retreat' | 'cancel';
/** Durations are integer multiples of the schedule quantum; rate models belong to the domain. */
export interface JobPhase {
  id: string;
  duration_ms: number;
  interruptions: JobControl[];
}
/** Immutable definition plus persisted phase checkpoint and actionable blocking reason. */
export interface SimulationJob {
  id: string;
  owner_id: string;
  priority: number;
  dependencies: string[];
  phases: JobPhase[];
  state: JobStatus;
  reason: string | null;
  phase_index: number;
  phase_work_ms: number;
  completed_steps: number;
  created_at_ms: number;
  /** Creation/resume boundary; prevents earning work for time before an operator action. */
  ready_at_ms: number;
  updated_at_ms: number;
}
/** Observed time is a high-water mark; cursor debt is retained across bounded worker calls. */
export interface JobSchedule {
  version: 1;
  instance_id: string;
  rule: DomainPin;
  quantum_ms: number;
  observed_at_ms: number;
  cursor_ms: number;
  jobs: SimulationJob[];
  domain: JsonObject;
}
/** Stable effect identity survives retries, clock rollback and service restarts. */
export interface JobStepContext {
  instance_id: string;
  rule: DomainPin;
  job: Readonly<SimulationJob>;
  phase: Readonly<JobPhase>;
  effect_id: string;
  at_ms: number;
  duration_ms: number;
  completes_phase: boolean;
}
export type JobStepResult =
  | { kind: 'worked'; domain: JsonObject }
  | { kind: 'waiting'; reason: string }
  | { kind: 'failed'; reason: string };
/** Trusted synchronous pure proposals; no I/O or wall-clock reads inside hooks. */
export interface JobPolicy {
  step(domain: JsonObject, context: JobStepContext): JobStepResult;
  /** Cancel/failure must release only unused reservations; pause/recovery preserve checkpoints. */
  interrupt(
    domain: JsonObject,
    job: Readonly<SimulationJob>,
    action: JobControl | 'fail',
    atMs: number,
  ): JsonObject;
  validate(domain: JsonObject): void;
}
/** Existing storage transaction owns load, advance, validate and save together. No browser required. */
export interface JobWorkerAdapter {
  transaction<T>(work: () => T): T;
  clock(): number;
  load(instanceId: string): JobSchedule;
  save(schedule: JobSchedule): void;
  policy(schedule: Readonly<JobSchedule>): JobPolicy;
}
