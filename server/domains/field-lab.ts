import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type {
  DomainModule,
  DomainPin,
  JsonObject,
  SimulationInstance,
} from '../simulation/contracts.js';
import type {
  EventJob,
  BalanceAccount,
  ResourceBalanceLedger,
  ResourceCredit,
} from '../simulation/event-runtime-contracts.js';
import type { ResourceAllocation, ResourceUnit } from '../simulation/resource-contracts.js';
import { advanceEventClock } from '../simulation/event-clock.mjs';
import { transitionEventJobs, validateEventJobs } from '../simulation/event-jobs.mjs';
import {
  createResourceBalances,
  settleResourceBalances,
  validateResourceBalances,
  resourceBalancesSchema,
} from '../simulation/resource-balances.mjs';
import { DomainCommandError } from '../simulation/registry.js';
import { identifier, objectSchema, instanceSchema, pinSchema } from '../simulation/schema.js';
import { canonicalCommand } from '../simulation/commands.mjs';
import { asJson } from './work-cell.js';

export const fieldLabPin: DomainPin = {
  module_id: 'field-lab',
  module_version: 'FIELD-LAB-01-v1',
  schema_version: 1,
};
export const labSlotMs = 15 * 60 * 1000,
  labDayMs = 32 * labSlotMs;
const MJ = 3600000,
  UL = 1000000;
interface Config {
  samples: number;
  solarWh: number[];
  batteryCapacityWh: number;
  batteryWh: number;
  reserveWh: number;
  baseLoadW: number;
  sampleWh: number;
  sampleWaterL: number;
  serviceWaterLPerHour: number;
  waterL: number;
  tips: number;
  kits: number;
  waterReserveL: number;
  solarFactor: number;
  deliveryMinute: number | null;
  delivery: { tips: number; kits: number; waterL: number };
}
const inputs = JSON.parse(
  readFileSync(
    new URL('../../benchmarks/field-lab/inputs/scenarios.json', import.meta.url),
    'utf8',
  ),
) as { baseline: Config; scenarios: { id: string; changes: Partial<Config> }[] };
export const labScenarios = inputs.scenarios.map((s) => s.id);
const sceneBytes = readFileSync(
  new URL('../../benchmarks/field-lab/fixtures/field-lab.oi.json', import.meta.url),
);
const scene = JSON.parse(sceneBytes.toString()) as { instances: { id: string }[] };
const modelDigest = createHash('sha256').update(canonicalCommand(inputs)).digest('hex');
const sceneDigest = createHash('sha256').update(sceneBytes).digest('hex');
const equipment = ['pipette', 'instruments', 'water', 'battery', 'stock', 'waste', 'courier'];
for (const id of equipment)
  if (!scene.instances.some((i) => i.id === id)) throw Error('UNSUPPORTED_FIELD_LAB_SCENE');
const terminal = new Set(['completed', 'cancelled', 'failed']);
const int = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
/** Immutable benchmark configuration; no caller-defined rates or grants. */
export function labConfig(id: string): Config {
  const scenario = inputs.scenarios.find((s) => s.id === id);
  if (!scenario) throw new DomainCommandError('INVALID_SCENARIO');
  return structuredClone({
    ...inputs.baseline,
    ...scenario.changes,
    delivery: { ...inputs.baseline.delivery, ...scenario.changes.delivery },
  });
}
interface Totals {
  generated_mj: number;
  spill_mj: number;
  base_served_mj: number;
  base_unmet_mj: number;
  process_mj: number;
  sample_water_ul: number;
  service_water_ul: number;
  service_unmet_ul: number;
  delivered_water_ul: number;
  delivered_tips: number;
  delivered_kits: number;
}
interface Row {
  minute: number;
  arrived: number;
  completed: number;
  processed: number;
  queued: number;
  batteryWh: number;
  waterL: number;
  tips: number;
  kits: number;
  delivered: boolean;
  reasons: string[];
}
export interface LabState {
  model_sha256: string;
  scenario: string;
  dispatch: 'automatic' | 'manual';
  origin_ms: number;
  cursor_ms: number;
  observed_at_ms: number;
  slot: number;
  admitted: boolean;
  active_job_id: string | null;
  delivery_arrived: boolean;
  resources: ResourceBalanceLedger;
  jobs: EventJob[];
  totals: Totals;
  blocked: { kits: number; tips: number; water: number; energy: number };
  timeline: Row[];
  slot_reasons: string[];
  slot_completed: number;
}
/** Typed domain view is validated by the registered invariant before use. */
export function labState(instance: Readonly<SimulationInstance>): LabState {
  return instance.state as unknown as LabState;
}
const quantity = (s: LabState, account: string, resource: string) =>
  s.resources.balances
    .filter((b) => b.account_id === account && b.resource_id === resource)
    .reduce((n, b) => n + b.quantity, 0);
