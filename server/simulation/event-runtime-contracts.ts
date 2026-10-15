import type { DomainPin, JsonObject } from './contracts.js';
import type { JobStatus } from './job-contracts.js';
import type { ResourceAllocation, ResourcePosting, ResourceUnit } from './resource-contracts.js';

/** Exact paid progress for event-driven domain phases, including variable-rate charging. */
export interface EventJob {
  id: string;
  owner_id: string;
  kind: string;
  state: JobStatus;
  reason: string | null;
  progress_ms: number;
  checkpoint: JsonObject;
}
/** Policies choose physical event boundaries; the common clock owns iteration and cursor movement. */
export interface EventClockPolicy<T> {
  settle?(state: T, at: number): void;
  next(state: T, remaining: number): number;
  step(state: T, context: {from_ms:number;at_ms:number;duration_ms:number;effect_id:string}): void;
  validate(state: T): void;
}
/** Immutable account identity. Retired zero-balance accounts cannot be rebound to another owner/job. */
export interface BalanceAccount {
  id:string;
  kind:'stock'|'reserved'|'cargo'|'wip'|'output'|'waste'|'spill'|'spent';
  owner_id:string|null;
  job_id:string|null;
  unit:ResourceUnit;
  capacity:number|null;
}
/** Only explicit trusted policy may authorize metered energy or a one-time initialization grant. */
export interface ResourceCredit {
  resource_id:string;
  quantity:number;
  source_id:string;
  kind:'metered'|'bootstrap';
}
export interface BalanceContext {
  id:string;
  expected_sequence:number;
  simulation_time_ms:number;
  actor:{kind:'worker'|'command'|'migration';principal_id:string|null};
  job_ids:string[];
}
export interface BalancePosting extends ResourcePosting { unit:ResourceUnit; }
export interface BalanceEntry {
  sequence:number;
  context:BalanceContext;
  request_hash:string;
  postings:BalancePosting[];
  credits:ResourceCredit[];
  accounts:BalanceAccount[];
  previous_hash:string;
  hash:string;
}
/** Bounded posting tail plus a cutover checkpoint; opening + lifetime issued = current stock/sinks. */
export interface ResourceBalanceLedger {
  version:2;
  instance_id:string;
  rule:DomainPin;
  sequence:number;
  opening_totals:Record<string,number>;
  issued_totals:Record<string,number>;
  accounts:BalanceAccount[];
  balances:ResourceAllocation[];
  checkpoint:{sequence:number;simulation_time_ms:number;balances:ResourceAllocation[];issued_totals:Record<string,number>;hash:string};
  entries:BalanceEntry[];
}
export interface BalanceProposal {
  context:BalanceContext;
  accounts:BalanceAccount[];
  balances:ResourceAllocation[];
  credits:ResourceCredit[];
}
export type ResourceBalancePolicy = (before: Readonly<ResourceBalanceLedger>, proposal: Readonly<BalanceProposal>)=>boolean;
