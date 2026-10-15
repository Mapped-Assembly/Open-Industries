import type { DomainPin, JsonObject } from './contracts.js';
/** Quantities are integer ticks in canonical units; power is never an inventory unit. */
export type ResourceUnit = 'g' | 'mJ' | 'uL' | 'count';
/** Domains name constituents separately; resources cannot implicitly transmute or exchange units. */
export interface ResourceDefinition {
  id: string;
  dimension: 'mass' | 'energy' | 'volume' | 'count';
  unit: ResourceUnit;
}
/** Grade/contamination semantics belong to the domain; unknown attributes stay explicit. */
export interface ResourceLot {
  id: string;
  kind: string;
  attributes: JsonObject;
}
/** Account capacities apply independently per unit, aggregating all matching constituents/lots. */
export interface ResourceAccount {
  id: string;
  kind: 'stock' | 'reserved' | 'cargo' | 'wip' | 'output' | 'waste' | 'spill' | 'spent';
  owner_id: string | null;
  job_id: string | null;
  allowed_resources: string[];
  lot_kinds: string[];
  requirements: JsonObject;
  capacities: { unit: ResourceUnit; quantity: number }[];
}
export interface ResourceItem {
  lot_id: string;
  resource_id: string;
  unit: ResourceUnit;
  quantity: number;
}
export interface ResourceAllocation extends ResourceItem {
  account_id: string;
}
export interface ResourcePosting {
  account_id: string;
  lot_id: string;
  resource_id: string;
  delta: number;
}
/** Every operation records the authenticated command/job and the exact domain rule pin. */
export interface ResourceContext {
  instance_id: string;
  command_id: string;
  principal_id: string;
  job_id: string | null;
  simulation_time_ms: number;
  rule: DomainPin;
}
export interface ResourceReservation {
  id: string;
  source: string;
  holding: string;
  job_id: string;
  principal_id: string;
  state: 'open' | 'cancelled' | 'completed';
}
export type ResourceOperation =
  | {
      id: string;
      kind: 'reserve';
      reservation_id: string;
      source: string;
      holding: string;
      items: ResourceItem[];
    }
  | {
      id: string;
      kind: 'use';
      reservation_id: string;
      items: ResourceItem[];
      outputs: ResourceAllocation[];
      lots: ResourceLot[];
    }
  | {
      id: string;
      kind: 'transfer' | 'spend';
      source: string;
      destination: string;
      items: ResourceItem[];
    }
  | { id: string; kind: 'cancel' | 'complete'; reservation_id: string };
/** Balanced postings and reservation updates are persisted with the enclosing domain state. */
export interface ResourceEntry {
  id: string;
  kind: ResourceOperation['kind'];
  context: ResourceContext;
  request: string;
  postings: ResourcePosting[];
  reservation: ResourceReservation | null;
  lots: ResourceLot[];
}
/** No new production table: instances may persist this bounded ledger through their command adapter. */
export interface ResourceLedger {
  version: 1;
  instance_id: string;
  rule: DomainPin;
  resources: ResourceDefinition[];
  accounts: ResourceAccount[];
  opening_lots: ResourceLot[];
  lots: ResourceLot[];
  opening: ResourceAllocation[];
  balances: ResourceAllocation[];
  reservations: ResourceReservation[];
  entries: ResourceEntry[];
}
/** Trusted domain policy approves transformations/grades; schema validity alone is insufficient. */
export type ResourcePolicy = (
  ledger: Readonly<ResourceLedger>,
  context: Readonly<ResourceContext>,
  operation: Readonly<ResourceOperation>,
) => boolean;
