import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gameFail, validateGameRequest, validateGameResult } from './mcp-game-contract.mjs';
import { makeWorld, provisionPlayer, starterBase, worldProjection } from './game-world.mjs';

import { initializeScience, materialBatch, scienceProjection, processPlan, processOutputs, inspectAtBench, evaluateScience, catalog, scienceVersions } from './game-materials.mjs';
import { planProcess } from '@openindustries/material-science/engine';
import { initializeRobots, contentsOf, grams, commandRobot, stopRobot, settleRobots, robotStepLimit, chargingRobot, advanceRobots, robotProjection, checkRobotInvariants, robotsBusy } from './game-robots.mjs';

const derive = promisify(scrypt);
const hash = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value, function (_key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
});
const live = job => job.state === 'running' || job.state === 'paused';
const mass = value => ({ copper_g: value.copper_g, hdpe_g: value.hdpe_g, dirt_g: value.dirt_g });

export function cablePlan(input) {
  const { copper_g: copper, hdpe_g: hdpe, dirt_g: dirt } = input;
  if (![copper, hdpe, dirt].every(n => Number.isInteger(n) && n >= 0)
    || copper + hdpe + dirt < 1 || copper + hdpe + dirt > 10000 || copper * 2 < copper + hdpe + dirt) gameFail('INVALID_FEEDSTOCK');
  const plan = planProcess(materialBatch({ id: 'cable-fixture', form: 'cable', ...input }, true), 'strip-cable',
    { kind: 'cable-separator', enabled: true, availablePowerW: 500, availableEnergyJ: 10000, maximumTemperatureC: null });
  if (plan.status !== 'eligible') gameFail('INVALID_FEEDSTOCK');
  return { duration_ms: plan.durationMs, outputs: processOutputs(plan) };
}

