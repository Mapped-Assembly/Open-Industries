import { createHmac, randomUUID } from 'node:crypto';

export const robotVersion = 'robots-v1';
export const fieldVersion = 'field-sensors-v1';
export const materialClasses = ['unclassified', 'conductor-candidate', 'ferrous-candidate', 'polymer-candidate', 'glass-candidate', 'rubber-candidate'];
export const sensorCatalog = [
  { id: 'camera-depth', range: 8, duration_ms: 2000, power_w: 20, kit: null, establishes: 'Visible shapes and accessible surfaces; never chemistry.' },
  { id: 'magnetic-inductive', range: 2, duration_ms: 3000, power_w: 30, kit: null, establishes: 'Ferrous/conductive response; never alloy or purity.' },
  { id: 'nir', range: 3, duration_ms: 3000, power_w: 40, kit: 'nir-sensor-kit', establishes: 'Candidate polymer class on clean exposed surfaces; not a grade.' },
  { id: 'thermal', range: 8, duration_ms: 2000, power_w: 25, kit: 'thermal-sensor-kit', establishes: 'Surface heat only; never battery health.' },
];
const keys = ['steel', 'aluminum', 'copper', 'hdpe', 'glass', 'rubber', 'dirt', 'unknown'];
export const contentsOf = b => b.contents ?? Object.fromEntries(['copper', 'hdpe', 'dirt'].map(k => [k, b[`${k}_g`] ?? 0]));
export const grams = contents => Object.values(contents).reduce((a, b) => a + b, 0);
const sum = (into, contents) => { for (const k of keys) into[k] = (into[k] ?? 0) + (contents[k] ?? 0); return into; };
const live = j => j && ['running', 'paused'].includes(j.state);
const same = (a, b) => a.x === b.x && a.y === b.y;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const seedByte = (w, d) => createHmac('sha256', w.seed).update(`field-v1/${d.id}`).digest()[0];

/** Adds structure to previously unspecified scrap once; never rerolls existing mass or cable truth. */
export function initializeRobots(match, legacy = false) {
  if (!match.robot_version) {
    match.robot_version = robotVersion;
    match.legacy_recovery = legacy;
    for (const d of match.world.deposits) {
      let initial;
      if (d.kind === 'cable') initial = contentsOf(d.truth);
      else {
        const mass = d.truth.mass_g, dirt = Math.floor(mass / 10);
        const primary = { appliance: 'steel', packaging: 'hdpe', vehicle: 'aluminum', glass: 'glass', tire: 'rubber', construction: 'steel' }[d.kind];
        const unknown = ['appliance', 'vehicle'].includes(d.kind) ? Math.floor(mass / 5) : 0;
        initial = { [primary]: mass - dirt - unknown, dirt, ...(unknown ? { unknown } : {}) };
      }
      const collected = match.players.some(p => p.deposit.id === d.id && p.deposit.collected);
      d.stock = { initial, remaining: collected ? {} : structuredClone(initial), revision: 1 };
      d.surface = { dirty: d.kind === 'packaging', occluded: d.kind === 'vehicle', signal: seedByte(match.world, d) < 32 ? 'low' : 'normal' };
    }
  }
  for (const p of match.players) {
    if (!p.robots) for (const a of p.base.assets.filter(a => a.kind === 'robot')) {
      // The field milestone explicitly provisions one probe per starter robot, with a mass allocation.
      const probe = { kind: 'magnetic-inductive-probe', quantity: 1, unit_mass_g: 200 };
      if (!a.components.some(c => c.kind === probe.kind)) {
        a.components.push({ ...probe });
        const after = p.base.starter_ledger.findLastIndex(c => c.allocation_id === a.id);
        p.base.starter_ledger.splice(after + 1, 0, { ...probe, allocation_id: a.id });
      }
      a.status = 'ready';
    }
    p.robots ??= p.base.assets.filter(a => a.kind === 'robot').map(a => ({ id: a.id, position: { ...a.position },
      home: { ...p.base.assets.find(a => a.kind === 'battery').position }, capacity_mj: 8000000, energy_mj: 8000000,
      initial_mj: 8000000, charged_mj: 0, spent_mj: 0, payload_g: 10000,
      sensors: ['camera-depth', 'magnetic-inductive'], cargo: [], job_id: null }));
    p.robot_jobs ??= []; p.surveys ??= []; p.robot_charge_mj ??= 0;
  }
}

