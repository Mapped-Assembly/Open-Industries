// @ts-check
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { canonicalCommand } from './commands.mjs';
import { copyJson } from './json.mjs';

/** Public-safe failures never include raw state, SQL, cursor contents or validator diagnostics. */
export class SimulationEventError extends Error {
  /** @param {'INVALID_HISTORY'|'NOT_AVAILABLE'|'CONFLICT'|'CURSOR_EXPIRED'|'TRANSACTION_REQUIRED'} code */
  constructor(code) {
    super(code);
    this.name = 'SimulationEventError';
    this.code = code;
  }
}
/** @param {ConstructorParameters<typeof SimulationEventError>[0]} code @returns {never} */
function fail(code) {
  throw new SimulationEventError(code);
}
/** @template T @param {T} value @returns {T} */
function clone(value) {
  return copyJson(value, () => fail('INVALID_HISTORY'));
}
/** @param {unknown} value @returns {string} */
function digest(value) {
  return createHash('sha256').update(canonicalCommand(value)).digest('hex');
}
/** @template T @param {T} value @returns {Readonly<T>} */
function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
};
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
/** @param {Record<string,unknown>} properties */
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const pin = object({
  module_id: id,
  module_version: id,
  schema_version: { ...integer, minimum: 1 },
});
const stateFields = {
  rule: pin,
  simulation_time_ms: integer,
  revision: { ...integer, minimum: 1 },
  state: { type: 'object' },
};
const fields = {
  instance_id: id,
  ...stateFields,
  source: object({
    kind: { enum: ['command', 'worker', 'system'] },
    id,
    principal_id: { anyOf: [id, { type: 'null' }] },
  }),
  links: object({
    entity_ids: { type: 'array', maxItems: 128, uniqueItems: true, items: id },
    job_ids: { type: 'array', maxItems: 128, uniqueItems: true, items: id },
  }),
  provenance: object({
    origin: { enum: ['simulated', 'external', 'observation-derived'] },
    validity: { enum: ['unknown', 'modeled', 'observed'] },
    evidence: {
      type: 'array',
      maxItems: 128,
      items: object({ observation_id: id, source_id: id, source_revision: id }),
    },
  }),
  units: {
    type: 'array',
    maxItems: 32,
    items: object({ field: id, unit: { enum: ['g', 'mJ', 'uL', 'count', 'ms', 'm', 'W'] } }),
  },
  payload: { type: 'object' },
};
const ajv = new Ajv({ strict: true });
const validInitial = ajv.compile(object({ instance_id: id, ...stateFields }));
/** @type {import('ajv').ValidateFunction<import('./event-contracts.js').EventTransition>} */
const validTransition = ajv.compile(object({ ...fields, expected_sequence: integer }));
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
/** @type {import('ajv').ValidateFunction<import('./event-contracts.js').SimulationEvent>} */
const validEvent = ajv.compile(
  object({
    ...fields,
    version: { const: 1 },
    id,
    sequence: { ...integer, minimum: 1 },
    previous_hash: hash,
    hash,
  }),
);
/** @type {import('ajv').ValidateFunction<import('./event-contracts.js').EventCheckpoint>} */
const validCheckpoint = ajv.compile(
  object({ ...stateFields, sequence: integer, state_hash: hash, chain_hash: hash }),
);
/** @type {import('ajv').ValidateFunction<import('./event-contracts.js').EventReadRequest>} */
const validRead = ajv.compile(
  object({
    instance_id: id,
    cursor: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 1024 }] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  }),
);
/** @type {import('ajv').ValidateFunction<{instance_id:string;principal:string;projection:string;after:number;through:number}>} */
const validCursor = ajv.compile(
  object({ instance_id: id, principal: id, projection: id, after: integer, through: integer }),
);
/** @param {import('./event-contracts.js').EventProvenance} p */
function provenance(p) {
  if (
    (p.origin !== 'external' && p.validity === 'observed') ||
    (p.origin === 'external' && p.validity === 'modeled') ||
    (p.origin !== 'simulated' && !p.evidence.length)
  )
    fail('INVALID_HISTORY');
}

/**
 * Bounded private history on the caller's SQLite connection. All writes AND reads require
 * the caller's transaction; no second writer authority or unauthenticated projection exists.
 */
