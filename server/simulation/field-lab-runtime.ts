import { randomUUID } from 'node:crypto';
import type { JsonObject, SimulationCommand, SimulationInstance } from './contracts.js';
import type { CommandAdapter } from './command-contracts.js';
import { SqliteAuthority } from './sqlite-authority.mjs';
import {
  canonicalCommand,
  executeTransactionalCommand,
  SimulationCommandError,
} from './commands.mjs';
import { DomainRegistry } from './registry.js';
import { SqliteEventHistory } from './events.mjs';
import { authoritativeTime } from './time.mjs';
import { copyJson } from './json.mjs';
import { asJson } from '../domains/work-cell.js';
import {
  advanceLab,
  createLab,
  fieldLabModule,
  labScenarios,
  labState,
} from '../domains/field-lab.js';
import type { EventProjection } from './event-contracts.js';

/** Separate schema/database: no implicit import, conversion or reset of game/work-cell saves. */
export class FieldLabDatabase extends SqliteAuthority {
  readonly registry = new DomainRegistry();
  readonly history: SqliteEventHistory;
  constructor(path: string, { clock = Date.now }: { clock?: () => number } = {}) {
    super(path, { clock, supportedVersions: [0, 101] });
    if (
      this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('matches','simulation_instances')",
        )
        .get()
    ) {
      this.db.close();
      throw Error(
        'DOMAIN_DATABASE_MISMATCH: restore the matching runtime and use a separate field-lab database.',
      );
    }
    this.registry.register(fieldLabModule);
    this.history = new SqliteEventHistory(this.db, { maxEvents: 64, maxBytes: 2 * 1024 * 1024 });
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS labs(id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(json_valid(state))); CREATE TABLE IF NOT EXISTS lab_receipts(principal TEXT NOT NULL,command_id TEXT NOT NULL,instance_id TEXT NOT NULL,request TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(principal,command_id));',
    );
    try {
      this.transaction(() => {
        for (const row of this.db.prepare('SELECT state FROM labs').all())
          this.registry.validateInstance(JSON.parse(String(row.state)));
        this.db.exec('PRAGMA user_version=101');
      });
    } catch (error) {
      this.db.close();
      throw Error(
        'UNSUPPORTED_FIELD_LAB_SAVE: restore a complete compatible backup or run the exact field-lab module/schema version that wrote it.',
        { cause: error },
      );
    }
  }
  /** Internal validated storage; external callers must authenticate and project. */
  load(id: string): SimulationInstance {
    const row = this.db.prepare('SELECT state FROM labs WHERE id=?').get(id);
    if (!row) throw new SimulationCommandError('NOT_AVAILABLE');
    return this.registry.validateInstance(JSON.parse(String(row.state))) as SimulationInstance;
  }
  /** Atomic state and post-state journal replacement under the authority transaction. */
  private save(
    instance: SimulationInstance,
    source: { kind: 'command' | 'worker'; id: string; principal_id: string | null },
    action: string,
  ): void {
    this.registry.validateInstance(instance);
    const head = this.history.head(instance.id);
    this.db
      .prepare('UPDATE labs SET state=? WHERE id=?')
      .run(JSON.stringify(instance), instance.id);
    this.history.append({
      instance_id: instance.id,
      expected_sequence: head.sequence,
      rule: instance.pin,
      simulation_time_ms: instance.simulation_time_ms,
      revision: instance.revision,
      source,
      links: {
        entity_ids: instance.entities.map((e) => e.id),
        job_ids: labState(instance).jobs.map((j) => j.id),
      },
      provenance: { origin: 'simulated', validity: 'modeled', evidence: [] },
      units: [
        { field: 'work', unit: 'ms' },
        { field: 'energy', unit: 'mJ' },
        { field: 'water', unit: 'uL' },
        { field: 'tips', unit: 'count' },
        { field: 'kits', unit: 'count' },
      ],
      payload: { action },
      state: asJson(instance),
    });
  }
  /** Finite explicit initialization with immutable receipt replay and per-owner quota. */
  create(token: string, input: unknown): JsonObject {
    const raw = copyJson(input, () => {
      throw new SimulationCommandError('INVALID_REQUEST');
    }) as Record<string, unknown>;
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(',') !== 'command_id,dispatch,scenario' ||
      typeof raw.command_id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw.command_id) ||
      typeof raw.scenario !== 'string' ||
      !labScenarios.includes(raw.scenario) ||
      !['automatic', 'manual'].includes(String(raw.dispatch))
    )
      throw new SimulationCommandError('INVALID_REQUEST');
    return this.transaction(() => {
      const principal = this.identity(token),
        request = canonicalCommand({ action: 'create-field-lab', ...raw }),
        prior = this.db
          .prepare('SELECT * FROM lab_receipts WHERE principal=? AND command_id=?')
          .get(principal, raw.command_id as string);
      if (prior) {
        if (prior.request !== request) throw new SimulationCommandError('COMMAND_ID_REUSED');
        this.registry.project(this.load(String(prior.instance_id)), principal);
        return JSON.parse(String(prior.result)) as JsonObject;
      }
      if (
        Number(
          this.db
            .prepare(
              "SELECT count(*) n FROM labs WHERE json_extract(state,'$.members[0].principal_id')=?",
            )
            .get(principal)?.n,
        ) >= 6
      )
        throw new SimulationCommandError('NOT_AVAILABLE');
      const instance = createLab(
        randomUUID(),
        principal,
        raw.scenario as string,
        authoritativeTime(this.clock(), 0),
        raw.dispatch as 'automatic' | 'manual',
      );
      this.registry.validateInstance(instance);
      this.db.prepare('INSERT INTO labs VALUES(?,?)').run(instance.id, JSON.stringify(instance));
      this.history.initialize({
        instance_id: instance.id,
        rule: instance.pin,
        simulation_time_ms: instance.simulation_time_ms,
        revision: instance.revision,
        state: asJson(instance),
      });
      this.save(
        instance,
        { kind: 'command', id: raw.command_id as string, principal_id: principal },
        'create-field-lab',
      );
      const result = {
        command_id: raw.command_id as string,
        snapshot: this.registry.project(instance, principal),
      };
      this.db
        .prepare('INSERT INTO lab_receipts VALUES(?,?,?,?,?)')
        .run(principal, raw.command_id as string, instance.id, request, JSON.stringify(result));
      return result;
    });
  }
  /** All controls reuse the shared executor; state/history/receipt failures roll back together. */
  execute(token: string, input: unknown): JsonObject {
    let actor = '';
    const adapter: CommandAdapter<SimulationInstance, JsonObject> = {
      transaction: (work) => this.transaction(work),
      authenticate: () => {
        actor = this.identity(token);
        return actor;
      },
      load: (id) => this.load(id),
      instanceId: (s) => s.id,
      revision: (s) => s.revision,
      setRevision: (s, n) => {
        s.revision = n;
      },
      authorized: (s, p) => s.members.some((m) => m.principal_id === p),
      now: (s) => Math.max(this.clock(), s.simulation_time_ms),
      receipt: (p, id) => {
        const r = this.db
          .prepare('SELECT request,result FROM lab_receipts WHERE principal=? AND command_id=?')
          .get(p, id);
        return r
          ? { request: String(r.request), result: JSON.parse(String(r.result)) as JsonObject }
          : undefined;
      },
      prepare: (s) => advanceLab(s, this.clock()),
      apply: (s, c, context) => {
        if (
          Number(
            this.db.prepare('SELECT count(*) n FROM lab_receipts WHERE instance_id=?').get(s.id)?.n,
          ) >= 256
        )
          throw new SimulationCommandError('NOT_AVAILABLE');
        const proposal = this.registry.transition(s, context.principal_id, {
          ...c,
          expected_revision: s.revision,
        });
        return {
          state: {
            ...s,
            state: proposal.state,
            entities: proposal.entities ?? s.entities,
            observations: proposal.observations ?? s.observations,
          },
          events: proposal.events,
        };
      },
      validate: (s) => {
        this.registry.validateInstance(s);
      },
      result: (s, c) => ({ command_id: c.command_id, snapshot: this.registry.project(s, actor) }),
      save: (s) =>
        this.save(
          s,
          { kind: 'command', id: (input as SimulationCommand).command_id, principal_id: actor },
          (input as SimulationCommand).action,
        ),
      saveReceipt: (p, c, key, result) => {
        this.db
          .prepare('INSERT INTO lab_receipts VALUES(?,?,?,?,?)')
          .run(p, c.command_id, c.instance_id, key, JSON.stringify(result));
      },
    };
    return executeTransactionalCommand(input, adapter);
  }
  /** Reads are authenticated snapshots and never let clients supply progress or clock time. */
  read(token: string, id: string): JsonObject {
    return this.transaction(() => {
      const principal = this.identity(token);
      return this.registry.project(this.load(id), principal);
    });
  }
  /** Bounded independent worker commits progression once under the same SQLite writer lock. */
  tick(beforeCommit?: () => void): void {
    const rows = this.db
      .prepare(
        "SELECT id FROM labs WHERE json_extract(state,'$.state.slot')<32 ORDER BY json_extract(state,'$.simulation_time_ms'),id LIMIT 100",
      )
      .all();
    for (const row of rows)
      this.transaction(() => {
        const old = this.load(String(row.id)),
          next = advanceLab(old, this.clock());
        if (canonicalCommand(old) !== canonicalCommand(next)) {
          this.save(next, { kind: 'worker', id: 'field-lab-clock', principal_id: null }, 'advance');
          beforeCommit?.();
        }
      });
    this.transaction(() => {
      this.db.prepare('UPDATE runtime SET heartbeat=? WHERE id=1').run(this.clock());
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.clock());
    });
  }
  /** Historical snapshots use current ACL and explicit modeled provenance. */
  historyPage(token: string, input: unknown): unknown {
    return this.readHistory(token, input, false);
  }
  /** Bounded scene-only projection; shares event IDs and authorization with full history. */
  sceneHistoryPage(token: string, input: unknown): unknown {
    return this.readHistory(token, input, true);
  }
  /** Read one authorized fixed-head history, without exposing raw state or credentials. */
  private readHistory(token: string, input: unknown, sceneOnly: boolean): unknown {
    return this.transaction(() => {
      const project = (state: Readonly<JsonObject>, principal: string): JsonObject => {
        const full = this.registry.project(state, principal);
        if (!sceneOnly) return full;
        return Object.fromEntries(['instance_id', 'revision', 'simulation_time_ms', 'origin_ms',
          'recipe', 'bindings', 'jobs'].map(key => [key, full[key]!])) as JsonObject;
      };
      const policy: EventProjection = {
        version: sceneOnly ? 'field-lab-scene-history-v1' : 'field-lab-history-v1',
        authorize: (s, p) =>
          (s as unknown as SimulationInstance).members.some((m) => m.principal_id === p),
        validateState: (s) => {
          this.registry.validateInstance(s);
        },
        snapshot: (s, p) => project(s, p),
        event: (e, p) => ({
          id: e.id,
          instance_id: e.instance_id,
          simulation_time_ms: e.simulation_time_ms,
          action: e.payload.action!,
          snapshot: project(e.state, p),
        }),
      };
      return this.history.read(input, this.identity(token), policy);
    });
  }
}