export function walkable(w, point) {
  return Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= 1 && point.x < w.width && point.y >= 1 && point.y < w.height
    && !w.obstacles.some(r => point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height)
    && !w.deposits.some(d => same(d.position, point));
}
export function lineOfSight(w, a, b) {
  const steps = Math.ceil(distance(a, b) * 4);
  for (let i = 1; i < steps; i++) {
    const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps;
    if (w.obstacles.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) return false;
  }
  return true;
}
/** Fixed neighbor order makes routes reproducible on either platform. No caller supplies waypoints. */
export function route(w, start, accepts) {
  const queue = [{ ...start }], parents = new Map([[`${start.x},${start.y}`, null]]);
  for (let n = 0; n < queue.length; n++) {
    const at = queue[n], key = `${at.x},${at.y}`;
    if (accepts(at)) {
      const path = []; let current = at;
      while (!same(current, start)) { path.push(current); current = parents.get(`${current.x},${current.y}`); }
      return path.reverse();
    }
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const next = { x: at.x + dx, y: at.y + dy }, id = `${next.x},${next.y}`;
      if (!parents.has(id) && walkable(w, next)) { parents.set(id, at); queue.push(next); }
    }
  }
  return null;
}
const travel = (path, load = 0) => ({ kind: 'travel', path, duration_ms: path.length * 250, power_w: 80 + Math.ceil(load / 250) });
const cargoMass = r => r.cargo.reduce((n, b) => n + grams(b.contents), 0);
const phase = job => job.phases[job.phase_index];
export const robotJob = (p, r) => p.robot_jobs.find(j => j.id === r.job_id);
export const robotsBusy = p => p.robot_jobs.some(live);
const jobCost = phases => phases.reduce((n, s) => n + s.duration_ms * s.power_w, 0);