export class SqliteEventHistory {
  /** @param {import('node:sqlite').DatabaseSync} db @param {{maxEvents?:number;maxBytes?:number}} [options] */
  constructor(db, { maxEvents = 256, maxBytes = 16 * 1024 * 1024 } = {}) {
    if (
      !Number.isSafeInteger(maxEvents) ||
      maxEvents < 1 ||
      maxEvents > 1024 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 2097152 ||
      maxBytes > 64 * 1024 * 1024
    )
      fail('INVALID_HISTORY');
    this.db = db;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    db.exec(`CREATE TABLE IF NOT EXISTS simulation_history_keys(id INTEGER PRIMARY KEY CHECK(id=1),secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS simulation_history(instance_id TEXT PRIMARY KEY,checkpoint TEXT NOT NULL CHECK(json_valid(checkpoint)),head_sequence INTEGER NOT NULL,head_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS simulation_events(instance_id TEXT NOT NULL,sequence INTEGER NOT NULL,event TEXT NOT NULL CHECK(json_valid(event)),PRIMARY KEY(instance_id,sequence));`);
    db.prepare('INSERT OR IGNORE INTO simulation_history_keys VALUES(1,?)').run(
      randomBytes(32).toString('hex'),
    );
    this.key = Buffer.from(
      String(db.prepare('SELECT secret FROM simulation_history_keys WHERE id=1').get()?.secret),
      'hex',
    );
    if (this.key.length !== 32) fail('INVALID_HISTORY');
  }
  /** Prevent an adapter from committing history separately from state/receipts. */
  requireTransaction() {
    if (!this.db.isTransaction) fail('TRANSACTION_REQUIRED');
  }
  /** @param {string} instanceId @returns {{checkpoint:import('./event-contracts.js').EventCheckpoint;sequence:number;hash:string}} */
  head(instanceId) {
    this.requireTransaction();
    const row = this.db
      .prepare('SELECT * FROM simulation_history WHERE instance_id=?')
      .get(instanceId);
    if (!row) fail('NOT_AVAILABLE');
    let checkpoint;
    try {
      checkpoint = JSON.parse(String(row.checkpoint));
    } catch {
      fail('INVALID_HISTORY');
    }
    if (
      !validCheckpoint(checkpoint) ||
      digest(checkpoint.state) !== checkpoint.state_hash ||
      !Number.isSafeInteger(row.head_sequence) ||
      Number(row.head_sequence) < checkpoint.sequence ||
      !/^[a-f0-9]{64}$/.test(String(row.head_hash))
    )
      fail('INVALID_HISTORY');
    return { checkpoint, sequence: Number(row.head_sequence), hash: String(row.head_hash) };
  }
  /** Initialize a private cutover checkpoint once; historical work is never invented on upgrade.
   * @param {{instance_id:string;rule:import('./contracts.js').DomainPin;simulation_time_ms:number;revision:number;state:import('./contracts.js').JsonObject}} input
   */
  initialize(input) {
    this.requireTransaction();
    const value = clone(input);
    if (!validInitial(value)) fail('INVALID_HISTORY');
    if (
      this.db.prepare('SELECT 1 FROM simulation_history WHERE instance_id=?').get(value.instance_id)
    ) {
      if (
        canonicalCommand(this.head(value.instance_id).checkpoint.rule) !==
        canonicalCommand(value.rule)
      )
        fail('INVALID_HISTORY');
      return;
    }
    const checkpoint = {
      rule: value.rule,
      simulation_time_ms: value.simulation_time_ms,
      revision: value.revision,
      state: value.state,
      sequence: 0,
      state_hash: digest(value.state),
      chain_hash: digest(value),
    };
    this.db
      .prepare('INSERT INTO simulation_history VALUES(?,?,0,?)')
      .run(value.instance_id, JSON.stringify(checkpoint), checkpoint.chain_hash);
  }
  /** Reconstruct exact declared post-state, verifying chain, pin, cursor and monotonic time/revision.
   * Internal only: public callers must use read(), which reauthorizes against current state.
   * @param {string} instanceId @param {number} [through] @returns {import('./event-contracts.js').EventCheckpoint}
   */
  replay(instanceId, through) {
    const head = this.head(instanceId);
    const target = through ?? head.sequence;
    if (!Number.isSafeInteger(target) || target < head.checkpoint.sequence) fail('CURSOR_EXPIRED');
    if (target > head.sequence) fail('INVALID_HISTORY');
    let current = head.checkpoint;
    const rows = this.db
      .prepare(
        'SELECT event FROM simulation_events WHERE instance_id=? AND sequence>? AND sequence<=? ORDER BY sequence',
      )
      .all(instanceId, current.sequence, target);
    if (rows.length > 1024) fail('INVALID_HISTORY');
    for (const row of rows) {
      /** @type {import('./event-contracts.js').SimulationEvent} */ const event = JSON.parse(
        String(row.event),
      );
      const { hash: stored, ...body } = event;
      if (
        !validEvent(event) ||
        event.instance_id !== instanceId ||
        event.sequence !== current.sequence + 1 ||
        event.previous_hash !== current.chain_hash ||
        digest(body) !== stored ||
        canonicalCommand(event.rule) !== canonicalCommand(current.rule) ||
        event.simulation_time_ms < current.simulation_time_ms ||
        event.revision < current.revision
      )
        fail('INVALID_HISTORY');
      provenance(event.provenance);
      current = {
        sequence: event.sequence,
        rule: event.rule,
        simulation_time_ms: event.simulation_time_ms,
        revision: event.revision,
        state: event.state,
        state_hash: digest(event.state),
        chain_hash: event.hash,
      };
    }
    if (
      current.sequence !== target ||
      (target === head.sequence && current.chain_hash !== head.hash)
    )
      fail('INVALID_HISTORY');
    return clone(current);
  }
  /** Append a private state replacement under a compare-and-swap sequence. No external effects.
   * @param {import('./event-contracts.js').EventTransition} input @returns {number}
   */
  append(input) {
    this.requireTransaction();
    const value = clone(input);
    if (!validTransition(value)) fail('INVALID_HISTORY');
    if (value.source.kind === 'command' && !value.source.principal_id) fail('INVALID_HISTORY');
    provenance(value.provenance);
    const current = this.replay(value.instance_id);
    if (value.expected_sequence !== current.sequence) fail('CONFLICT');
    if (
      current.sequence >= Number.MAX_SAFE_INTEGER ||
      value.simulation_time_ms < current.simulation_time_ms ||
      value.revision < current.revision ||
      canonicalCommand(value.rule) !== canonicalCommand(current.rule)
    )
      fail('INVALID_HISTORY');
    const { expected_sequence: _, ...data } = value;
    const body = {
      ...data,
      version: /** @type {const} */ (1),
      id: randomUUID(),
      sequence: current.sequence + 1,
      previous_hash: current.chain_hash,
    };
    const event = { ...body, hash: digest(body) };
    this.db
      .prepare('INSERT INTO simulation_events VALUES(?,?,?)')
      .run(value.instance_id, event.sequence, JSON.stringify(event));
    this.db
      .prepare('UPDATE simulation_history SET head_sequence=?,head_hash=? WHERE instance_id=?')
      .run(event.sequence, event.hash, value.instance_id);
    const rows = this.db
      .prepare(
        'SELECT sequence,event,length(CAST(event AS BLOB)) bytes FROM simulation_events WHERE instance_id=? ORDER BY sequence',
      )
      .all(value.instance_id);
    let bytes = rows.reduce((n, row) => n + Number(row.bytes), 0),
      count = rows.length;
    for (const row of rows) {
      if (count <= this.maxEvents && bytes <= this.maxBytes) break;
      const removed = JSON.parse(String(row.event));
      const checkpoint = {
        sequence: removed.sequence,
        rule: removed.rule,
        simulation_time_ms: removed.simulation_time_ms,
        revision: removed.revision,
        state: removed.state,
        state_hash: digest(removed.state),
        chain_hash: removed.hash,
      };
      this.db
        .prepare('UPDATE simulation_history SET checkpoint=? WHERE instance_id=?')
        .run(JSON.stringify(checkpoint), value.instance_id);
      this.db
        .prepare('DELETE FROM simulation_events WHERE instance_id=? AND sequence=?')
        .run(value.instance_id, Number(row.sequence));
      bytes -= Number(row.bytes);
      count--;
    }
    return event.sequence;
  }
  /** Encrypt cursors; neither hidden event counters nor raw-state hashes are client tokens.
   * @param {unknown} value @returns {string}
   */
  cursor(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
  }
  /** Validate a cursor without reflecting its plaintext or authentication errors.
   * @param {string} token @returns {{instance_id:string;principal:string;projection:string;after:number;through:number}}
   */
  decode(token) {
    try {
      const data = Buffer.from(token, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      const value = JSON.parse(
        Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(),
      );
      if (!validCursor(value)) fail('NOT_AVAILABLE');
      return value;
    } catch {
      return fail('NOT_AVAILABLE');
    }
  }
  /** Authorized fixed-head page. All fields are domain projections; raw metadata is never merged.
   * @param {unknown} raw @param {string} principal @param {import('./event-contracts.js').EventProjection} policy @returns {import('./event-contracts.js').EventPage}
   */
  read(raw, principal, policy) {
    this.requireTransaction();
    const request = clone(raw);
    if (!validRead(request) || !ajv.validate(id, principal) || !ajv.validate(id, policy.version))
      fail('NOT_AVAILABLE');
    const input = /** @type {import('./event-contracts.js').EventReadRequest} */ (request);
    try {
      const head = this.head(input.instance_id),
        latest = this.replay(input.instance_id);
      if (!policy.authorize(frozen(clone(latest.state)), principal)) fail('NOT_AVAILABLE');
      const position = input.cursor
        ? this.decode(input.cursor)
        : {
            instance_id: input.instance_id,
            principal,
            projection: policy.version,
            after: head.checkpoint.sequence,
            through: head.sequence,
          };
      if (
        position.instance_id !== input.instance_id ||
        position.principal !== principal ||
        position.projection !== policy.version
      )
        fail('NOT_AVAILABLE');
      if (position.after < head.checkpoint.sequence || position.through < head.checkpoint.sequence)
        fail('CURSOR_EXPIRED');
      if (position.after > position.through || position.through > head.sequence)
        fail('NOT_AVAILABLE');
      const snapshot = this.replay(input.instance_id, position.through);
      policy.validateState(frozen(clone(snapshot.state)), frozen(clone(snapshot.rule)));
      policy.validateState(
        frozen(clone(head.checkpoint.state)),
        frozen(clone(head.checkpoint.rule)),
      );
      const rows = this.db
        .prepare(
          'SELECT event FROM simulation_events WHERE instance_id=? AND sequence>? AND sequence<=? ORDER BY sequence',
        )
        .all(input.instance_id, position.after, position.through);
      /** @type {{sequence:number;value:import('./contracts.js').JsonObject}[]} */ const visible =
        [];
      let after = position.after;
      for (const row of rows) {
        /** @type {import('./event-contracts.js').SimulationEvent} */ const event = JSON.parse(
          String(row.event),
        );
        policy.validateState(frozen(clone(event.state)), frozen(clone(event.rule)));
        const projected = clone(policy.event(frozen(clone(event)), principal));
        if (projected !== null) {
          if (typeof projected !== 'object' || Array.isArray(projected)) fail('INVALID_HISTORY');
          visible.push({ sequence: event.sequence, value: projected });
        }
      }
      const selected = visible.slice(0, input.limit),
        events = selected.map((item) => item.value);
      after = selected.at(-1)?.sequence ?? position.through;
      const page = {
        version: /** @type {const} */ (1),
        snapshot: clone(
          policy.snapshot(frozen(clone(snapshot.state)), principal, snapshot.simulation_time_ms),
        ),
        checkpoint: clone(
          policy.snapshot(
            frozen(clone(head.checkpoint.state)),
            principal,
            head.checkpoint.simulation_time_ms,
          ),
        ),
        events,
        next_cursor: visible.length > input.limit ? this.cursor({ ...position, after }) : null,
      };
      for (const output of [page.snapshot, page.checkpoint])
        if (output !== null && (typeof output !== 'object' || Array.isArray(output)))
          fail('INVALID_HISTORY');
      return clone(page);
    } catch (error) {
      if (
        error instanceof SimulationEventError &&
        (error.code === 'NOT_AVAILABLE' || error.code === 'CURSOR_EXPIRED')
      )
        throw error;
      return fail('INVALID_HISTORY');
    }
  }
}
