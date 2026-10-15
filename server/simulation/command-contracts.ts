import type { DomainContext, JsonObject, SimulationCommand } from './contracts.js';

/** An existing adapter can retain its historical request key and receipt bytes. */
export interface CommandReceipt<Result> {
  request: string;
  result: Result;
}
/** Domain proposals carry state and events only; the executor owns command revisions. */
export interface CommandProposal<State> {
  state: State;
  events: JsonObject[];
}
/** Trusted synchronous storage/domain adapter. All callbacks run inside one transaction. */
export interface CommandAdapter<State, Result> {
  transaction<T>(work: () => T): T;
  authenticate(): string;
  load(instanceId: string): State;
  instanceId(state: State): string;
  revision(state: State): number;
  setRevision(state: State, revision: number): void;
  authorized(state: State, principal: string): boolean;
  now(state: State): number;
  receipt(principal: string, commandId: string): CommandReceipt<Result> | undefined;
  requestKey?(command: SimulationCommand): string;
  prepare?(state: State, context: DomainContext): State;
  apply(state: State, command: SimulationCommand, context: DomainContext): CommandProposal<State>;
  validate(state: State): void;
  result(state: State, command: SimulationCommand, context: DomainContext): Result;
  save(state: State): void;
  /** Optional transactional append interface; nonempty events require an implementation. */
  appendEvents?(
    instanceId: string,
    commandId: string,
    principal: string,
    events: JsonObject[],
  ): void;
  saveReceipt(principal: string, command: SimulationCommand, request: string, result: Result): void;
}