const jobIndex = (j: EventJob) => Number(j.id.split('-').at(-1));
const arrival = (j: EventJob) => Math.floor((jobIndex(j) - 1) / 6) * 120 * 60000;
const held = (j: EventJob) => `hold-${j.id}`;
/** Explicit accounts retain finite depot stock, reservations, waste, energy sinks and capacity. */
function accounts(owner: string): BalanceAccount[] {
  const a: BalanceAccount[] = [];
  const add = (
    id: string,
    unit: ResourceUnit,
    kind: BalanceAccount['kind'] = 'stock',
    capacity: number | null = null,
    job_id: string | null = null,
  ) => a.push({ id, unit, kind, capacity, owner_id: owner, job_id });
  add('energy', 'mJ', 'stock', 1000 * MJ);
  add('water', 'uL');
  add('tips', 'count');
  add('kits', 'count');
  add('depot-water', 'uL');
  add('depot-tips', 'count');
  add('depot-kits', 'count');
  add('spill', 'mJ', 'spill');
  add('base-spent', 'mJ', 'spent');
  add('process-spent', 'mJ', 'spent');
  add('liquid-waste', 'uL', 'waste');
  add('service-waste', 'uL', 'waste');
  add('solid-waste', 'count', 'waste');
  for (let n = 1; n <= 24; n++)
    for (const [suffix, unit] of [
      ['energy', 'mJ'],
      ['water', 'uL'],
      ['tips', 'count'],
      ['kits', 'count'],
    ] as const)
      add(`hold-sample-${n}-${suffix}`, unit, 'reserved', null, `sample-${n}`);
  return a;
}
/** Settle simultaneous resource postings; only the exact declared slot solar credit may issue energy. */
function transfer(
  s: LabState,
  id: string,
  at: number,
  changes: [string, string, number][],
  credits: ResourceCredit[] = [],
): void {
  const balances = structuredClone(s.resources.balances),
    pool: ResourceAllocation[] = [];
  for (const credit of credits)
    pool.push({
      account_id: 'source',
      resource_id: credit.resource_id,
      lot_id: 'solar-energy',
      unit: 'mJ',
      quantity: credit.quantity,
    });
  // Preserve opening/delivery/solar lots during every transfer; deterministic FIFO never relabels stock.
  for (const [account_id, resource_id, delta] of changes.filter((c) => c[2] < 0)) {
    let remaining = -delta;
    for (const row of balances
      .filter((b) => b.account_id === account_id && b.resource_id === resource_id)
      .sort((a, b) => a.lot_id.localeCompare(b.lot_id))) {
      const take = Math.min(row.quantity, remaining);
      if (take) {
        row.quantity -= take;
        remaining -= take;
        pool.push({ ...row, quantity: take });
      }
    }
    if (remaining) throw Error('INSUFFICIENT_LAB_LOT');
  }
  for (const [account_id, resource_id, delta] of changes.filter((c) => c[2] > 0)) {
    let remaining = delta;
    for (const available of pool.filter((b) => b.resource_id === resource_id)) {
      const take = Math.min(available.quantity, remaining);
      if (!take) continue;
      const row = balances.find(
        (b) =>
          b.account_id === account_id &&
          b.resource_id === resource_id &&
          b.lot_id === available.lot_id,
      );
      if (row) row.quantity += take;
      else balances.push({ ...available, account_id, quantity: take });
      available.quantity -= take;
      remaining -= take;
    }
    if (remaining) throw Error('UNFUNDED_LAB_LOT');
  }
  if (pool.some((b) => b.quantity)) throw Error('UNALLOCATED_LAB_LOT');
  const solar =
    ((labConfig(s.scenario).solarWh[Math.floor(s.slot / 4)]! * labConfig(s.scenario).solarFactor) /
      4) *
    MJ;
  if (
    credits.length &&
    (credits.length !== 1 ||
      credits[0]!.resource_id !== 'energy' ||
      credits[0]!.source_id !== `solar-slot-${s.slot}` ||
      credits[0]!.quantity !== solar)
  )
    throw Error('INVALID_LAB_ISSUANCE');
  s.resources = settleResourceBalances(
    s.resources,
    {
      id,
      expected_sequence: s.resources.sequence,
      simulation_time_ms: at,
      actor: { kind: 'worker', principal_id: null },
      job_ids: s.active_job_id ? [s.active_job_id] : [],
    },
    s.resources.accounts,
    balances.filter((b) => b.quantity !== 0),
    credits,
    () => true,
  );
}
/** Reserve the exclusive instrument and all recipe inputs once; waiting never consumes stock. */
function startJob(s: LabState, j: EventJob, at: number): void {
  if (s.active_job_id || s.admitted) throw new DomainCommandError('INSTRUMENT_BUSY');
  if (
    !['queued', 'waiting-for-resource'].includes(j.state) ||
    arrival(j) > at - s.origin_ms ||
    s.slot >= 32
  )
    throw new DomainCommandError('JOB_NOT_AVAILABLE');
  const reasons = shortages(s);
  if (reasons.length) throw new DomainCommandError('RESOURCE_REQUIRED');
  const c = labConfig(s.scenario),
    changes: [string, string, number][] = [];
  for (const [a, r, n] of [
    ['energy', 'energy', c.sampleWh * MJ],
    ['water', 'water', c.sampleWaterL * UL],
    ['tips', 'tips', 2],
    ['kits', 'kits', 1],
  ] as const)
    changes.push([a, r, -n], [`${held(j)}-${a}`, r, n]);
  transfer(s, `reserve:${j.id}`, at, changes);
  j.state = 'running';
  j.reason = null;
  j.checkpoint = { ...j.checkpoint, phase: 'assay', reserved: true, started: true };
  s.active_job_id = j.id;
  s.admitted = true;
}
/** Admission reserves both the recipe cost and the original benchmark's remaining utility margin. */
function shortages(s: LabState): string[] {
  const c = labConfig(s.scenario),
    r: string[] = [];
  if (quantity(s, 'kits', 'kits') < 1) r.push('kits');
  if (quantity(s, 'tips', 'tips') < 2) r.push('tips');
  if (quantity(s, 'water', 'water') < Math.round((c.sampleWaterL + c.waterReserveL) * UL))
    r.push('water');
  if (quantity(s, 'energy', 'energy') < Math.round((c.sampleWh + c.reserveWh) * MJ))
    r.push('energy');
  return r;
}
/** Book one frozen 15-minute supply/utility slot, then optionally admit exactly one job. */
function openSlot(s: LabState, at: number): void {
  if (s.slot >= 32) return;
  const c = labConfig(s.scenario);
  s.admitted = false;
  s.slot_completed = 0;
  s.slot_reasons = [];
  const changes: [string, string, number][] = [];
  if (!s.delivery_arrived && c.deliveryMinute !== null && s.slot * 15 >= c.deliveryMinute) {
    for (const [a, r, n] of [
      ['water', 'water', c.delivery.waterL * UL],
      ['tips', 'tips', c.delivery.tips],
      ['kits', 'kits', c.delivery.kits],
    ] as const)
      changes.push([`depot-${a}`, r, -n], [a, r, n]);
    s.totals.delivered_water_ul += c.delivery.waterL * UL;
    s.totals.delivered_tips += c.delivery.tips;
    s.totals.delivered_kits += c.delivery.kits;
    s.delivery_arrived = true;
    transfer(s, 'delivery:district-1', at, changes);
    changes.length = 0;
  }
  const generated = Math.round(((c.solarWh[Math.floor(s.slot / 4)]! * c.solarFactor) / 4) * MJ),
    spill = Math.max(0, quantity(s, 'energy', 'energy') + generated - c.batteryCapacityWh * MJ);
  const base = Math.round((c.baseLoadW / 4) * MJ),
    served = Math.min(quantity(s, 'energy', 'energy') + generated - spill, base);
  const demand = Math.round((c.serviceWaterLPerHour / 4) * UL),
    water = Math.min(quantity(s, 'water', 'water'), demand);
  changes.push(
    ['energy', 'energy', generated - spill - served],
    ['spill', 'energy', spill],
    ['base-spent', 'energy', served],
    ['water', 'water', -water],
    ['service-waste', 'water', water],
  );
  transfer(s, `slot:${s.slot}`, at, changes, [
    {
      resource_id: 'energy',
      quantity: generated,
      kind: 'metered',
      source_id: `solar-slot-${s.slot}`,
    },
  ]);
  s.totals.generated_mj += generated;
  s.totals.spill_mj += spill;
  s.totals.base_served_mj += served;
  s.totals.base_unmet_mj += base - served;
  s.totals.service_water_ul += water;
  s.totals.service_unmet_ul += demand - water;
  const waiting = s.jobs.filter(
    (j) => ['queued', 'waiting-for-resource'].includes(j.state) && arrival(j) <= at - s.origin_ms,
  );
  if (waiting.length && !s.active_job_id) {
    const reasons = shortages(s);
    s.slot_reasons = reasons;
    for (const reason of reasons) s.blocked[reason as keyof LabState['blocked']] += 15;
    for (const j of waiting) {
      j.state = reasons.length ? 'waiting-for-resource' : 'queued';
      j.reason = reasons.length ? `await-${reasons.join('-')}` : null;
    }
    if (!reasons.length && s.dispatch === 'automatic') startJob(s, waiting[0]!, at);
  }
}
/** Paid work uses cumulative fixed-point rounding, independent of polling or restart cadence. */
function work(s: LabState, dt: number, at: number): void {
  const j = s.jobs.find((j) => j.id === s.active_job_id);
  if (!j || j.state !== 'running') return;
  const c = labConfig(s.scenario),
    before = j.progress_ms,
    after = Math.min(labSlotMs, before + dt);
  j.progress_ms = after;
  const energy =
    Math.floor((after * c.sampleWh * MJ) / labSlotMs) -
    Math.floor((before * c.sampleWh * MJ) / labSlotMs);
  const water =
    Math.floor((after * Math.round(c.sampleWaterL * UL)) / labSlotMs) -
    Math.floor((before * Math.round(c.sampleWaterL * UL)) / labSlotMs);
  const changes: [string, string, number][] = [
    [`${held(j)}-energy`, 'energy', -energy],
    ['process-spent', 'energy', energy],
    [`${held(j)}-water`, 'water', -water],
    ['liquid-waste', 'water', water],
  ];
  if (after === labSlotMs) {
    changes.push(
      [`${held(j)}-tips`, 'tips', -2],
      ['solid-waste', 'tips', 2],
      [`${held(j)}-kits`, 'kits', -1],
      ['solid-waste', 'kits', 1],
    );
    j.state = 'completed';
    j.checkpoint = { ...j.checkpoint, phase: 'result', reserved: false };
    s.active_job_id = null;
    s.slot_completed++;
  }
  transfer(s, `work:${j.id}:${before}:${after}`, at, changes);
  s.totals.process_mj += energy;
  s.totals.sample_water_ul += water;
}
/** Abort returns only unspent water/energy; opened consumables become waste, never reusable stock. */
function stop(
  s: LabState,
  j: EventJob,
  state: 'cancelled' | 'failed',
  reason: string,
  at: number,
): void {
  if (terminal.has(j.state)) throw new DomainCommandError('JOB_TERMINAL');
  if (s.active_job_id === j.id) {
    const changes: [string, string, number][] = [];
    for (const [a, r] of [
      ['energy', 'energy'],
      ['water', 'water'],
      ['tips', 'tips'],
      ['kits', 'kits'],
    ] as const) {
      const n = quantity(s, `${held(j)}-${a}`, r);
      changes.push(
        [`${held(j)}-${a}`, r, -n],
        [a === 'tips' || a === 'kits' ? 'solid-waste' : a, r, n],
      );
    }
    const returned = quantity(s, `${held(j)}-energy`, 'energy'),
      spill = Math.max(0, quantity(s, 'energy', 'energy') + returned - 1000 * MJ);
    if (spill) {
      changes.push(['energy', 'energy', -spill], ['spill', 'energy', spill]);
      s.totals.spill_mj += spill;
    }
    transfer(s, `stop:${j.id}`, at, changes);
    s.active_job_id = null;
  }
  j.state = state;
  j.reason = reason;
  j.checkpoint = { ...j.checkpoint, phase: state, reserved: false };
}
/** Derive the same end-of-slot rows as the frozen in-memory baseline, without using that simulator. */
function closeSlot(s: LabState): void {
  const arrived = Math.min(24, 6 * (Math.floor(s.slot / 8) + 1)),
    processed = s.jobs.filter((j) => j.state === 'completed').length;
  s.timeline.push({
    minute: (s.slot + 1) * 15,
    arrived,
    completed: s.slot_completed,
    processed,
    queued: arrived - processed,
    batteryWh: quantity(s, 'energy', 'energy') / MJ,
    waterL: quantity(s, 'water', 'water') / UL,
    tips: quantity(s, 'tips', 'tips'),
    kits: quantity(s, 'kits', 'kits'),
    delivered: s.delivery_arrived,
    reasons: s.slot_reasons,
  });
}
/** Build exact typed bindings/results from authoritative state, not renderer animation time. */
function evidence(instance: SimulationInstance): void {
  const s = labState(instance),
    owner = instance.members[0]!.principal_id;
  instance.observations = s.jobs
    .filter((j) => j.state === 'completed')
    .map((j) => ({
      id: `result-${j.id}`,
      target: { instance_id: instance.id, entity_id: 'instruments' },
      owner_id: owner,
      source_id: 'FIELD-LAB-01',
      source_revision: 'v1',
      recorded_at_ms: Number(j.checkpoint.completed_at_ms),
      origin: 'simulated',
      validity: 'modeled',
      value: { job_id: j.id, result: 'modeled-job-complete', assay_validity: 'not-validated' },
    }));
}
/** Bounded shared event-clock advancement; a maximum of 128 boundaries drains this finite day. */
export function advanceLab(
  raw: SimulationInstance,
  wallNow: number,
  budget = 128,
): SimulationInstance {
  const initial = structuredClone(raw),
    s = labState(initial),
    target = Math.max(s.observed_at_ms, wallNow);
  const clock = advanceEventClock(
    {
      instance_id: raw.id,
      cursor_ms: s.cursor_ms,
      observed_at_ms: s.observed_at_ms,
      instance: initial,
    },
    Math.min(target, s.origin_ms + labDayMs),
    budget,
    {
      validate: (st) => {
        validateEventJobs(labState(st.instance).jobs);
        validateResourceBalances(labState(st.instance).resources);
      },
      next: (st) => {
        const d = labState(st.instance),
          j = d.jobs.find((j) => j.id === d.active_job_id),
          boundary = d.origin_ms + (d.slot + 1) * labSlotMs;
        return Math.min(
          st.observed_at_ms - st.cursor_ms,
          boundary - st.cursor_ms,
          j?.state === 'running' ? labSlotMs - j.progress_ms : labSlotMs,
        );
      },
      step: (st, step) => {
        const d = labState(st.instance),
          before = structuredClone(d.jobs);
        work(d, step.duration_ms, step.at_ms);
        d.cursor_ms = step.at_ms;
        for (const j of d.jobs)
          if (j.state === 'completed' && !j.checkpoint.completed_at_ms)
            j.checkpoint.completed_at_ms = step.at_ms;
        if (step.at_ms === d.origin_ms + (d.slot + 1) * labSlotMs) {
          closeSlot(d);
          d.slot++;
          if (d.slot < 32) openSlot(d, step.at_ms);
          else
            for (const j of d.jobs)
              if (!terminal.has(j.state))
                stop(d, j, 'failed', 'day-ended-review-unserved-work', step.at_ms);
        }
        transitionEventJobs(before, d.jobs, { maxProgress: step.duration_ms });
        st.instance.simulation_time_ms = step.at_ms;
        evidence(st.instance);
      },
    },
  );
  const next = clock.instance;
  labState(next).observed_at_ms = clock.observed_at_ms;
  if (canonicalCommand(next) !== canonicalCommand(raw)) next.revision++;
  return next;
}
/** Initialize one finite lab day; delivery stock is present at the depot before arrival. */
export function createLab(
  id: string,
  owner: string,
  scenario: string,
  at: number,
  dispatch: 'automatic' | 'manual' = 'automatic',
): SimulationInstance {
  const c = labConfig(scenario),
    allocations: ResourceAllocation[] = [];
  for (const [a, r, u, n] of [
    ['energy', 'energy', 'mJ', c.batteryWh * MJ],
    ['water', 'water', 'uL', c.waterL * UL],
    ['tips', 'tips', 'count', c.tips],
    ['kits', 'kits', 'count', c.kits],
    ['depot-water', 'water', 'uL', c.deliveryMinute === null ? 0 : c.delivery.waterL * UL],
    ['depot-tips', 'tips', 'count', c.deliveryMinute === null ? 0 : c.delivery.tips],
    ['depot-kits', 'kits', 'count', c.deliveryMinute === null ? 0 : c.delivery.kits],
  ] as const)
    if (n)
      allocations.push({
        account_id: a,
        resource_id: r,
        lot_id: (a.startsWith('depot-') ? 'district-1-' : 'opening-') + r,
        unit: u,
        quantity: n,
      });
  const jobs: EventJob[] = Array.from({ length: 24 }, (_, n) => ({
    id: `sample-${n + 1}`,
    owner_id: owner,
    kind: 'environmental-water-assay',
    state: 'queued',
    reason: null,
    progress_ms: 0,
    checkpoint: {
      recipe: 'FIELD-LAB-01-v1',
      phase: 'intake',
      reserved: false,
      started: false,
      instrument_id: 'instruments',
      pipette_id: 'pipette',
    },
  }));
  const state: LabState = {
    model_sha256: modelDigest,
    scenario,
    dispatch,
    origin_ms: at,
    cursor_ms: at,
    observed_at_ms: at,
    slot: 0,
    admitted: false,
    active_job_id: null,
    delivery_arrived: false,
    jobs,
    resources: createResourceBalances(id, fieldLabPin, accounts(owner), allocations, at),
    totals: {
      generated_mj: 0,
      spill_mj: 0,
      base_served_mj: 0,
      base_unmet_mj: 0,
      process_mj: 0,
      sample_water_ul: 0,
      service_water_ul: 0,
      service_unmet_ul: 0,
      delivered_water_ul: 0,
      delivered_tips: 0,
      delivered_kits: 0,
    },
    blocked: { kits: 0, tips: 0, water: 0, energy: 0 },
    timeline: [],
    slot_reasons: [],
    slot_completed: 0,
  };
  openSlot(state, at);
  return {
    contract_version: 1,
    id,
    pin: { ...fieldLabPin },
    revision: 1,
    simulation_time_ms: at,
    members: [{ principal_id: owner, role: 'owner' }],
    frames: [],
    entities: equipment.map((sceneId) => ({
      id: sceneId,
      instance_id: id,
      kind: 'lab-equipment',
      revision: 1,
      owner_id: owner,
      access: { read: 'owner' as const, write: 'owner' as const },
      location: null,
      references: [],
      data: {
        scene_fixture: 'FIELD-LAB-01',
        scene_sha256: sceneDigest,
        scene_instance_id: sceneId,
      },
    })),
    observations: [],
    state: asJson(state),
  };
}
/** Public schema-checked projection has no credentials or cross-lab information. */
export function projectLab(instance: Readonly<SimulationInstance>): JsonObject {
  const s = labState(instance);
  return asJson({
    version: 1,
    instance_id: instance.id,
    pin: instance.pin,
    revision: instance.revision,
    simulation_time_ms: instance.simulation_time_ms,
    scenario: s.scenario,
    dispatch: s.dispatch,
    origin_ms: s.origin_ms,
    cursor_ms: s.cursor_ms,
    observed_at_ms: s.observed_at_ms,
    day_complete: s.slot === 32,
    recipe: {
      id: 'FIELD-LAB-01-v1',
      duration_ms: labSlotMs,
      energy_mj: 12 * MJ,
      water_ul: 350000,
      tips: 2,
      kits: 1,
    },
    bindings: instance.entities,
    jobs: s.jobs,
    delivery: {
      id: 'district-1',
      due_minute: labConfig(s.scenario).deliveryMinute,
      arrived: s.delivery_arrived,
    },
    resources: s.resources,
    totals: s.totals,
    blocked_minutes: s.blocked,
    timeline: s.timeline,
    results: instance.observations,
  });
}
const phaseSchema = objectSchema({
  recipe: { const: 'FIELD-LAB-01-v1' },
  phase: { enum: ['intake', 'assay', 'result', 'cancelled', 'failed'] },
  reserved: { type: 'boolean' },
  started: { type: 'boolean' },
  instrument_id: { const: 'instruments' },
  pipette_id: { const: 'pipette' },
  completed_at_ms: int,
});
phaseSchema.required = ['recipe', 'phase', 'reserved', 'started', 'instrument_id', 'pipette_id'];
const jobSchema = objectSchema({
  id: identifier,
  owner_id: identifier,
  kind: { const: 'environmental-water-assay' },
  state: {
    enum: [
      'queued',
      'running',
      'waiting-for-resource',
      'paused',
      'completed',
      'cancelled',
      'failed',
    ],
  },
  reason: { anyOf: [identifier, { type: 'null' }] },
  progress_ms: { ...int, maximum: labSlotMs },
  checkpoint: phaseSchema,
});
const rowSchema = objectSchema({
  minute: { type: 'integer', minimum: 15, maximum: 480 },
  arrived: { type: 'integer', minimum: 0, maximum: 24 },
  completed: { type: 'integer', minimum: 0, maximum: 1 },
  processed: { type: 'integer', minimum: 0, maximum: 24 },
  queued: { type: 'integer', minimum: 0, maximum: 24 },
  batteryWh: { type: 'number', minimum: 0, maximum: 1000 },
  waterL: { type: 'number', minimum: 0, maximum: 32 },
  tips: { type: 'integer', minimum: 0, maximum: 48 },
  kits: { type: 'integer', minimum: 0, maximum: 24 },
  delivered: { type: 'boolean' },
  reasons: { type: 'array', maxItems: 4, items: { enum: ['kits', 'tips', 'water', 'energy'] } },
});
const jobPayload = objectSchema({ job_id: identifier });
export const fieldLabModule: DomainModule = {
  pin: fieldLabPin,
  stateSchema: objectSchema({
    model_sha256: { const: modelDigest },
    scenario: { enum: labScenarios },
    dispatch: { enum: ['automatic', 'manual'] },
    origin_ms: int,
    cursor_ms: int,
    observed_at_ms: int,
    slot: { type: 'integer', minimum: 0, maximum: 32 },
    admitted: { type: 'boolean' },
    active_job_id: { anyOf: [identifier, { type: 'null' }] },
    delivery_arrived: { type: 'boolean' },
    resources: resourceBalancesSchema(),
    jobs: { type: 'array', minItems: 24, maxItems: 24, items: jobSchema },
    totals: objectSchema(
      Object.fromEntries(
        [
          'generated_mj',
          'spill_mj',
          'base_served_mj',
          'base_unmet_mj',
          'process_mj',
          'sample_water_ul',
          'service_water_ul',
          'service_unmet_ul',
          'delivered_water_ul',
          'delivered_tips',
          'delivered_kits',
        ].map((k) => [k, int]),
      ),
    ),
    blocked: objectSchema(
      Object.fromEntries(['kits', 'tips', 'water', 'energy'].map((k) => [k, int])),
    ),
    timeline: { type: 'array', maxItems: 32, items: rowSchema },
    slot_reasons: {
      type: 'array',
      maxItems: 4,
      items: { enum: ['kits', 'tips', 'water', 'energy'] },
    },
    slot_completed: { type: 'integer', minimum: 0, maximum: 1 },
  }),
  commandSchema: objectSchema({
    action: { enum: ['start', 'pause', 'resume', 'cancel', 'fail'] },
    payload: jobPayload,
  }),
  projectionSchema: objectSchema({
    version: { const: 1 },
    instance_id: identifier,
    pin: pinSchema,
    revision: int,
    simulation_time_ms: int,
    scenario: { enum: labScenarios },
    dispatch: { enum: ['automatic', 'manual'] },
    origin_ms: int,
    cursor_ms: int,
    observed_at_ms: int,
    day_complete: { type: 'boolean' },
    recipe: { type: 'object' },
    bindings: instanceSchema.properties!.entities,
    jobs: { type: 'array', minItems: 24, maxItems: 24, items: jobSchema },
    delivery: { type: 'object' },
    resources: resourceBalancesSchema(),
    totals: { type: 'object' },
    blocked_minutes: { type: 'object' },
    timeline: { type: 'array', maxItems: 32, items: rowSchema },
    results: instanceSchema.properties!.observations,
  }),
  validateInvariants(instance) {
    const s = labState(instance);
    validateEventJobs(s.jobs);
    validateResourceBalances(s.resources);
    if (
      instance.members.length !== 1 ||
      s.cursor_ms !== instance.simulation_time_ms ||
      s.cursor_ms < s.origin_ms ||
      s.cursor_ms > s.origin_ms + labDayMs ||
      s.observed_at_ms < s.cursor_ms ||
      s.observed_at_ms > s.origin_ms + labDayMs ||
      s.timeline.length !== s.slot ||
      s.resources.instance_id !== instance.id ||
      canonicalCommand(s.resources.rule) !== canonicalCommand(fieldLabPin)
    )
      throw Error('INVALID_LAB');
    if (
      canonicalCommand(s.resources.accounts) !==
      canonicalCommand(accounts(instance.members[0]!.principal_id))
    )
      throw Error('INVALID_ACCOUNTS');
    if (
      new Set(s.jobs.map((j) => j.id)).size !== 24 ||
      s.jobs.some(
        (j) =>
          j.owner_id !== instance.members[0]!.principal_id ||
          j.kind !== 'environmental-water-assay' ||
          !/^sample-([1-9]|1[0-9]|2[0-4])$/.test(j.id) ||
          j.progress_ms > labSlotMs ||
          (j.state === 'completed' && j.progress_ms !== labSlotMs),
      )
    )
      throw Error('INVALID_JOBS');
    if (
      s.jobs.filter((j) => ['running', 'paused'].includes(j.state)).length !==
        (s.active_job_id ? 1 : 0) ||
      (s.active_job_id &&
        !s.jobs.some((j) => j.id === s.active_job_id && ['running', 'paused'].includes(j.state)))
    )
      throw Error('INVALID_INSTRUMENT_RESERVATION');
    const c = labConfig(s.scenario),
      sum = (r: string) =>
        s.resources.balances.filter((b) => b.resource_id === r).reduce((n, b) => n + b.quantity, 0);
    if (
      sum('energy') !== c.batteryWh * MJ + s.totals.generated_mj ||
      sum('water') !== (c.waterL + (c.deliveryMinute === null ? 0 : c.delivery.waterL)) * UL ||
      sum('tips') !== c.tips + (c.deliveryMinute === null ? 0 : c.delivery.tips) ||
      sum('kits') !== c.kits + (c.deliveryMinute === null ? 0 : c.delivery.kits)
    )
      throw Error('INVALID_TOTALS');
    if (
      quantity(s, 'process-spent', 'energy') !== s.totals.process_mj ||
      quantity(s, 'liquid-waste', 'water') !== s.totals.sample_water_ul ||
      quantity(s, 'base-spent', 'energy') !== s.totals.base_served_mj ||
      quantity(s, 'spill', 'energy') !== s.totals.spill_mj ||
      quantity(s, 'service-waste', 'water') !== s.totals.service_water_ul
    )
      throw Error('INVALID_SINKS');
    const booked = Math.min(32, s.slot + 1),
      generated =
        c.solarWh.slice(0, Math.floor(booked / 4)).reduce((n, w) => n + w * c.solarFactor * MJ, 0) +
        ((booked % 4) * (c.solarWh[Math.floor(booked / 4)] ?? 0) * c.solarFactor * MJ) / 4;
    if (
      s.totals.generated_mj !== Math.round(generated) ||
      (s.resources.issued_totals.energy ?? 0) !== s.totals.generated_mj ||
      s.totals.base_served_mj + s.totals.base_unmet_mj !== (booked * c.baseLoadW * MJ) / 4 ||
      s.totals.service_water_ul + s.totals.service_unmet_ul !==
        booked * Math.round((c.serviceWaterLPerHour * UL) / 4)
    )
      throw Error('INVALID_UTILITY_DEMAND');
    for (const [a, r, n] of [
      ['water', 'water', c.delivery.waterL * UL],
      ['tips', 'tips', c.delivery.tips],
      ['kits', 'kits', c.delivery.kits],
    ] as const)
      if (
        quantity(s, `depot-${a}`, r) !== (c.deliveryMinute === null || s.delivery_arrived ? 0 : n)
      )
        throw Error('INVALID_DELIVERY');
    const expectedEnergy = s.jobs.reduce(
        (n, j) => n + Math.floor((j.progress_ms * c.sampleWh * MJ) / labSlotMs),
        0,
      ),
      expectedWater = s.jobs.reduce(
        (n, j) => n + Math.floor((j.progress_ms * Math.round(c.sampleWaterL * UL)) / labSlotMs),
        0,
      );
    if (s.totals.process_mj !== expectedEnergy || s.totals.sample_water_ul !== expectedWater)
      throw Error('INVALID_PAID_WORK');
    for (const j of s.jobs) {
      const active = s.active_job_id === j.id;
      if (
        j.checkpoint.recipe !== 'FIELD-LAB-01-v1' ||
        j.checkpoint.instrument_id !== 'instruments' ||
        j.checkpoint.pipette_id !== 'pipette' ||
        j.checkpoint.reserved !== active ||
        typeof j.checkpoint.started !== 'boolean' ||
        (!j.checkpoint.started && j.progress_ms)
      )
        throw Error('INVALID_PHASE');
      for (const [a, r, n] of [
        [
          'energy',
          'energy',
          c.sampleWh * MJ - Math.floor((j.progress_ms * c.sampleWh * MJ) / labSlotMs),
        ],
        [
          'water',
          'water',
          Math.round(c.sampleWaterL * UL) -
            Math.floor((j.progress_ms * Math.round(c.sampleWaterL * UL)) / labSlotMs),
        ],
        ['tips', 'tips', 2],
        ['kits', 'kits', 1],
      ] as const)
        if (quantity(s, `${held(j)}-${a}`, r) !== (active ? n : 0))
          throw Error('INVALID_HELD_INPUTS');
      if (
        j.state === 'completed' &&
        (!Number.isSafeInteger(j.checkpoint.completed_at_ms) ||
          Number(j.checkpoint.completed_at_ms) > s.cursor_ms ||
          Number(j.checkpoint.completed_at_ms) < s.origin_ms)
      )
        throw Error('INVALID_RESULT_TIME');
    }
    const used = s.jobs.filter((j) => j.checkpoint.started && j.id !== s.active_job_id).length;
    if (
      quantity(s, 'solid-waste', 'tips') !== 2 * used ||
      quantity(s, 'solid-waste', 'kits') !== used
    )
      throw Error('INVALID_CONSUMABLE_WASTE');
    const lots = new Map<string, { resource: string; quantity: number }>([
      ['opening-energy', { resource: 'energy', quantity: c.batteryWh * MJ }],
      ['opening-water', { resource: 'water', quantity: c.waterL * UL }],
      ['opening-tips', { resource: 'tips', quantity: c.tips }],
      ['opening-kits', { resource: 'kits', quantity: c.kits }],
      [
        'district-1-water',
        { resource: 'water', quantity: c.deliveryMinute === null ? 0 : c.delivery.waterL * UL },
      ],
      [
        'district-1-tips',
        { resource: 'tips', quantity: c.deliveryMinute === null ? 0 : c.delivery.tips },
      ],
      [
        'district-1-kits',
        { resource: 'kits', quantity: c.deliveryMinute === null ? 0 : c.delivery.kits },
      ],
      ['solar-energy', { resource: 'energy', quantity: s.totals.generated_mj }],
    ]);
    if (
      s.resources.balances.some(
        (b) => !lots.has(b.lot_id) || lots.get(b.lot_id)!.resource !== b.resource_id,
      )
    )
      throw Error('INVALID_LOT');
    for (const [id, lot] of lots)
      if (
        s.resources.balances.filter((b) => b.lot_id === id).reduce((n, b) => n + b.quantity, 0) !==
        lot.quantity
      )
        throw Error('LOT_CONSERVATION');
    const copy = structuredClone(instance) as SimulationInstance;
    evidence(copy);
    if (canonicalCommand(copy.observations) !== canonicalCommand(instance.observations))
      throw Error('INVALID_RESULTS');
    if (
      instance.entities.length !== equipment.length ||
      instance.entities.some(
        (e, n) =>
          e.id !== equipment[n] ||
          e.instance_id !== instance.id ||
          e.owner_id !== instance.members[0]!.principal_id ||
          e.data.scene_sha256 !== sceneDigest ||
          e.data.scene_instance_id !== e.id,
      )
    )
      throw Error('INVALID_BINDINGS');
  },
  authorizeCommand: (instance, _command, context) =>
    instance.members.some((m) => m.principal_id === context.principal_id && m.role === 'owner'),
  proposeTransition(instance, command) {
    const next = structuredClone(instance) as SimulationInstance,
      s = labState(next),
      before = structuredClone(s.jobs),
      j = s.jobs.find((j) => j.id === command.payload.job_id);
    if (!j) throw new DomainCommandError('JOB_NOT_AVAILABLE');
    if (s.slot === 32) throw new DomainCommandError('DAY_COMPLETE');
    if (command.action === 'start') startJob(s, j, s.cursor_ms);
    else if (command.action === 'pause') {
      if (j.state !== 'running') throw new DomainCommandError('JOB_NOT_RUNNING');
      j.state = 'paused';
      j.reason = 'operator-paused';
    } else if (command.action === 'resume') {
      if (j.state !== 'paused') throw new DomainCommandError('JOB_NOT_PAUSED');
      j.state = 'running';
      j.reason = null;
    } else
      stop(
        s,
        j,
        command.action === 'cancel' ? 'cancelled' : 'failed',
        command.action === 'cancel' ? 'operator-cancelled' : 'modeled-instrument-fault',
        s.cursor_ms,
      );
    transitionEventJobs(before, s.jobs, { maxProgress: 0 });
    return { state: asJson(s), events: [] };
  },
  project: projectLab,
  migrations: [],
};
