import { randomUUID } from 'node:crypto';
import type { CommandAdapter } from './command-contracts.js';
import type { JsonObject, SimulationCommand, SimulationInstance } from './contracts.js';
import type { EventProjection } from './event-contracts.js';
import type { JobSchedule } from './job-contracts.js';
import {
  canonicalCommand,
  executeTransactionalCommand,
  SimulationCommandError,
} from './commands.mjs';
import { SqliteEventHistory } from './events.mjs';
import { advanceJobSchedule, runJobWorker, validateJobSchedule } from './jobs.js';
import { DomainRegistry } from './registry.js';
import { SqliteAuthority } from './sqlite-authority.mjs';
import { copyJson } from './json.mjs';
import { authoritativeTime } from './time.mjs';
import { asJson, createWorkCell, workCellModule, workCellPolicy } from '../domains/work-cell.js';

/** Runtime conditions are separate from private domain errors and contain no stored data. */
export class SimulationRuntimeError extends Error {
  constructor(public readonly code: 'CATCHUP_REQUIRED' | 'LIMIT_REACHED' | 'INVALID_REQUEST') {
    super(code);
    this.name = 'SimulationRuntimeError';
  }
}

/** Production neutral adapter: shared native auth, contracts, commands, resources, jobs and history. */
export class SimulationDatabase extends SqliteAuthority {
  readonly registry = new DomainRegistry();
  readonly history: SqliteEventHistory;
  constructor(path: string, { clock = Date.now }: { clock?: () => number } = {}) {
    super(path, { clock, supportedVersions: [0, 100] });
    if (
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='matches'").get()
    ) {
      this.db.close();
      throw Error(
        'DOMAIN_DATABASE_MISMATCH: use a separate work-cell database; do not open a game save with this service.',
      );
    }
    this.registry.register(workCellModule);
    this.db.exec(`CREATE TABLE IF NOT EXISTS simulation_instances(id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE TABLE IF NOT EXISTS simulation_receipts(principal TEXT NOT NULL,command_id TEXT NOT NULL,instance_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(principal,command_id));`);
    this.history = new SqliteEventHistory(this.db);
    try {
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT state FROM simulation_instances').all())
          this.registry.validateInstance(JSON.parse(String(row.state)));
        this.db.exec('PRAGMA user_version=100');
      });
    } catch (error) {
      this.db.close();
      throw Error(
        'UNSUPPORTED_SIMULATION_SAVE: restore a compatible backup or run the exact module/schema version that wrote this database.',
        { cause: error },
      );
    }
  }
  /** Internal read; external callers must authenticate and use an authorized projection. */
  load(id: string): SimulationInstance {
    const row = this.db.prepare('SELECT state FROM simulation_instances WHERE id=?').get(id);
    if (!row) throw new SimulationCommandError('NOT_AVAILABLE');
    return JSON.parse(String(row.state)) as SimulationInstance;
  }
  /** Generic state+history persistence; the caller owns COMMIT and receipt insertion. */
  private save(
    instance: SimulationInstance,
    source: { kind: 'command' | 'worker' | 'system'; id: string; principal_id: string | null },
    action: string,
  ): void {
    this.registry.validateInstance(instance);
    const head = this.history.replay(instance.id);
    this.db
      .prepare('UPDATE simulation_instances SET state=? WHERE id=?')
      .run(JSON.stringify(instance), instance.id);
    const schedule = validateJobSchedule(instance.state.schedule);
    this.history.append({
      instance_id: instance.id,
      expected_sequence: head.sequence,
      rule: instance.pin,
      simulation_time_ms: instance.simulation_time_ms,
      revision: instance.revision,
      source,
      links: {
        entity_ids: instance.entities.map((e) => e.id),
        job_ids: schedule.jobs.map((j) => j.id),
      },
      provenance: { origin: 'simulated', validity: 'modeled', evidence: [] },
      units: [
        { field: 'work', unit: 'ms' },
        { field: 'energy', unit: 'mJ' },
        { field: 'kits', unit: 'count' },
      ],
      payload: { action },
      state: asJson(instance),
    });
  }
  /** Native bootstrap grants a fixed finite fixture once and shares immutable receipt semantics. */
  create(token: string, raw: unknown): JsonObject {
    raw=copyJson(raw,()=>{throw new SimulationRuntimeError('INVALID_REQUEST');});
    if (
      !raw ||
      typeof raw !== 'object' ||
      Object.keys(raw).join(',') !== 'command_id' ||
      !('command_id' in raw) ||
      typeof raw.command_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw.command_id)
    )
      throw new SimulationRuntimeError('INVALID_REQUEST');
    const commandId = raw.command_id;
    return this.transaction(() => {
      const principal = this.identity(token),
        request = canonicalCommand({ action: 'create-work-cell', command_id: commandId });
      const receipt = this.db
        .prepare('SELECT * FROM simulation_receipts WHERE principal=? AND command_id=?')
        .get(principal, commandId);
      if (receipt) {
        if (receipt.request !== request) throw new SimulationCommandError('COMMAND_ID_REUSED');
        this.registry.project(this.load(String(receipt.instance_id)), principal);
        return JSON.parse(String(receipt.result)) as JsonObject;
      }
      const owned = this.db
        .prepare(
          "SELECT count(*) n FROM simulation_instances WHERE json_extract(state,'$.members[0].principal_id')=?",
        )
        .get(principal);
      if (Number(owned?.n) >= 3) throw new SimulationRuntimeError('LIMIT_REACHED');
      const instance = createWorkCell(randomUUID(), principal, authoritativeTime(this.clock(), 0));
      this.registry.validateInstance(instance);
      this.db
        .prepare('INSERT INTO simulation_instances VALUES(?,?)')
        .run(instance.id, JSON.stringify(instance));
      this.history.initialize({
        instance_id: instance.id,
        rule: instance.pin,
        revision: instance.revision,
        simulation_time_ms: instance.simulation_time_ms,
        state: asJson(instance),
      });
      this.save(
        instance,
        { kind: 'command', id: commandId, principal_id: principal },
        'create-work-cell',
      );
      const result = {
        command_id: commandId,
        snapshot: this.registry.project(instance, principal),
      };
      this.db
        .prepare('INSERT INTO simulation_receipts VALUES(?,?,?,?,?)')
        .run(principal, commandId, instance.id, request, JSON.stringify(result));
      return result;
    });
  }
  /** Pure bounded progression used under the same lock as a command. */
  private prepare(instance: SimulationInstance, now: number): SimulationInstance {
    const schedule = advanceJobSchedule(
      validateJobSchedule(instance.state.schedule),
      now,
      100,
      workCellPolicy,
    );
    const next = {
      ...instance,
      simulation_time_ms: schedule.observed_at_ms,
      state: { schedule: asJson(schedule) },
    };
    if (schedule.observed_at_ms - schedule.cursor_ms >= schedule.quantum_ms)
      throw new SimulationRuntimeError('CATCHUP_REQUIRED');
    return next;
  }
  /** Authenticated revisioned dispatch through the same executor adopted by game commands. */
  execute(token: string, raw: unknown): JsonObject {
    let actor = '';
    const adapter: CommandAdapter<SimulationInstance, JsonObject> = {
      transaction: (work) => this.transaction(work),
      authenticate: () => {
        actor = this.identity(token);
        return actor;
      },
      load: (id) => this.load(id),
      instanceId: (state) => state.id,
      revision: (state) => state.revision,
      setRevision: (state, revision) => {
        state.revision = revision;
      },
      authorized: (state, principal) => state.members.some((m) => m.principal_id === principal),
      now: (state) => authoritativeTime(this.clock(), state.simulation_time_ms),
      prepare: (state, context) => this.prepare(state, context.simulation_time_ms),
      receipt: (principal, id) => {
        const row = this.db
          .prepare(
            'SELECT request,result FROM simulation_receipts WHERE principal=? AND command_id=?',
          )
          .get(principal, id);
        return row
          ? { request: String(row.request), result: JSON.parse(String(row.result)) as JsonObject }
          : undefined;
      },
      apply: (state, command, context) => {
        const count=Number(this.db.prepare('SELECT count(*) n FROM simulation_receipts WHERE instance_id=?').get(state.id)?.n);
        if(count>=256&&command.action!=='cancel')throw new SimulationRuntimeError('LIMIT_REACHED');
        const proposal = this.registry.transition(state, context.principal_id, command);
        return { state: { ...state, state: proposal.state }, events: proposal.events };
      },
      validate: (state) => {
        this.registry.validateInstance(state);
      },
      result: (state, command, context) => ({
        command_id: command.command_id,
        snapshot: this.registry.project(state, context.principal_id),
      }),
      save: (state) => {
        const command = raw as SimulationCommand;
        this.save(
          state,
          { kind: 'command', id: command.command_id, principal_id: actor },
          command.action,
        );
      },
      saveReceipt: (principal, command, request, result) => {
        this.db
          .prepare('INSERT INTO simulation_receipts VALUES(?,?,?,?,?)')
          .run(principal, command.command_id, command.instance_id, request, JSON.stringify(result));
      },
    };
    return executeTransactionalCommand(raw, adapter);
  }
  /** Read never projects raw state or advances jobs in a browser request. */
  read(token: string, id: string): JsonObject {
    return this.transaction(() => {
      const principal = this.identity(token);
      return this.registry.project(this.load(id), principal);
    });
  }
  /** Current ACL plus schema-checked historical projections; metadata is explicitly selected. */
  historyPage(token: string, request: unknown): unknown {
    return this.transaction(() => {
      const principal = this.identity(token);
      const policy: EventProjection = {
        version: 'work-cell-service-v1',
        authorize: (current, actor) =>
          (current as unknown as SimulationInstance).members.some((m) => m.principal_id === actor),
        validateState: (state) => {
          this.registry.validateInstance(state);
        },
        snapshot: (state, actor) => this.registry.project(state, actor),
        event: (event, actor) => ({
          id: event.id,
          instance_id: event.instance_id,
          command_id: event.source.kind === 'command' ? event.source.id : null,
          kind: event.source.kind,
          action: event.payload.action!,
          simulation_time_ms: event.simulation_time_ms,
          rule: asJson(event.rule),
          snapshot: this.registry.project(event.state, actor),
        }),
      };
      return this.history.read(request, principal, policy);
    });
  }
  /** Bounded worker uses saved policy/checkpoints independently of sessions or connected browsers. */
  tick(beforeCommit?: () => void): void {
    const rows = this.db
      .prepare(
        "SELECT id FROM simulation_instances ORDER BY json_extract(state,'$.simulation_time_ms'),id LIMIT 100",
      )
      .all();
    for (const row of rows) {
      const id = String(row.id);
      runJobWorker(id, 100, {
        transaction: (work) => this.transaction(work),
        clock: () => this.clock(),
        load: (instanceId) => {
          const instance = this.load(instanceId);
          this.registry.validateInstance(instance);
          return validateJobSchedule(instance.state.schedule);
        },
        policy: () => workCellPolicy,
        save: (schedule: JobSchedule) => {
          const instance = this.load(id);
          if (canonicalCommand(instance.state.schedule) === canonicalCommand(schedule)) return;
          instance.revision++;
          instance.simulation_time_ms = schedule.observed_at_ms;
          instance.state.schedule = asJson(schedule);
          this.save(
            instance,
            { kind: 'worker', id: 'scheduled-work', principal_id: null },
            'advance',
          );
          beforeCommit?.();
        },
      });
    }
    this.transaction(() => {
      this.db.prepare('UPDATE runtime SET heartbeat=? WHERE id=1').run(this.clock());
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.clock());
    });
  }
}