function take(contents, amount) {
  const total = grams(contents), result = {}; let assigned = 0;
  // Largest remainders allocate whole grams without loss, independent of object insertion order.
  const rows = keys.filter(k => contents[k]).map(k => ({ k, n: Math.floor(contents[k] * amount / total), remainder: contents[k] * amount % total }));
  for (const r of rows) assigned += r.n;
  for (const r of [...rows].sort((a, b) => b.remainder - a.remainder || keys.indexOf(a.k) - keys.indexOf(b.k)).slice(0, amount - assigned)) r.n++;
  for (const r of rows) { if (r.n) result[r.k] = r.n; contents[r.k] -= r.n; }
  return result;
}
function newJob(p, r, action, phases, now, extra = {}) {
  const j = { id: randomUUID(), robot_id: r.id, action, state: 'running', reason: null, started_at_ms: now,
    phase_index: 0, phase_work_ms: 0, work_ms: 0, energy_mj: 0, charged_mj: 0, phases, ...extra };
  p.robot_jobs.push(j); r.job_id = j.id; p.base.ready_to_finish = false; return j;
}
export function stopRobot(match, p, r, reason) {
  const j = robotJob(p, r);
  if (!live(j)) return;
  if (j.reserved) {
    const d = match.world.deposits.find(d => d.id === j.target_id);
    sum(d.stock.remaining, j.reserved.contents); d.stock.revision++; j.reserved = null;
  }
  j.state = 'cancelled'; j.reason = reason; r.job_id = null;
}
export function commandRobot(match, p, args, now, fail) {
  const r = p.robots.find(r => r.id === args.robot_id);
  if (!r) fail('NOT_AVAILABLE');
  if (args.action === 'interrupt_robot') {
    if (!live(robotJob(p, r))) fail('NOT_READY');
    const back = route(match.world, r.position, at => same(at, r.home));
    // A partly completed final grid step must finish if stopping would strand the robot.
    if (!back || jobCost([travel(back, cargoMass(r))]) > r.energy_mj) fail('ROBOT_ENERGY');
    stopRobot(match, p, r, 'interrupted'); return;
  }
  if (args.action === 'retreat_robot') stopRobot(match, p, r, 'retreat');
  if (live(robotJob(p, r))) fail('ROBOT_BUSY');
  if (p.robot_jobs.length >= 96) {
    if (!['return_robot', 'retreat_robot', 'recharge_robot'].includes(args.action)) fail('LIMIT_REACHED');
    const old = p.robot_jobs.findIndex(j => !live(j));
    if (old < 0) fail('LIMIT_REACHED');
    p.robot_jobs.splice(old, 1);
  }
  const homeRoute = from => route(match.world, from, at => same(at, r.home));
  if (['return_robot', 'retreat_robot', 'recharge_robot'].includes(args.action)) {
    const path = homeRoute(r.position);
    if (!path) fail('ROUTE_BLOCKED');
    if (jobCost([travel(path, cargoMass(r))]) > r.energy_mj) fail('ROBOT_ENERGY');
    if (args.action === 'recharge_robot' && p.machine.status !== 'ready') fail('NOT_READY');
    newJob(p, r, args.action, [travel(path, cargoMass(r)), { kind: 'unload', duration_ms: 0, power_w: 0 },
      ...(args.action === 'recharge_robot' ? [{ kind: 'charge', duration_ms: 0, power_w: 0 }] : [])], now);
    return;
  }
  const d = match.world.deposits.find(d => d.id === args.deposit_id);
  if (!d) fail('NOT_AVAILABLE');
  if (match.legacy_recovery && d.kind === 'cable') fail('LEGACY_DEPOSIT');
  if (args.action === 'survey_robot') {
    const sensor = sensorCatalog.find(s => s.id === args.sensor);
    if (!sensor || !r.sensors.includes(sensor.id)) fail('SENSOR_UNAVAILABLE');
    if (p.surveys.length >= 128) fail('LIMIT_REACHED');
    const path = route(match.world, r.position, at => distance(at, d.position) <= sensor.range && lineOfSight(match.world, at, d.position));
    if (!path) fail('ROUTE_BLOCKED');
    const end = path.at(-1) ?? r.position, back = homeRoute(end);
    const phases = [travel(path, cargoMass(r)), { kind: 'survey', duration_ms: sensor.duration_ms, power_w: sensor.power_w }];
    if (!back || jobCost([...phases, travel(back, cargoMass(r))]) > r.energy_mj) fail('ROBOT_ENERGY');
    newJob(p, r, args.action, phases, now, { target_id: d.id, sensor: sensor.id }); return;
  }
  const observed = p.surveys.find(o => o.id === args.observation_id && o.target_id === d.id);
  if (!observed) fail('INSPECTION_REQUIRED');
  if (observed.target_revision !== d.stock.revision) fail('STALE_TARGET');
  if (!observed.candidate_classes.includes(args.material_class)) fail('CLASS_UNSUPPORTED');
  const amount = Math.min(grams(d.stock.remaining), r.payload_g - r.cargo.reduce((n, b) => n + grams(b.contents), 0));
  if (!amount) fail(grams(d.stock.remaining) ? 'CARGO_FULL' : 'DEPOSIT_EMPTY');
  const path = route(match.world, r.position, at => distance(at, d.position) <= 1 && lineOfSight(match.world, at, d.position));
  if (!path) fail('ROUTE_BLOCKED');
  const end = path.at(-1) ?? r.position, back = homeRoute(end);
  if (!back) fail('ROUTE_BLOCKED');
  const phases = [travel(path, cargoMass(r)), { kind: 'collect', duration_ms: Math.ceil(amount * 2 / 5), power_w: 250 }, travel(back, cargoMass(r) + amount), { kind: 'unload', duration_ms: 0, power_w: 0 }];
  if (jobCost(phases) > r.energy_mj) fail('ROBOT_ENERGY');
  const contents = take(d.stock.remaining, amount); d.stock.revision++;
  newJob(p, r, args.action, phases, now, { target_id: d.id, reserved: { id: randomUUID(), contents, form: d.kind === 'cable' ? 'cable' : 'mixed',
    field_collected: true, hazard_truth: ['appliance', 'vehicle'].includes(d.kind) ? 'suspect-battery' : 'none-detected', source_deposit_id: d.id } });
}

