import type { DomainPin, JsonObject } from './contracts.js';

/** Stable references are scoped by the enclosing instance; no cross-instance links. */
export interface EventLinks {
  entity_ids: string[];
  job_ids: string[];
}
/** Observed validity is reserved for external evidence, never simulated/derived output. */
export interface EventProvenance {
  origin: 'simulated' | 'external' | 'observation-derived';
  validity: 'unknown' | 'modeled' | 'observed';
  evidence: { observation_id: string; source_id: string; source_revision: string }[];
}
/** Private materialized checkpoint. State hashes and raw state never bypass domain projections. */
export interface EventCheckpoint {
  sequence: number;
  rule: DomainPin;
  simulation_time_ms: number;
  revision: number;
  state: JsonObject;
  state_hash: string;
  chain_hash: string;
}
/** Input supplied by a trusted domain adapter under its existing write transaction. */
export interface EventTransition {
  instance_id: string;
  expected_sequence: number;
  rule: DomainPin;
  simulation_time_ms: number;
  revision: number;
  source: { kind: 'command' | 'worker' | 'system'; id: string; principal_id: string | null };
  links: EventLinks;
  provenance: EventProvenance;
  units: { field: string; unit: 'g' | 'mJ' | 'uL' | 'count' | 'ms' | 'm' | 'W' }[];
  payload: JsonObject;
  state: JsonObject;
}
/** Versioned post-state event; replay applies the stored replacement and never invokes effects. */
export interface SimulationEvent extends Omit<EventTransition, 'expected_sequence'> {
  version: 1;
  id: string;
  sequence: number;
  previous_hash: string;
  hash: string;
}
/** Trusted projections must select fields explicitly; null hides a historical state/event. */
export interface EventProjection {
  version: string;
  authorize(current: Readonly<JsonObject>, principal: string): boolean;
  validateState(state: Readonly<JsonObject>, rule: Readonly<DomainPin>): void;
  snapshot(state: Readonly<JsonObject>, principal: string, atMs: number): JsonObject | null;
  event(event: Readonly<SimulationEvent>, principal: string): JsonObject | null;
}
/** Cursor positions are encrypted and bound to principal, instance, projection and fixed head. */
export interface EventReadRequest {
  instance_id: string;
  cursor: string | null;
  limit: number;
}
export interface EventPage {
  version: 1;
  snapshot: JsonObject | null;
  checkpoint: JsonObject | null;
  events: JsonObject[];
  next_cursor: string | null;
}
