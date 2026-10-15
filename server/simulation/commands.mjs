// @ts-check
import Ajv from 'ajv';
import { copyJson } from './json.mjs';

/** Safe command errors shared by generic consumers and compatibility adapters. */
export class SimulationCommandError extends Error {
  /** @param {'AUTH_REQUIRED'|'INVALID_REQUEST'|'NOT_AVAILABLE'|'CONFLICT'|'COMMAND_ID_REUSED'|'INVARIANT_FAILED'|'EVENTS_UNSUPPORTED'} code */
  constructor(code) {
    super(code);
    this.name = 'SimulationCommandError';
    this.code = code;
  }
}
/** @param {ConstructorParameters<typeof SimulationCommandError>[0]} code @returns {never} */
function fail(code) {
  throw new SimulationCommandError(code);
}
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
};
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['command_id', 'instance_id', 'expected_revision', 'action', 'payload'],
  properties: {
    command_id: id,
    instance_id: id,
    expected_revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
    action: id,
    payload: { type: 'object' },
  },
};
/** @type {import('ajv').ValidateFunction<import('./contracts.js').SimulationCommand>} */
const validate = new Ajv({ strict: true }).compile(schema);
/** Canonical JSON preserves array order while ignoring object-key order. @param {unknown} value @returns {string} */
export function canonicalCommand(value) {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
/**
 * Execute once under the adapter's existing SQLite transaction; never open a second authority.
 * Authentication, scope checks and receipt lookup run on every attempt, including replay.
 * @template State, Result
 * @param {unknown} raw
 * @param {import('./command-contracts.js').CommandAdapter<State, Result>} adapter
 * @returns {Result}
 */
export function executeTransactionalCommand(raw, adapter) {
  const command = copyJson(raw, () => fail('INVALID_REQUEST'));
  if (!validate(command) || Buffer.byteLength(JSON.stringify(command)) > 8192)
    fail('INVALID_REQUEST');
  const value = command;
  return adapter.transaction(() => {
    const principal = adapter.authenticate();
    if (typeof principal !== 'string' || !principal.length) fail('AUTH_REQUIRED');
    const request = adapter.requestKey ? adapter.requestKey(value) : canonicalCommand(value);
    if (typeof request !== 'string' || Buffer.byteLength(request) > 32768) fail('INVALID_REQUEST');
    const receipt = adapter.receipt(principal, value.command_id);
    if (receipt && receipt.request !== request) fail('COMMAND_ID_REUSED');
    let state = copyJson(adapter.load(value.instance_id), () => fail('INVARIANT_FAILED'));
    if (adapter.instanceId(state) !== value.instance_id || !adapter.authorized(state, principal))
      fail('NOT_AVAILABLE');
    if (receipt) return copyJson(receipt.result, () => fail('INVARIANT_FAILED'));
    if (adapter.revision(state) !== value.expected_revision) fail('CONFLICT');
    const now = adapter.now(state);
    if (!Number.isSafeInteger(now) || now < 0) fail('INVARIANT_FAILED');
    const context = Object.freeze({ principal_id: principal, simulation_time_ms: now });
    state = adapter.prepare ? adapter.prepare(state, context) : state;
    const revision = adapter.revision(state);
    if (
      !Number.isSafeInteger(revision) ||
      revision < value.expected_revision ||
      revision >= Number.MAX_SAFE_INTEGER
    )
      fail('INVARIANT_FAILED');
    // Both envelopes are server-validated; callbacks cannot rewrite the command identity.
    /** @param {unknown} item @returns {void} */
    const freeze = (item) => {
      if (item && typeof item === 'object') {
        for (const child of Object.values(item)) freeze(child);
        Object.freeze(item);
      }
    };
    freeze(value);
    const proposed = adapter.apply(state, value, context);
    if (
      !proposed ||
      typeof proposed !== 'object' ||
      !Object.hasOwn(proposed, 'state') ||
      !Object.hasOwn(proposed, 'events')
    )
      fail('INVARIANT_FAILED');
    state = copyJson(proposed.state, () => fail('INVARIANT_FAILED'));
    const events = copyJson(proposed.events, () => fail('INVARIANT_FAILED'));
    if (
      !Array.isArray(events) ||
      events.length > 256 ||
      events.some((e) => !e || typeof e !== 'object' || Array.isArray(e))
    )
      fail('INVARIANT_FAILED');
    if (
      adapter.instanceId(state) !== value.instance_id ||
      adapter.revision(state) !== revision ||
      !adapter.authorized(state, principal)
    )
      fail('INVARIANT_FAILED');
    adapter.setRevision(state, revision + 1);
    adapter.validate(state);
    const result = copyJson(
      adapter.result(
        copyJson(state, () => fail('INVARIANT_FAILED')),
        value,
        context,
      ),
      () => fail('INVARIANT_FAILED'),
    );
    adapter.save(state);
    if (events.length) {
      if (!adapter.appendEvents) fail('EVENTS_UNSUPPORTED');
      adapter.appendEvents(value.instance_id, value.command_id, principal, events);
    }
    adapter.saveReceipt(principal, value, request, result);
    return result;
  });
}