function observe(match, p, r, j, now) {
  const d = match.world.deposits.find(d => d.id === j.target_id), s = sensorCatalog.find(s => s.id === j.sensor);
  const range = Math.round(distance(r.position, d.position) * 100) / 100;
  const clear = distance(r.position, d.position) <= s.range && lineOfSight(match.world, r.position, d.position) && !d.surface.occluded;
  const quality = !clear ? 'occluded' : d.surface.signal === 'low' ? 'low-signal' : d.surface.dirty ? 'dirty' : 'clear';
  const cache = `${d.id}/${d.stock.revision}/${s.id}/${r.position.x}/${r.position.y}/${quality}/${fieldVersion}`;
  // Identical observations reuse their original timestamp and uncertainty; no independent draws.
  if (p.surveys.some(o => o.cache === cache)) return;
  const candidates = ['unclassified'], cues = [];
  if (s.id === 'camera-depth') {
    cues.push(clear ? 'Exposed surface and object geometry' : 'Exterior reachable; identifying surfaces occluded');
    if (quality === 'clear') {
      const c = { cable: 'conductor-candidate', packaging: 'polymer-candidate', glass: 'glass-candidate', tire: 'rubber-candidate' }[d.kind];
      if (c) candidates.push(c);
    }
  } else if (s.id === 'magnetic-inductive') {
    if (quality === 'clear' || quality === 'dirty') {
      const contents = d.stock.remaining;
      if ((contents.steel ?? 0) > 0) { candidates.push('ferrous-candidate'); cues.push('Magnetic response'); }
      if (['steel', 'aluminum', 'copper'].some(k => contents[k] > 0)) { candidates.push('conductor-candidate'); cues.push('Conductive response'); }
      if (!cues.length) cues.push('No supported positive response; composition remains unknown');
    } else cues.push('Signal insufficient to classify');
  } else if (s.id === 'nir') {
    if (quality === 'clear' && d.kind === 'packaging') { candidates.push('polymer-candidate'); cues.push('Candidate polymer surface spectrum'); }
    else cues.push('No supported polymer classification under these surface conditions');
  } else cues.push(quality === 'clear' ? 'Surface temperature in ambient game-fixture band; battery health unknown' : 'Thermal surface reading unavailable');
  p.surveys.push({ id: randomUUID(), cache, target_id: d.id, target_revision: d.stock.revision, sensor: s.id, sensor_version: fieldVersion,
    position: { ...r.position }, timestamp_ms: now, range, quality, confidence_bps: quality === 'clear' ? 7500 : quality === 'dirty' ? 4000 : 0,
    candidate_classes: candidates, cues, next_actions: quality === 'clear' ? ['collect-for-bench-inspection'] : ['try-another-sensor', 'collect-unclassified-for-bench-inspection'],
    uncertainty_meaning: 'bounded-game-fixture-not-hardware-accuracy' });
}

