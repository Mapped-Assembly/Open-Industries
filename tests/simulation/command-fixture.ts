import { DatabaseSync } from 'node:sqlite';
import type { CommandAdapter } from '../../server/simulation/command-contracts.js';
import type { JsonObject, SimulationInstance } from '../../server/simulation/contracts.js';
import {
  executeTransactionalCommand,
  SimulationCommandError,
} from '../../server/simulation/commands.mjs';
import { DomainRegistry, SimulationContractError } from '../../server/simulation/registry.js';
import { objectSchema } from '../../server/simulation/schema.js';
import { fixtureModule } from './fixtures.js';

/** Test-only tables: production generic persistence/event history remains #32/#33. */
export class CommandFixture {
  readonly db: DatabaseSync;
  readonly registry = new DomainRegistry();
  constructor(
    path: string,
    public token = 'alice-test-token',
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS instances(id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE TABLE IF NOT EXISTS test_sessions(token TEXT PRIMARY KEY,principal TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS command_receipts(principal TEXT,command_id TEXT,instance_id TEXT,request TEXT,result TEXT CHECK(json_valid(result)),PRIMARY KEY(principal,command_id));
      CREATE TABLE IF NOT EXISTS test_events(instance_id TEXT,command_id TEXT,position INTEGER,event TEXT CHECK(json_valid(event)),PRIMARY KEY(instance_id,command_id,position));`);
    const module = fixtureModule('work-cell');
    module.commandSchema = objectSchema({
      action: { enum: ['start', 'stop', 'invalid-state', 'invalid-event'] },
      payload: objectSchema({}),
    });
    module.authorizeCommand = (state, _command, context) =>
      state.members.some((m) => m.principal_id === context.principal_id && m.role !== 'viewer');
    module.proposeTransition = (state, command) => {
      if (command.action === 'invalid-state') return { state: { mode: 'broken' }, events: [] };
      if (command.action === 'invalid-event')
        return { state: { mode: 'working' }, events: [{ bad: NaN }] };
      if (
        (command.action === 'start' && state.state.mode !== 'idle') ||
        (command.action === 'stop' && state.state.mode !== 'working')
      )
        throw new SimulationContractError('INVALID_TRANSITION');
      return {
        state: { mode: command.action === 'start' ? 'working' : 'idle' },
        events: [{ kind: command.action }],
      };
    };
    this.registry.register(module);
  }
  /** Seed a single-operator instance and test credential, outside command execution. */
  seed(instance: SimulationInstance): void {
    this.db.prepare('INSERT INTO instances VALUES(?,?)').run(instance.id, JSON.stringify(instance));
    this.db
      .prepare('INSERT OR IGNORE INTO test_sessions VALUES(?,?)')
      .run('alice-test-token', 'alice');
  }
  /** Read the fixture's authoritative stored state. */
  read(id = 'instance-1'): SimulationInstance {
    const row = this.db.prepare('SELECT state FROM instances WHERE id=?').get(id);
    if (!row || typeof row.state !== 'string') throw new SimulationCommandError('NOT_AVAILABLE');
    return JSON.parse(row.state) as SimulationInstance;
  }
  /** Reuse the generic executor with real file-backed SQLite and registry domain hooks. */
  execute(
    raw: unknown,
    mutate?: (adapter: CommandAdapter<SimulationInstance, JsonObject>) => void,
  ): JsonObject {
    const adapter: CommandAdapter<SimulationInstance, JsonObject> = {
      transaction: (work) => {
        this.db.exec('BEGIN IMMEDIATE');
        try {
          const result = work();
          this.db.exec('COMMIT');
          return result;
        } catch (error) {
          this.db.exec('ROLLBACK');
          throw error;
        }
      },
      authenticate: () => {
        const row = this.db
          .prepare('SELECT principal FROM test_sessions WHERE token=?')
          .get(this.token);
        if (!row || typeof row.principal !== 'string')
          throw new SimulationCommandError('AUTH_REQUIRED');
        return row.principal;
      },
      load: (id) => this.read(id),
      instanceId: (state) => state.id,
      revision: (state) => state.revision,
      setRevision: (state, revision) => {
        state.revision = revision;
      },
      authorized: (state, principal) => state.members.some((m) => m.principal_id === principal),
      now: (state) => Math.max(2000, state.simulation_time_ms),
      prepare: (state, context) => ({ ...state, simulation_time_ms: context.simulation_time_ms }),
      receipt: (principal, id) => {
        const row = this.db
          .prepare('SELECT request,result FROM command_receipts WHERE principal=? AND command_id=?')
          .get(principal, id);
        return row
          ? { request: String(row.request), result: JSON.parse(String(row.result)) as JsonObject }
          : undefined;
      },
      apply: (state, command, context) => {
        const proposal = this.registry.transition(state, context.principal_id, command);
        return { state: { ...state, state: proposal.state }, events: proposal.events };
      },
      validate: (state) => {
        this.registry.validateInstance(state);
      },
      result: (state, _command, context) => ({
        revision: state.revision,
        ...this.registry.project(state, context.principal_id),
      }),
      save: (state) => {
        this.db
          .prepare('UPDATE instances SET state=? WHERE id=?')
          .run(JSON.stringify(state), state.id);
      },
      appendEvents: (instanceId, commandId, _principal, events) => {
        events.forEach((event, index) => {
          this.db
            .prepare('INSERT INTO test_events VALUES(?,?,?,?)')
            .run(instanceId, commandId, index, JSON.stringify(event));
        });
      },
      saveReceipt: (principal, command, request, result) => {
        this.db
          .prepare('INSERT INTO command_receipts VALUES(?,?,?,?,?)')
          .run(principal, command.command_id, command.instance_id, request, JSON.stringify(result));
      },
    };
    mutate?.(adapter);
    return executeTransactionalCommand(raw, adapter);
  }
}
