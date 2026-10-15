import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CommandAdapter } from '../../server/simulation/command-contracts.js';
import type {
  JsonObject,
  SimulationCommand,
  SimulationInstance,
} from '../../server/simulation/contracts.js';
import type {
  EventProjection,
  EventTransition,
  EventPage,
} from '../../server/simulation/event-contracts.js';
import { SimulationCommandError } from '../../server/simulation/commands.mjs';
import { canonicalCommand } from '../../server/simulation/commands.mjs';
import { SqliteEventHistory, SimulationEventError } from '../../server/simulation/events.mjs';
import { validateJobSchedule } from '../../server/simulation/jobs.js';
import { validateResourceLedger } from '../../server/simulation/resources.mjs';
import type { JobSchedule } from '../../server/simulation/job-contracts.js';
import { JobFixture, jobSetup } from './job-fixture.js';

/** Explicit neutral projection: owned jobs only; hidden compositions and observations stay private. */
function project(state: Readonly<JsonObject>, principal: string): JsonObject | null {
  const instance = state as unknown as SimulationInstance;
  if (!instance.members.some((m) => m.principal_id === principal)) return null;
  const schedule = validateJobSchedule(instance.state.schedule);
  return {
    instance_id: instance.id,
    revision: instance.revision,
    simulation_time_ms: schedule.cursor_ms,
    jobs: schedule.jobs
      .filter((j) => j.owner_id === principal)
      .map((j) => ({
        id: j.id,
        state: j.state,
        reason: j.reason,
        phase_index: j.phase_index,
        work_ms: j.phase_work_ms,
      })),
  };
}

/** Real SQL fixture composes #29 commands, #30 resources, #31 workers and #32 history. */
export class EventFixture extends JobFixture {
  readonly history: SqliteEventHistory;
  constructor(path: string, now = 1000, maxEvents = 256) {
    super(path, now);
    this.history = new SqliteEventHistory(this.db, { maxEvents });
  }
  /** Initialize an explicit history cutover with no fabricated earlier events. */
  override seedJobs(schedule = jobSetup()): void {
    super.seedJobs(schedule);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      this.history.initialize({
        instance_id: state.id,
        rule: state.pin,
        simulation_time_ms: state.simulation_time_ms,
        revision: state.revision,
        state: state as unknown as JsonObject,
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Append the just-written private state in the same open transaction as worker/command work. */
  record(source: EventTransition['source']): void {
    const state = this.read(),
      schedule = validateJobSchedule(state.state.schedule);
    const previous = this.history.replay(state.id);
    if (
      source.kind === 'worker' &&
      canonicalCommand({ ...state, revision: previous.state.revision }) ===
        canonicalCommand(previous.state)
    ) {
      this.db
        .prepare('UPDATE instances SET state=? WHERE id=?')
        .run(JSON.stringify(previous.state), state.id);
      return;
    }
    this.history.append({
      instance_id: state.id,
      expected_sequence: previous.sequence,
      rule: state.pin,
      simulation_time_ms: schedule.cursor_ms,
      revision: state.revision,
      source,
      links: {
        entity_ids: state.entities.map((e) => e.id),
        job_ids: schedule.jobs.map((j) => j.id),
      },
      provenance: { origin: 'simulated', validity: 'modeled', evidence: [] },
      units: [
        { field: 'work', unit: 'ms' },
        { field: 'energy', unit: 'mJ' },
      ],
      payload: { private_observation: 'hidden-observation-canary' },
      state: state as unknown as JsonObject,
    });
  }
  /** Hook after the worker SQL write and before commit, so history failures roll back resource work. */
  override tick(maxSteps = 100, beforeCommit?: () => void): JobSchedule {
    return super.tick(maxSteps, () => {
      this.record({ kind: 'worker', id: 'work-cell-tick', principal_id: null });
      beforeCommit?.();
    });
  }
  /** Preserve executor authentication, authorization and receipts; append after state write. */
  override execute(
    raw: unknown,
    mutate?: (adapter: CommandAdapter<SimulationInstance, JsonObject>) => void,
  ): JsonObject {
    return super.execute(raw, (adapter) => {
      const save = adapter.save;
      adapter.save = (state) => {
        save(state);
        this.record({
          kind: 'command',
          id: (raw as SimulationCommand).command_id,
          principal_id: adapter.authenticate(),
        });
      };
      mutate?.(adapter);
    });
  }
  /** Recheck current ACL as well as historical membership; projections never copy raw metadata. */
  projection(): EventProjection {
    return {
      version: 'work-cell-history-v1',
      authorize: (_state, principal) =>
        this.read().members.some((m) => m.principal_id === principal),
      validateState: (state) => {
        const schedule = validateJobSchedule(
          (state as unknown as SimulationInstance).state.schedule,
        );
        validateResourceLedger(schedule.domain.resources);
      },
      snapshot: (state, principal) => project(state, principal),
      event: (event, principal) => {
        if (event.source.kind === 'command' && event.source.principal_id !== principal) return null;
        const snapshot = project(event.state, principal);
        if (!snapshot || !(snapshot.jobs as unknown[]).length) return null;
        return {
          id: event.id,
          instance_id: event.instance_id,
          command_id: event.source.kind === 'command' ? event.source.id : null,
          kind: event.source.kind,
          simulation_time_ms: event.simulation_time_ms,
          job_ids: event.links.job_ids.filter((id) =>
            (snapshot.jobs as JsonObject[]).some((j) => j.id === id),
          ),
          snapshot,
        };
      },
    };
  }
  /** Resolve an active test session each time, including cursor resume. */
  page(request: unknown): EventPage {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const session = this.db
        .prepare('SELECT principal FROM test_sessions WHERE token=?')
        .get(this.token);
      if (!session) throw new SimulationCommandError('AUTH_REQUIRED');
      const page = this.history.read(request, String(session.principal), this.projection());
      this.db.exec('COMMIT');
      return page;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

/** Test-only HTTP transport over the actual SQLite adapters, not a production auth alternative. */
export async function startEventFixtureService(
  path: string,
): Promise<{ origin: string; fixture: EventFixture; close: () => Promise<void> }> {
  const fixture = new EventFixture(path);
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      fixture.token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!fixture.db.prepare('SELECT 1 FROM test_sessions WHERE token=?').get(fixture.token))
        throw new SimulationCommandError('AUTH_REQUIRED');
      const value =
        req.url === '/command'
          ? fixture.execute(body)
          : req.url === '/tick'
            ? ((fixture.wallNow = body.now), fixture.tick())
            : fixture.page(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    } catch (error) {
      const code =
        error instanceof SimulationCommandError || error instanceof SimulationEventError
          ? error.code
          : 'UNAVAILABLE';
      res
        .writeHead(code === 'AUTH_REQUIRED' ? 401 : 400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { code } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    fixture,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      fixture.db.close();
    },
  };
}
