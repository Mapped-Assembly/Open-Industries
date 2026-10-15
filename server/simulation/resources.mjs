// @ts-check
import Ajv from 'ajv';
import { copyJson } from './json.mjs';
import { canonicalCommand } from './commands.mjs';

/** Safe accounting errors without private batch contents or policy diagnostics. */
export class ResourceLedgerError extends Error {
  /** @param {'INVALID_RESOURCE'|'UNIT_MISMATCH'|'OVERFLOW'|'NOT_AVAILABLE'|'INSUFFICIENT_RESOURCE'|'INCOMPATIBLE_RESOURCE'|'CAPACITY_EXCEEDED'|'RESERVATION_CLOSED'|'OPERATION_ID_REUSED'|'CONSERVATION_FAILED'|'LIMIT_REACHED'} code */
  constructor(code) {
    super(code);
    this.name = 'ResourceLedgerError';
    this.code = code;
  }
}
/** @param {ConstructorParameters<typeof ResourceLedgerError>[0]} code @returns {never} */
function fail(code) {
  throw new ResourceLedgerError(code);
}
const max = Number.MAX_SAFE_INTEGER;
const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
};
const quantity = { type: 'integer', minimum: 0, maximum: max };
const positive = { ...quantity, minimum: 1 };
const unit = { enum: ['g', 'mJ', 'uL', 'count'] };
/** @param {Record<string, unknown>} properties @returns {import('ajv').AnySchemaObject} */
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
/** @param {unknown} items @param {number} maximum @returns {import('ajv').AnySchemaObject} */
const array = (items, maximum) => ({ type: 'array', items, maxItems: maximum });
/** @param {unknown} schema @returns {import('ajv').AnySchemaObject} */
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const pin = object({ module_id: id, module_version: id, schema_version: positive });
const lot = object({ id, kind: id, attributes: { type: 'object' } });
const item = { lot_id: id, resource_id: id, unit, quantity: positive };
const allocation = object({ account_id: id, ...item });
const contextSchema = object({
  instance_id: id,
  command_id: id,
  principal_id: id,
  job_id: nullable(id),
  simulation_time_ms: quantity,
  rule: pin,
});
const reservation = object({
  id,
  source: id,
  holding: id,
  job_id: id,
  principal_id: id,
  state: { enum: ['open', 'cancelled', 'completed'] },
});
const account = object({
  id,
  kind: { enum: ['stock', 'reserved', 'cargo', 'wip', 'output', 'waste', 'spill', 'spent'] },
  owner_id: nullable(id),
  job_id: nullable(id),
  allowed_resources: array(id, 64),
  lot_kinds: array(id, 64),
  requirements: { type: 'object' },
  capacities: array(object({ unit, quantity }), 4),
});
const ledgerSchema = object({
  version: { const: 1 },
  instance_id: id,
  rule: pin,
  resources: array(
    object({ id, dimension: { enum: ['mass', 'energy', 'volume', 'count'] }, unit }),
    64,
  ),
  accounts: array(account, 128),
  opening_lots: array(lot, 512),
  lots: array(lot, 512),
  opening: array(allocation, 4096),
  balances: array(allocation, 4096),
  reservations: array(reservation, 128),
  entries: array(
    object({
      id,
      kind: { enum: ['reserve', 'use', 'transfer', 'spend', 'cancel', 'complete'] },
      context: contextSchema,
      request: { type: 'string', maxLength: 32768 },
      postings: array(
        object({
          account_id: id,
          lot_id: id,
          resource_id: id,
          delta: { type: 'integer', minimum: -max, maximum: max },
        }),
        512,
      ),
      reservation: nullable(reservation),
      lots: array(lot, 64),
    }),
    1024,
  ),
});
const operationSchema = {
  oneOf: [
    object({
      id,
      kind: { const: 'reserve' },
      reservation_id: id,
      source: id,
      holding: id,
      items: array(object(item), 256),
    }),
    object({
      id,
      kind: { const: 'use' },
      reservation_id: id,
      items: array(object(item), 256),
      outputs: array(allocation, 256),
      lots: array(lot, 64),
    }),
    object({
      id,
      kind: { enum: ['transfer', 'spend'] },
      source: id,
      destination: id,
      items: array(object(item), 256),
    }),
    object({ id, kind: { enum: ['cancel', 'complete'] }, reservation_id: id }),
  ],
};
const ajv = new Ajv({ strict: true });
/** @type {import('ajv').ValidateFunction<import('./resource-contracts.js').ResourceLedger>} */
const validLedger = ajv.compile(ledgerSchema);
/** @type {import('ajv').ValidateFunction<import('./resource-contracts.js').ResourceContext>} */
const validContext = ajv.compile(contextSchema);
/** @type {import('ajv').ValidateFunction<import('./resource-contracts.js').ResourceOperation>} */
const validOperation = ajv.compile(operationSchema);
const terminal = new Set(['waste', 'spill', 'spent']);
/** Safe integer ticks; fractional/nonfinite/negative inventory is never rounded silently. @param {number} value @returns {number} */
function ticks(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_RESOURCE');
  return value;
}
/** Checked exact arithmetic; BigInt is never serialized into instance JSON. @param {bigint} value @returns {number} */
function safe(value) {
  if (value < 0n || value > BigInt(max)) fail('OVERFLOW');
  return Number(value);
}
/** Convert integer W × ms to integer mJ; wattage is a rate, not an inventory quantity. @param {number} powerW @param {number} durationMs @returns {number} */
export function energyForPower(powerW, durationMs) {
  return safe(BigInt(ticks(powerW)) * BigInt(ticks(durationMs)));
}
/** Split down to whole ticks and return every unused tick as remainder. @param {number} amount @param {number} numerator @param {number} denominator @returns {{allocated:number,remainder:number}} */
export function splitQuantity(amount, numerator, denominator) {
  ticks(amount);
  ticks(numerator);
  ticks(denominator);
  if (!denominator || numerator > denominator) fail('INVALID_RESOURCE');
  const allocated = safe((BigInt(amount) * BigInt(numerator)) / BigInt(denominator));
  return { allocated, remainder: amount - allocated };
}
/** Compare constituent/resource maps independently; total mass alone cannot hide transmutation. @param {Record<string,number>} expected @param {Record<string,number>} actual @returns {void} */
export function assertResourceConservation(expected, actual) {
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)]))
    if (
      ticks(Object.hasOwn(expected, key) ? expected[key] : 0) !==
      ticks(Object.hasOwn(actual, key) ? actual[key] : 0)
    )
      fail('CONSERVATION_FAILED');
}
/** @param {import('./resource-contracts.js').ResourcePosting|import('./resource-contracts.js').ResourceAllocation} row @returns {string} */
const balanceKey = (row) => JSON.stringify([row.account_id, row.lot_id, row.resource_id]);
/** @param {import('./resource-contracts.js').ResourceAllocation[]} balances @returns {Map<string,bigint>} */
function balanceMap(balances) {
  const map = new Map();
  for (const row of balances) {
    const key = balanceKey(row);
    if (map.has(key)) fail('INVALID_RESOURCE');
    map.set(key, BigInt(row.quantity));
  }
  return map;
}
/** Aggregate resources without exchanging units or material identities. @param {import('./resource-contracts.js').ResourceAllocation[]} balances @returns {Record<string,number>} */
export function resourceTotals(balances) {
  /** @type {Record<string,number>} */ const totals = Object.create(null);
  for (const row of balances)
    totals[row.resource_id] = safe(
      BigInt(totals[row.resource_id] ?? 0) + BigInt(ticks(row.quantity)),
    );
  return totals;
}
/** Apply postings simultaneously, with exact per-resource conservation and no negative balances. @param {Map<string,bigint>} balances @param {import('./resource-contracts.js').ResourcePosting[]} postings @returns {void} */
function post(balances, postings) {
  /** @type {Map<string,bigint>} */ const deltas = new Map();
  /** @type {Map<string,bigint>} */ const totals = new Map();
  for (const row of postings) {
    const delta = BigInt(row.delta);
    deltas.set(balanceKey(row), (deltas.get(balanceKey(row)) ?? 0n) + delta);
    totals.set(row.resource_id, (totals.get(row.resource_id) ?? 0n) + delta);
  }
  if ([...totals.values()].some((n) => n !== 0n)) fail('CONSERVATION_FAILED');
  for (const [key, delta] of deltas) {
    const value = (balances.get(key) ?? 0n) + delta;
    if (value < 0n) fail('INSUFFICIENT_RESOURCE');
    safe(value);
    if (value) balances.set(key, value);
    else balances.delete(key);
  }
}
/** @param {unknown} value @returns {import('./resource-contracts.js').ResourceLedger} */
export function validateResourceLedger(value) {
  const ledger = copyJson(value, () => fail('INVALID_RESOURCE'));
  if (!validLedger(ledger)) fail('INVALID_RESOURCE');
  const resources = new Map(ledger.resources.map((r) => [r.id, r]));
  const accounts = new Map(ledger.accounts.map((a) => [a.id, a]));
  const lots = new Map(ledger.lots.map((l) => [l.id, l]));
  if (
    !resources.size ||
    resources.size !== ledger.resources.length ||
    accounts.size !== ledger.accounts.length ||
    lots.size !== ledger.lots.length ||
    new Set(ledger.opening_lots.map((l) => l.id)).size !== ledger.opening_lots.length
  )
    fail('INVALID_RESOURCE');
  const units = { mass: 'g', energy: 'mJ', volume: 'uL', count: 'count' };
  for (const r of ledger.resources) if (units[r.dimension] !== r.unit) fail('UNIT_MISMATCH');
  for (const a of ledger.accounts) {
    if (
      new Set(a.allowed_resources).size !== a.allowed_resources.length ||
      a.allowed_resources.some((r) => !resources.has(r)) ||
      new Set(a.capacities.map((c) => c.unit)).size !== a.capacities.length
    )
      fail('INVALID_RESOURCE');
    if (a.kind === 'reserved' && !a.job_id) fail('INVALID_RESOURCE');
  }
  /** @param {import('./resource-contracts.js').ResourceAllocation} row @returns {void} */
  const check = (row) => {
    const a = accounts.get(row.account_id),
      r = resources.get(row.resource_id),
      l = lots.get(row.lot_id);
    if (!a || !r || !l) fail('INVALID_RESOURCE');
    if (r.unit !== row.unit) fail('UNIT_MISMATCH');
    if (
      !a.allowed_resources.includes(r.id) ||
      !a.lot_kinds.includes(l.kind) ||
      Object.entries(a.requirements).some(
        ([key, value]) => canonicalCommand(l.attributes[key]) !== canonicalCommand(value),
      )
    )
      fail('INCOMPATIBLE_RESOURCE');
  };
  for (const row of [...ledger.opening, ...ledger.balances]) check(row);
  if (ledger.opening.some((row) => accounts.get(row.account_id)?.kind === 'reserved'))
    fail('INVALID_RESOURCE');
  const replay = balanceMap(ledger.opening);
  const knownLots = new Map(ledger.opening_lots.map((l) => [l.id, l]));
  /** @type {Map<string,import('./resource-contracts.js').ResourceReservation>} */ const reservations =
    new Map();
  const entryIds = new Set();
  let lastTime = 0;
  for (const entry of ledger.entries) {
    if (
      entryIds.has(entry.id) ||
      entry.context.instance_id !== ledger.instance_id ||
      canonicalCommand(entry.context.rule) !== canonicalCommand(ledger.rule)
    )
      fail('INVALID_RESOURCE');
    entryIds.add(entry.id);
    if (entry.context.simulation_time_ms < lastTime) fail('INVALID_RESOURCE');
    lastTime = entry.context.simulation_time_ms;
    for (const lot of entry.lots) {
      if (knownLots.has(lot.id)) fail('INVALID_RESOURCE');
      knownLots.set(lot.id, lot);
    }
    for (const row of entry.postings) {
      const a = accounts.get(row.account_id),
        r = resources.get(row.resource_id);
      if (!a || !r || !knownLots.has(row.lot_id)) fail('INVALID_RESOURCE');
      if (
        (a.owner_id !== null && a.owner_id !== entry.context.principal_id) ||
        (a.job_id !== null && a.job_id !== entry.context.job_id)
      )
        fail('NOT_AVAILABLE');
      if (row.delta < 0 && terminal.has(a.kind)) fail('INVALID_RESOURCE');
      if (
        a.kind === 'reserved' &&
        (!entry.reservation ||
          entry.reservation.holding !== a.id ||
          !['reserve', 'use', 'cancel'].includes(entry.kind))
      )
        fail('INVALID_RESOURCE');
      if (row.delta > 0)
        check({
          account_id: row.account_id,
          lot_id: row.lot_id,
          resource_id: row.resource_id,
          unit: r.unit,
          quantity: row.delta,
        });
    }
    post(replay, entry.postings);
    if (entry.reservation) {
      const old = reservations.get(entry.reservation.id),
        next = entry.reservation;
      if (entry.kind === 'reserve' ? !!old : !old || old.state !== 'open') fail('INVALID_RESOURCE');
      if (
        old &&
        (old.source !== next.source ||
          old.holding !== next.holding ||
          old.job_id !== next.job_id ||
          old.principal_id !== next.principal_id)
      )
        fail('INVALID_RESOURCE');
      if (
        next.job_id !== entry.context.job_id ||
        next.principal_id !== entry.context.principal_id ||
        next.state !==
          (entry.kind === 'reserve' || entry.kind === 'use'
            ? 'open'
            : entry.kind === 'cancel'
              ? 'cancelled'
              : entry.kind === 'complete'
                ? 'completed'
                : null)
      )
        fail('INVALID_RESOURCE');
      reservations.set(next.id, next);
    } else if (['reserve', 'use', 'cancel', 'complete'].includes(entry.kind))
      fail('INVALID_RESOURCE');
  }
  const actual = balanceMap(ledger.balances);
  if (
    canonicalCommand([...replay].map(([k, v]) => [k, v.toString()]).sort()) !==
    canonicalCommand([...actual].map(([k, v]) => [k, v.toString()]).sort())
  )
    fail('CONSERVATION_FAILED');
  if (
    canonicalCommand([...knownLots.values()].sort((a, b) => a.id.localeCompare(b.id))) !==
    canonicalCommand([...lots.values()].sort((a, b) => a.id.localeCompare(b.id)))
  )
    fail('INVALID_RESOURCE');
  if (
    canonicalCommand([...reservations.values()].sort((a, b) => a.id.localeCompare(b.id))) !==
    canonicalCommand([...ledger.reservations].sort((a, b) => a.id.localeCompare(b.id)))
  )
    fail('INVALID_RESOURCE');
  for (const reservation of ledger.reservations) {
    const holding = accounts.get(reservation.holding);
    if (
      !holding ||
      holding.kind !== 'reserved' ||
      holding.job_id !== reservation.job_id ||
      !accounts.has(reservation.source)
    )
      fail('INVALID_RESOURCE');
    if (reservation.state !== 'open' && ledger.balances.some((b) => b.account_id === holding.id))
      fail('INVALID_RESOURCE');
  }
  for (const a of ledger.accounts)
    for (const capacity of a.capacities) {
      const used = ledger.balances
        .filter((b) => b.account_id === a.id && b.unit === capacity.unit)
        .reduce((n, b) => n + BigInt(b.quantity), 0n);
      if (used > BigInt(capacity.quantity)) fail('CAPACITY_EXCEEDED');
    }
  assertResourceConservation(resourceTotals(ledger.opening), resourceTotals(ledger.balances));
  return ledger;
}
/** Create a finite opening inventory before persistence; deliveries must move existing stock. @param {{instance_id:string;rule:import('./contracts.js').DomainPin;resources:import('./resource-contracts.js').ResourceDefinition[];accounts:import('./resource-contracts.js').ResourceAccount[];lots:import('./resource-contracts.js').ResourceLot[];opening:import('./resource-contracts.js').ResourceAllocation[]}} setup @returns {import('./resource-contracts.js').ResourceLedger} */
export function createResourceLedger(setup) {
  return validateResourceLedger({
    version: 1,
    instance_id: setup.instance_id,
    rule: setup.rule,
    resources: setup.resources,
    accounts: setup.accounts,
    opening_lots: setup.lots,
    lots: setup.lots,
    opening: setup.opening,
    balances: setup.opening,
    reservations: [],
    entries: [],
  });
}
/** Execute a pure, auditable resource proposal; the enclosing command transaction persists it. @param {unknown} raw @param {import('./resource-contracts.js').ResourceContext} context @param {import('./resource-contracts.js').ResourceOperation} input @param {import('./resource-contracts.js').ResourcePolicy} [policy] @returns {import('./resource-contracts.js').ResourceLedger} */
export function applyResourceOperation(raw, context, input, policy) {
  const ledger = validateResourceLedger(raw);
  const ctx = copyJson(context, () => fail('INVALID_RESOURCE'));
  const op = copyJson(input, () => fail('INVALID_RESOURCE'));
  if (!validContext(ctx) || !validOperation(op)) fail('INVALID_RESOURCE');
  if (
    ctx.instance_id !== ledger.instance_id ||
    canonicalCommand(ctx.rule) !== canonicalCommand(ledger.rule)
  )
    fail('NOT_AVAILABLE');
  const request = canonicalCommand({
    instance_id: ctx.instance_id,
    rule: ctx.rule,
    principal_id: ctx.principal_id,
    job_id: ctx.job_id,
    command_id: ctx.command_id,
    operation: op,
  });
  const prior = ledger.entries.find((e) => e.id === op.id);
  if (prior) {
    if (prior.request !== request) fail('OPERATION_ID_REUSED');
    return ledger;
  }
  if (ledger.entries.length >= 1024) fail('LIMIT_REACHED');
  const accounts = new Map(ledger.accounts.map((a) => [a.id, a]));
  const resources = new Map(ledger.resources.map((r) => [r.id, r]));
  /** @param {string} id @returns {import('./resource-contracts.js').ResourceAccount} */
  const account = (id) => {
    const a = accounts.get(id);
    if (
      !a ||
      (a.owner_id !== null && a.owner_id !== ctx.principal_id) ||
      (a.job_id !== null && a.job_id !== ctx.job_id)
    )
      fail('NOT_AVAILABLE');
    return a;
  };
  /** @type {import('./resource-contracts.js').ResourcePosting[]} */ const postings = [];
  /** @param {string} id @param {import('./resource-contracts.js').ResourceItem[]} items @param {1|-1} sign @returns {void} */
  const rows = (id, items, sign) => {
    account(id);
    if (!items.length) fail('INVALID_RESOURCE');
    for (const item of items) {
      const resource = resources.get(item.resource_id);
      if (!resource) fail('INVALID_RESOURCE');
      if (item.unit !== resource.unit) fail('UNIT_MISMATCH');
      postings.push({
        account_id: id,
        lot_id: item.lot_id,
        resource_id: item.resource_id,
        delta: sign * item.quantity,
      });
    }
  };
  /** @type {import('./resource-contracts.js').ResourceReservation|null} */ let update = null;
  /** @type {import('./resource-contracts.js').ResourceLot[]} */ let newLots = [];
  if (op.kind === 'reserve') {
    const source = account(op.source),
      holding = account(op.holding);
    if (
      terminal.has(source.kind) ||
      source.kind === 'reserved' ||
      holding.kind !== 'reserved' ||
      !ctx.job_id ||
      ledger.reservations.some((r) => r.id === op.reservation_id || r.holding === holding.id)
    )
      fail('INVALID_RESOURCE');
    rows(source.id, op.items, -1);
    rows(holding.id, op.items, 1);
    update = {
      id: op.reservation_id,
      source: source.id,
      holding: holding.id,
      job_id: ctx.job_id,
      principal_id: ctx.principal_id,
      state: 'open',
    };
  } else if (op.kind === 'transfer' || op.kind === 'spend') {
    const source = account(op.source),
      destination = account(op.destination);
    if (
      terminal.has(source.kind) ||
      source.kind === 'reserved' ||
      destination.kind === 'reserved' ||
      source.id === destination.id
    )
      fail('INVALID_RESOURCE');
    if ((destination.kind === 'spent') !== (op.kind === 'spend')) fail('INVALID_RESOURCE');
    if (
      op.kind === 'spend' &&
      op.items.some(
        (i) =>
          resources.get(i.resource_id)?.dimension !== 'energy' &&
          resources.get(i.resource_id)?.dimension !== 'count',
      )
    )
      fail('INCOMPATIBLE_RESOURCE');
    rows(source.id, op.items, -1);
    rows(destination.id, op.items, 1);
  } else {
    if (!('reservation_id' in op)) fail('INVALID_RESOURCE');
    const reservation = ledger.reservations.find((r) => r.id === op.reservation_id);
    if (
      !reservation ||
      reservation.job_id !== ctx.job_id ||
      reservation.principal_id !== ctx.principal_id
    )
      fail('NOT_AVAILABLE');
    if (reservation.state !== 'open') fail('RESERVATION_CLOSED');
    account(reservation.holding);
    const held = ledger.balances.filter((b) => b.account_id === reservation.holding);
    if (op.kind === 'use') {
      if (!policy) fail('INCOMPATIBLE_RESOURCE');
      try {
        if (
          policy(
            copyJson(ledger, () => fail('INVALID_RESOURCE')),
            copyJson(ctx, () => fail('INVALID_RESOURCE')),
            copyJson(op, () => fail('INVALID_RESOURCE')),
          ) !== true
        )
          fail('INCOMPATIBLE_RESOURCE');
      } catch {
        fail('INCOMPATIBLE_RESOURCE');
      }
      update = { ...reservation };
      newLots = op.lots;
      if (
        newLots.some((l) => ledger.lots.some((old) => old.id === l.id)) ||
        new Set(newLots.map((l) => l.id)).size !== newLots.length
      )
        fail('INVALID_RESOURCE');
      ledger.lots.push(...newLots);
      rows(reservation.holding, op.items, -1);
      for (const output of op.outputs) {
        const a = account(output.account_id);
        if (a.kind === 'reserved' || a.id === reservation.holding) fail('INVALID_RESOURCE');
        rows(a.id, [output], 1);
      }
    } else if (op.kind === 'cancel') {
      if (held.length) {
        rows(reservation.holding, held, -1);
        rows(reservation.source, held, 1);
      }
      update = { ...reservation, state: 'cancelled' };
    } else {
      if (held.length) fail('INVALID_RESOURCE');
      update = { ...reservation, state: 'completed' };
    }
  }
  const balances = balanceMap(ledger.balances);
  post(balances, postings);
  ledger.balances = [...balances].map(([key, value]) => {
    const [account_id, lot_id, resource_id] = JSON.parse(key);
    const resource = resources.get(resource_id);
    if (!resource) fail('INVALID_RESOURCE');
    return { account_id, lot_id, resource_id, unit: resource.unit, quantity: safe(value) };
  });
  if (update) {
    const index = ledger.reservations.findIndex((r) => r.id === update?.id);
    if (index < 0) ledger.reservations.push(update);
    else ledger.reservations[index] = update;
  }
  ledger.entries.push({
    id: op.id,
    kind: op.kind,
    context: ctx,
    request,
    postings,
    reservation: update,
    lots: newLots,
  });
  return validateResourceLedger(ledger);
}

/** Return an isolated schema for strict domain-module payload validation. @returns {import('ajv').AnySchemaObject} */
export function resourceOperationSchema() {
  return copyJson(operationSchema, () => fail('INVALID_RESOURCE'));
}
/** Return an isolated nested state schema; invariants still require validateResourceLedger. @returns {import('ajv').AnySchemaObject} */
export function resourceLedgerSchema() {
  return copyJson(ledgerSchema, () => fail('INVALID_RESOURCE'));
}