/** No external IO inside transactions. SQLite serializes writers across processes. */
export class GameDatabase {
  constructor(path, { clock = Date.now } = {}) {
    this.clock = clock;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1, 2, 3, 4].includes(version)) { this.db.close(); throw new Error('UNSUPPORTED_SQLITE_SCHEMA'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner);
      CREATE TABLE IF NOT EXISTS matches(id TEXT PRIMARY KEY, host TEXT NOT NULL REFERENCES accounts(id), status TEXT NOT NULL, created INTEGER NOT NULL, last_tick INTEGER NOT NULL, state TEXT NOT NULL CHECK(json_valid(state)));
      CREATE INDEX IF NOT EXISTS matches_due ON matches(status,last_tick);
      CREATE TABLE IF NOT EXISTS members(match_id TEXT NOT NULL REFERENCES matches(id), owner TEXT NOT NULL REFERENCES accounts(id), slot INTEGER NOT NULL CHECK(slot IN(1,2)), PRIMARY KEY(match_id,owner), UNIQUE(match_id,slot));
      CREATE INDEX IF NOT EXISTS members_owner ON members(owner);
      CREATE TABLE IF NOT EXISTS receipts(owner TEXT NOT NULL REFERENCES accounts(id), command_id TEXT NOT NULL, match_id TEXT NOT NULL REFERENCES matches(id), request TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(owner,command_id));
      CREATE INDEX IF NOT EXISTS receipts_match ON receipts(match_id,owner);
      CREATE TABLE IF NOT EXISTS runtime(id INTEGER PRIMARY KEY CHECK(id=1), heartbeat INTEGER);
      INSERT OR IGNORE INTO runtime VALUES(1,NULL);

    `);
    // One transaction upgrades persisted v2 matches without rerolling their cable,
    // resetting energy/work or deleting immutable receipts. New grants are ledgered.
    if (version < 2) this.transaction(() => {
      for (const row of this.db.prepare('SELECT state FROM matches').all()) {
        const match = JSON.parse(row.state);
        match.world = makeWorld(match.players);
        match.completion = match.status === 'abandoned' ? { reason: 'abandoned', winner_slot: null } : null;
        if (match.completion) match.status = 'completed';
        for (const p of match.players) {
          p.base = starterBase(p.slot, p.machine.id, match.world.towers.find(t => t.slot === p.slot).id);
          p.base.assets.find(a => a.id === p.machine.id).status = p.machine.status;
          p.base.power.solar_w = 0;
        }
        // Settle pre-upgrade elapsed work under the original no-solar rules.
        this.advance(match);
        for (const p of match.players) p.base.power.solar_w = 100;
        match.revision++;
        this.save(match);
      }
      this.db.exec('PRAGMA user_version=2');
    });
    if (version < 3) this.transaction(() => {
      for (const row of this.db.prepare('SELECT state FROM matches').all()) {
        const match = JSON.parse(row.state); initializeScience(match); match.revision++; this.save(match);
      }
      this.db.exec('PRAGMA user_version=3');
    });
    if (version < 4) this.transaction(() => {
      for (const row of this.db.prepare('SELECT state FROM matches').all()) {
        const match = JSON.parse(row.state);
        this.advance(match); initializeRobots(match, true); match.revision++; this.save(match);
      }
      this.db.exec('PRAGMA user_version=4');
    });
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async authenticate(credentials, register = false) {
    if (!credentials || Object.keys(credentials).sort().join(',') !== 'password,username'
      || typeof credentials.username !== 'string' || !/^[a-zA-Z0-9_-]{3,40}$/.test(credentials.username)
      || typeof credentials.password !== 'string' || credentials.password.length < 12 || credentials.password.length > 256) gameFail('AUTH_REQUIRED');
    const username = credentials.username.toLowerCase();
    const account = this.db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    const salt = register || !account ? randomBytes(16).toString('hex') : account.salt;
    const password = await derive(credentials.password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return this.transaction(() => {
      let owner = account?.id;
      if (register) {
        if (this.db.prepare('SELECT 1 FROM accounts WHERE username=?').get(username)
          || this.db.prepare('SELECT count(*) n FROM accounts').get().n >= 1000) gameFail('AUTH_REQUIRED');
        owner = randomUUID();
        this.db.prepare('INSERT INTO accounts VALUES(?,?,?,?)').run(owner, username, salt, password.toString('hex'));
      } else if (!account || !timingSafeEqual(password, Buffer.from(account.password_hash, 'hex'))) gameFail('AUTH_REQUIRED');
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.clock());
      if (this.db.prepare('SELECT count(*) n FROM sessions WHERE owner=?').get(owner).n >= 16) gameFail('LIMIT_REACHED');
      const token = randomBytes(32).toString('hex'), expires = this.clock() + 8 * 60 * 60 * 1000;
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), owner, expires);
      return { token, expires_at_ms: expires };
    });
  }
  identity(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) gameFail('AUTH_REQUIRED');
    const session = this.db.prepare('SELECT owner FROM sessions WHERE token_hash=? AND expires>?').get(hash(token), this.clock());
    if (!session) gameFail('AUTH_REQUIRED');
    return session.owner;
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token || '')); }
  healthy() {
    const heartbeat = this.db.prepare('SELECT heartbeat FROM runtime WHERE id=1').get().heartbeat;
    return heartbeat !== null && Math.abs(this.clock() - heartbeat) <= 15000;
  }
  load(id) {
    const row = this.db.prepare('SELECT state FROM matches WHERE id=?').get(id);
    if (!row) gameFail('NOT_AVAILABLE');
    return JSON.parse(row.state);
  }
  save(match) {
    initializeScience(match);
    if (canonical(match.science) !== canonical(scienceVersions)) gameFail('INVARIANT_FAILED');
    if (match.robot_version) checkRobotInvariants(match, gameFail);
    for (const p of match.players) {
      if (!match.robot_version) for (const constituent of ['copper_g', 'hdpe_g', 'dirt_g']) {
        const total = (p.deposit.collected ? 0 : p.deposit[constituent])
          + p.batches.filter(b => b.state !== 'consumed').reduce((sum, b) => sum + b[constituent], 0);
        if (total !== p.deposit[constituent]) gameFail('INVARIANT_FAILED');
      }
      if (p.machine.energy_mj < 0 || p.machine.energy_mj > p.base.power.capacity_mj || p.machine.energy_mj + p.machine.dissipated_mj
        + p.base.power.spilled_mj + (p.robot_charge_mj ?? 0) + p.jobs.reduce((sum, j) => sum + j.energy_mj, 0) !== p.base.power.initial_mj + p.base.power.generated_mj) gameFail('INVARIANT_FAILED');
      if (canonical(p.components.map(c => ({ kind: c.kind, quantity: c.quantity, unit_mass_g: c.unitMassG }))) !== canonical(p.base.inventory)
        || p.components.some(c => c.owner !== p.owner || c.allocation !== 'component-only')) gameFail('INVARIANT_FAILED');
      for (const b of p.batches) if (b.material.massG !== grams(contentsOf(b))
        || canonical(b.material.constituents) !== canonical(materialBatch(b).constituents)) gameFail('INVARIANT_FAILED');
      const allocations = [...p.base.assets.flatMap(a => a.components.map(c => ({ ...c, allocation_id: a.id }))), ...p.base.inventory.map(c => ({ ...c, allocation_id: 'store' }))];
      if (canonical(allocations) !== canonical(p.base.starter_ledger) || p.base.assets.filter(a => a.kind === 'tower').length !== 1
        || p.base.assets.filter(a => a.kind === 'robot').length !== 2) gameFail('INVARIANT_FAILED');
    }
    this.db.prepare('UPDATE matches SET status=?,last_tick=?,state=? WHERE id=?').run(match.status, match.last_advanced_ms, JSON.stringify(match), match.id);
  }
  cancel(p, job, reason) {
    if (!live(job)) return;
    if (job.kind === 'component-inspection') { job.state = 'cancelled'; job.pause_reason = null; job.cancellation_reason = reason; return; }
    const batch = p.batches.find(b => b.id === job.input_batch_id);
    if (!batch || batch.state !== 'reserved') gameFail('INVARIANT_FAILED');
    batch.state = 'available'; job.state = 'cancelled'; job.pause_reason = null; job.cancellation_reason = reason;
  }
  complete(match, reason) {
    match.status = 'completed'; match.completion = { reason, winner_slot: null }; match.invite_hash = null;
  }
  advance(match) {
    if (match.robot_version) return this.advanceWithRobots(match);
    const now = Math.max(this.clock(), match.last_advanced_ms);
    if (match.status === 'waiting' && match.invite_expires <= now) {
      this.complete(match, 'invite-expired'); match.revision++;
    }
    let changed = false;
    if (match.status === 'active') for (const p of match.players) {
      const elapsed = now - match.last_advanced_ms;
      const solar = p.machine.status === 'ready' ? p.base.power.solar_w : 0;
      const generated = elapsed * solar;
      let spent = 0;
      for (const job of p.jobs.filter(j => j.state === 'running')) {
        const requested = Math.min(job.duration_ms - job.work_ms, Math.max(0, now - job.last_tick_ms));
        const delta = Math.min(requested, (job.power_w ?? 500) <= solar ? requested : Math.floor(p.machine.energy_mj / ((job.power_w ?? 500) - solar)));
        const completedAt = job.last_tick_ms + delta;
        job.work_ms += delta; job.energy_mj += delta * (job.power_w ?? 500); spent += delta * (job.power_w ?? 500);
        job.last_tick_ms = Math.max(job.last_tick_ms, now);
        if (job.work_ms === job.duration_ms) {
          if (job.kind?.endsWith('inspection')) {
            inspectAtBench(match, p, job, completedAt); job.state = 'completed'; changed = true; continue;
          }
          const input = p.batches.find(b => b.id === job.input_batch_id);
          if (!input || input.state !== 'reserved') gameFail('INVARIANT_FAILED');
          input.state = 'consumed'; job.state = 'completed'; changed = true;
          for (const output of job.outputs) if (output.copper_g + output.hdpe_g + output.dirt_g > 0) {
            if (p.batches.some(b => b.source_job_id === job.id && b.output_role === output.output_role)) gameFail('INVARIANT_FAILED');
            p.batches.push({ id: randomUUID(), state: 'available', ...output, observation_id: null, source_job_id: job.id, grade: 'recovered-ungraded' });
          }
        } else if (delta < requested) {
          job.state = 'paused'; job.pause_reason = 'power'; changed = true;
        }
      }
      const energy = p.machine.energy_mj + generated - spent;
      p.base.power.generated_mj += generated;
      p.base.power.spilled_mj += Math.max(0, energy - p.base.power.capacity_mj);
      p.machine.energy_mj = Math.min(p.base.power.capacity_mj, energy);
    }
    if (changed) match.revision++;
    match.last_advanced_ms = now;
  }
  finishProcess(match, p, job, now) {
    if (job.kind?.endsWith('inspection')) inspectAtBench(match, p, job, now);
    else {
      const input = p.batches.find(b => b.id === job.input_batch_id);
      if (!input || input.state !== 'reserved') gameFail('INVARIANT_FAILED');
      input.state = 'consumed';
      for (const output of job.outputs) if (grams(contentsOf(output))) {
        if (p.batches.some(b => b.source_job_id === job.id && b.output_role === output.output_role)) gameFail('INVARIANT_FAILED');
        p.batches.push({ id: randomUUID(), state: 'available', ...output, observation_id: null, source_job_id: job.id, grade: 'recovered-ungraded' });
      }
    }
    job.state = 'completed'; job.pause_reason = null;
  }
  advanceWithRobots(match) {
    const now = Math.max(this.clock(), match.last_advanced_ms);
    if (match.status === 'waiting' && match.invite_expires <= now) { this.complete(match, 'invite-expired'); match.revision++; }
    let at = match.last_advanced_ms, changed = false;
    if (match.status === 'active') {
      changed = settleRobots(match, at) || changed;
      // Event boundaries make catch-up equivalent to frequent ticks, even with concurrent charging.
      while (at < now) {
        let dt = now - at;
        const plans = match.players.map(p => {
          const solar = p.machine.status === 'ready' ? p.base.power.solar_w : 0;
          let job = p.jobs.find(j => j.state === 'running');
          if (job && job.work_ms === job.duration_ms) { this.finishProcess(match, p, job, at); changed = true; job = undefined; }
          const power = job?.power_w ?? (job ? 500 : 0);
          if (job && power > solar && p.machine.energy_mj < power - solar) { job.state = 'paused'; job.pause_reason = 'power'; changed = true; job = undefined; }
          const robot = !job && p.machine.status === 'ready' ? chargingRobot(p) : undefined;
          const chargeRate = robot ? (p.machine.energy_mj >= 500 - solar ? 500 : solar) : 0;
          let limit = robotStepLimit(p);
          if (job) limit = Math.min(limit, job.duration_ms - job.work_ms, power > solar ? Math.floor(p.machine.energy_mj / (power - solar)) : Infinity);
          if (robot && chargeRate) limit = Math.min(limit, Math.ceil((robot.capacity_mj - robot.energy_mj) / chargeRate), chargeRate > solar ? Math.floor(p.machine.energy_mj / (chargeRate - solar)) : Infinity);
          dt = Math.min(dt, limit);
          return { p, solar, job, robot, chargeRate };
        });
        if (!Number.isSafeInteger(dt) || dt <= 0) gameFail('INVARIANT_FAILED');
        for (const { p, solar, job, robot, chargeRate } of plans) {
          const generated = dt * solar;
          const used = job ? dt * (job.power_w ?? 500) : 0;
          const transferred = robot ? Math.min(robot.capacity_mj - robot.energy_mj, dt * chargeRate) : 0;
          if (job) { job.work_ms += dt; job.energy_mj += used; job.last_tick_ms = at + dt; }
          const energy = p.machine.energy_mj + generated - used - transferred;
          p.base.power.generated_mj += generated; p.base.power.spilled_mj += Math.max(0, energy - p.base.power.capacity_mj);
          p.machine.energy_mj = Math.min(p.base.power.capacity_mj, energy); p.robot_charge_mj += transferred;
          changed = advanceRobots(p, dt, robot, transferred, !!job || p.machine.status !== 'ready') || changed;
          if (job && job.work_ms === job.duration_ms) { this.finishProcess(match, p, job, at + dt); changed = true; }
        }
        at += dt; changed = settleRobots(match, at) || changed;
      }
    }
    if (changed) match.revision++;
    match.last_advanced_ms = now;
  }
  snapshot(match, owner) {
    const p = match.players.find(p => p.owner === owner);
    if (!p) gameFail('NOT_AVAILABLE');
    return { match_id: match.id, revision: match.revision, status: match.status, completion: match.completion,
      world: worldProjection(match), base: p.base, science: scienceProjection(match, p), field: robotProjection(p), legacy_recovery: match.legacy_recovery, invite_expires_at_ms: match.status === 'waiting' && p.slot === 1 ? match.invite_expires : null,
      server_time_ms: Math.max(this.clock(), match.last_advanced_ms), scheduler_healthy: this.healthy(),
      players: match.players.map(p => ({ slot: p.slot, you: p.owner === owner })),
      deposits: [{ id: p.deposit.id, collected: p.deposit.collected, observation: p.deposit.observation
        ? { id: p.deposit.observation, sensor: 'cable-assay-v1', ...mass(p.deposit) } : null }],
      machines: [p.machine], batches: p.batches.map(b => ({ id: b.id, form: b.form, state: b.state, mass_g: grams(contentsOf(b)),
        ...Object.fromEntries(['copper', 'hdpe', 'dirt'].map(k => [`${k}_g`, b.field_collected && b.material.inspection !== 'graded' ? null : contentsOf(b)[k] ?? 0])),
        observation_id: b.observation_id, source_job_id: b.source_job_id, output_role: b.output_role, grade: b.grade })),
      jobs: p.jobs.map(({ last_tick_ms, outputs, kind, power_w, ...visible }) => visible),
    };
  }
  tick() {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT state FROM matches WHERE status IN ('active','waiting') ORDER BY last_tick,id LIMIT 100").all();
      for (const row of rows) { const match = JSON.parse(row.state); this.advance(match); this.save(match); }
      this.db.prepare('UPDATE runtime SET heartbeat=? WHERE id=1').run(this.clock());
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.clock());
    });
  }
  quota(owner, creating) {
    const rows = this.db.prepare('SELECT m.state FROM matches m JOIN members p ON p.match_id=m.id WHERE p.owner=?').all(owner);
    const open = rows.map(row => JSON.parse(row.state)).filter(m => m.status === 'active' || (m.status === 'waiting' && m.invite_expires > this.clock()));
    if (open.length >= 3 || (creating && this.db.prepare('SELECT count(*) n FROM matches WHERE host=? AND created>?').get(owner, this.clock() - 86400000).n >= 20)) gameFail('LIMIT_REACHED');
  }
  dispatch(token, name, raw) {
    const args = validateGameRequest(name, raw);
    if (name === 'astra.game_describe') gameFail('INVALID_REQUEST');
    return this.transaction(() => {
      const owner = this.identity(token), operation = name.replace('astra.game_', '');
      const request = canonical({ name, arguments: args });
      const readOnly = ['read_match', 'science_catalog', 'evaluate'].includes(operation);
      if (operation === 'list_matches') {
        const rows = this.db.prepare('SELECT m.state,m.created,p.slot FROM matches m JOIN members p ON p.match_id=m.id WHERE p.owner=? AND (? IS NULL OR m.id>?) ORDER BY m.id LIMIT 21').all(owner, args.cursor, args.cursor);
        const matches = rows.slice(0, 20).map(row => { const m = JSON.parse(row.state); this.advance(m); this.save(m); return { match_id: m.id, status: m.status, slot: row.slot, created_at_ms: row.created }; });
        return validateGameResult(name, { version: 5, matches, next_cursor: rows.length > 20 ? matches.at(-1).match_id : null });
      }
      if (!readOnly) {
        const receipt = this.db.prepare('SELECT * FROM receipts WHERE owner=? AND command_id=?').get(owner, args.command_id);
        if (receipt) { if (receipt.request !== request) gameFail('COMMAND_ID_REUSED'); return JSON.parse(receipt.result); }
      }
      let match, invite;
      if (operation === 'create_match') {
        this.quota(owner, true);
        if (!this.healthy()) gameFail('SCHEDULER_UNAVAILABLE');
        invite = randomUUID();
        match = { id: randomUUID(), revision: 1, status: 'waiting', invite_hash: hash(invite), invite_expires: this.clock() + 3600000,
          last_advanced_ms: this.clock(), completion: null, world: makeWorld(), players: [] };
        match.players.push(provisionPlayer(owner, 1, match.world)); initializeRobots(match); initializeScience(match);
        this.db.prepare('INSERT INTO matches VALUES(?,?,?,?,?,?)').run(match.id, owner, match.status, this.clock(), match.last_advanced_ms, JSON.stringify(match));
        this.db.prepare('INSERT INTO members VALUES(?,?,1)').run(match.id, owner);
      } else {
        match = this.load(args.match_id);
        const own = match.players.find(p => p.owner === owner);
        if (operation === 'join_match') {
          if (match.status !== 'waiting' || own || match.invite_hash !== hash(args.invite_code) || match.invite_expires <= this.clock()) gameFail('NOT_AVAILABLE');
          this.quota(owner, false);
        } else {
          if (!own) gameFail('NOT_AVAILABLE');
          if (operation === 'command' && match.revision !== args.expected_revision) gameFail('CONFLICT');
        }
        this.advance(match); initializeScience(match);
        if (operation === 'science_catalog' || operation === 'evaluate') {
          if (canonical(match.science) !== canonical(scienceVersions)) gameFail('INVARIANT_FAILED');
          const result = operation === 'science_catalog' ? { version: 5, catalog: catalog() } : { version: 5, match_id: match.id, revision: match.revision, result: evaluateScience(own, args, gameFail) };
          this.save(match); return validateGameResult(name, result);
        }
        if (!readOnly) {
          const action = operation === 'command' ? args.action : operation;
          if (!['join_match', 'abandon_match', 'rotate_invite'].includes(action) && match.status !== 'active') gameFail('MATCH_INACTIVE');
          if (action === 'abandon_match' && match.status === 'completed') gameFail('MATCH_INACTIVE');
          if (action !== 'abandon_match' && this.db.prepare('SELECT count(*) n FROM receipts WHERE owner=? AND match_id=?').get(owner, match.id).n >= 256) gameFail('LIMIT_REACHED');
          if (!['pause_job', 'cancel_job', 'interrupt_robot', 'retreat_robot', 'dismantle_machine', 'abandon_match'].includes(action) && !this.healthy()) gameFail('SCHEDULER_UNAVAILABLE');
          if (action === 'join_match') {
            match.players.push(provisionPlayer(owner, 2, match.world)); initializeRobots(match); match.status = 'active'; match.invite_hash = null;
            this.db.prepare('INSERT INTO members VALUES(?,?,2)').run(match.id, owner);
          } else if (action === 'rotate_invite') {
            if (own.slot !== 1 || match.status !== 'waiting') gameFail('NOT_AVAILABLE');
            invite = randomUUID(); match.invite_hash = hash(invite); match.invite_expires = this.clock() + 3600000;
          } else this.command(match, own, args);
          match.revision++;
        }
      }
      this.save(match);
      const result = { version: 5, balance_version: 'dump-world-v1', snapshot: this.snapshot(match, owner),
        ...(!readOnly ? { command_id: args.command_id } : {}), ...(operation === 'command' || invite ? { invite_code: invite ?? null } : {}) };
      validateGameResult(name, result);
      if (!readOnly) this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(owner, args.command_id, match.id, request, JSON.stringify(result));
      return result;
    });
  }
  command(match, p, args) {
    const { action } = args;
    if (action === 'inspect_deposit' || action === 'collect_deposit') {
      if (p.deposit.id !== args.deposit_id) gameFail('NOT_AVAILABLE');
      if (!match.legacy_recovery) gameFail('ROBOT_REQUIRED');
      if (p.deposit.collected) gameFail('DEPOSIT_EMPTY');
      if (action === 'inspect_deposit') p.deposit.observation ||= randomUUID();
      else {
        if (!p.deposit.observation) gameFail('INSPECTION_REQUIRED');
        p.deposit.collected = true;
        const d = match.world.deposits.find(d => d.id === p.deposit.id); d.stock.remaining = {}; d.stock.revision++;
        p.batches.push({ id: randomUUID(), form: 'cable', state: 'available', ...mass(p.deposit), observation_id: p.deposit.observation,
          source_job_id: null, output_role: null, grade: 'assayed-feedstock' });
      }
    } else if (['survey_robot', 'collect_robot', 'return_robot', 'recharge_robot', 'interrupt_robot', 'retreat_robot'].includes(action)) {
      commandRobot(match, p, args, Math.max(this.clock(), match.last_advanced_ms), gameFail);
      settleRobots(match, Math.max(this.clock(), match.last_advanced_ms));
    } else if (action === 'inspect_batch' || action === 'inspect_component') {
      const component = action === 'inspect_component';
      const target = (component ? p.components : p.batches).find(b => b.id === (component ? args.component_id : args.batch_id));
      if (!target) gameFail('NOT_AVAILABLE');
      const bench = p.base.assets.find(a => a.kind === 'bench');
      if ((!component && target.state !== 'available') || bench.status !== 'ready' || p.machine.status !== 'ready' || p.machine.energy_mj < 300000 || p.jobs.some(live)) gameFail('NOT_READY');
      p.base.ready_to_finish = false;
      if (!component) target.state = 'reserved';
      p.jobs.push({ id: randomUUID(), machine_id: bench.id, input_batch_id: target.id, recipe: component ? 'inspect-component' : 'inspect-batch', recipe_version: 'bench-v1',
        kind: component ? 'component-inspection' : 'batch-inspection', power_w: 100, state: 'running', pause_reason: null, cancellation_reason: null, duration_ms: 3000, work_ms: 0, energy_mj: 0,
        last_tick_ms: Math.max(this.clock(), match.last_advanced_ms), outputs: [] });
    } else if (action === 'start_processing' || action === 'start_material_process') {
      const batch = p.batches.find(b => b.id === args.batch_id);
      if (!batch || p.machine.id !== args.machine_id) gameFail('NOT_AVAILABLE');
      if (batch.state !== 'available' || p.machine.status !== 'ready' || p.machine.energy_mj < 500 || p.jobs.some(live)) gameFail('NOT_READY');
      const recipe = action === 'start_processing' ? 'strip-cable' : args.recipe_id;
      const evaluated = processPlan(p, batch, recipe);
      if (evaluated.status === 'needs-inspection') gameFail('INSPECTION_REQUIRED');
      if (evaluated.status !== 'eligible') gameFail('INVALID_FEEDSTOCK');
      const plan = { duration_ms: evaluated.durationMs, outputs: processOutputs(evaluated) }; batch.state = 'reserved'; p.base.ready_to_finish = false;
      p.jobs.push({ id: randomUUID(), machine_id: p.machine.id, input_batch_id: batch.id, recipe, recipe_version: match.science.recipes,
        state: 'running', pause_reason: null, cancellation_reason: null, duration_ms: plan.duration_ms, work_ms: 0, energy_mj: 0,
        last_tick_ms: Math.max(this.clock(), match.last_advanced_ms), outputs: plan.outputs });
    } else if (['pause_job', 'resume_job', 'cancel_job'].includes(action)) {
      const job = p.jobs.find(j => j.id === args.job_id);
      if (!job) gameFail('NOT_AVAILABLE');
      if (!live(job)) gameFail('NOT_READY');
      if (action === 'cancel_job') this.cancel(p, job, 'requested');
      else if (action === 'pause_job') { job.state = 'paused'; job.pause_reason = 'requested'; }
      else {
        if (job.state !== 'paused' || p.machine.status !== 'ready' || p.machine.energy_mj < 500) gameFail('NOT_READY');
        job.state = 'running'; job.pause_reason = null; job.last_tick_ms = Math.max(this.clock(), match.last_advanced_ms);
      }
    } else if (action === 'dismantle_machine') {
      if (p.machine.id !== args.machine_id) gameFail('NOT_AVAILABLE');
      if (p.machine.status !== 'ready') gameFail('NOT_READY');
      for (const job of p.jobs) this.cancel(p, job, 'machine_destroyed');
      p.machine.status = 'destroyed'; p.base.assets.find(a => a.id === p.machine.id).status = 'destroyed'; p.machine.dissipated_mj += p.machine.energy_mj; p.machine.energy_mj = 0;
    } else if (action === 'abandon_match') {
      for (const player of match.players) {
        for (const job of player.jobs) this.cancel(player, job, 'match_abandoned');
        for (const r of player.robots) stopRobot(match, player, r, 'match-abandoned');
      }
      this.complete(match, 'abandoned');
    } else if (action === 'finish_recovery') {
      if (!p.jobs.some(j => j.state === 'completed' && !j.kind?.endsWith('inspection')) || p.jobs.some(live) || robotsBusy(p) || p.robots.some(r => r.cargo.length)) gameFail('NOT_READY');
      p.base.ready_to_finish = true;
      if (match.players.every(player => player.base.ready_to_finish && !player.jobs.some(live) && !robotsBusy(player) && !player.robots.some(r => r.cargo.length))) this.complete(match, 'recovery-complete');
    } else gameFail('INVALID_REQUEST');
  }
  close() { this.db.close(); }
}