/** Resolve zero-duration transitions at a single authoritative instant. */
export function settleRobots(match, now) {
  let changed = false;
  for (const p of match.players) for (const r of p.robots) {
    const j = robotJob(p, r); if (!live(j)) continue;
    for (let n = 0; n < 8; n++) {
      const s = phase(j);
      if (!s) { j.state = 'completed'; j.reason = null; r.job_id = null; changed = true; break; }
      if (s.kind === 'charge') {
        if (r.energy_mj < r.capacity_mj) break;
      } else if (j.phase_work_ms < s.duration_ms) break;
      if (s.kind === 'survey') observe(match, p, r, j, now);
      if (s.kind === 'collect') { if (!j.reserved) throw new Error('ROBOT_RESERVATION_MISSING'); r.cargo.push(j.reserved); j.reserved = null; }
      if (s.kind === 'unload') {
        for (const b of r.cargo) p.batches.push({ ...b, state: 'available', observation_id: null, source_job_id: null, output_role: null, grade: 'recovered-ungraded' });
        r.cargo = [];
      }
      j.phase_index++; j.phase_work_ms = 0; changed = true;
    }
  }
  return changed;
}
export function robotStepLimit(p) {
  let limit = Infinity;
  for (const r of p.robots) {
    const j = robotJob(p, r); if (!live(j)) continue;
    const s = phase(j); if (!s || s.kind === 'charge') continue;
    limit = Math.min(limit, s.kind === 'travel' ? 250 - j.phase_work_ms % 250 : s.duration_ms - j.phase_work_ms);
  }
  return limit;
}
export function chargingRobot(p) {
  return p.robots.find(r => { const j = robotJob(p, r); return live(j) && phase(j)?.kind === 'charge'; });
}
export function advanceRobots(p, dt, chargeRobot, transferred, baseBusy) {
  let changed = false;
  for (const r of p.robots) {
    const j = robotJob(p, r); if (!live(j)) continue;
    const s = phase(j);
    if (s.kind === 'charge') {
      const state = r === chargeRobot && transferred > 0 ? 'running' : 'paused';
      const reason = state === 'running' ? null : baseBusy ? 'base-busy' : 'charging-port';
      if (j.state !== state || j.reason !== reason) changed = true;
      j.state = state; j.reason = reason;
      if (r === chargeRobot) { r.energy_mj += transferred; r.charged_mj += transferred; j.charged_mj += transferred; j.work_ms += dt; }
    } else {
      const energy = dt * s.power_w;
      if (energy > r.energy_mj) throw new Error('ROBOT_ENERGY_INVARIANT');
      r.energy_mj -= energy; r.spent_mj += energy; j.energy_mj += energy; j.work_ms += dt; j.phase_work_ms += dt;
      if (s.kind === 'travel') {
        const i = Math.floor(j.phase_work_ms / 250) - 1;
        if (i >= 0) r.position = { ...s.path[i] };
      }
    }
  }
  return changed;
}
export function robotProjection(p) {
  return { version: robotVersion, sensor_version: fieldVersion, sensor_catalog: sensorCatalog,
    robots: p.robots.map(({ cargo, ...r }) => ({ ...r, cargo: cargo.map(b => ({ id: b.id, mass_g: grams(b.contents), form: b.form, inspection: 'uninspected', destination: 'inspection-bench' })) })),
    jobs: p.robot_jobs.map(j => ({ id: j.id, robot_id: j.robot_id, action: j.action, state: j.state, reason: j.reason, started_at_ms: j.started_at_ms,
      phase: live(j) ? phase(j)?.kind ?? 'complete' : j.state, target_id: j.target_id ?? null, work_ms: j.work_ms, energy_mj: j.energy_mj, charged_mj: j.charged_mj,
      route: live(j) && phase(j)?.kind === 'travel' ? phase(j).path.slice(Math.floor(j.phase_work_ms / 250)) : [] })),
    observations: p.surveys.map(({ cache, ...o }) => o), transferred_mj: p.robot_charge_mj };
}
export function checkRobotInvariants(match, fail) {
  if (match.robot_version !== robotVersion) fail('INVARIANT_FAILED');
  const initial = {}, current = {};
  const valid = contents => {
    if (Object.entries(contents).some(([k, n]) => !keys.includes(k) || !Number.isSafeInteger(n) || n < 0)) fail('INVARIANT_FAILED');
    return contents;
  };
  for (const d of match.world.deposits) { sum(initial, valid(d.stock.initial)); sum(current, valid(d.stock.remaining)); }
  for (const p of match.players) {
    for (const b of p.batches.filter(b => b.state !== 'consumed')) sum(current, valid(contentsOf(b)));
    for (const j of p.robot_jobs) if (j.reserved) { if (!live(j)) fail('INVARIANT_FAILED'); sum(current, valid(j.reserved.contents)); }
    for (const r of p.robots) {
      for (const b of r.cargo) sum(current, valid(b.contents));
      if (r.energy_mj < 0 || r.energy_mj > r.capacity_mj || r.energy_mj + r.spent_mj !== r.initial_mj + r.charged_mj
        || r.cargo.reduce((n, b) => n + grams(b.contents), 0) > r.payload_g) fail('INVARIANT_FAILED');
    }
    if (p.robot_charge_mj !== p.robots.reduce((n, r) => n + r.charged_mj, 0)) fail('INVARIANT_FAILED');
  }
  if (keys.some(k => (initial[k] ?? 0) !== (current[k] ?? 0)) || Object.values(current).some(n => !Number.isSafeInteger(n) || n < 0)) fail('INVARIANT_FAILED');
}
