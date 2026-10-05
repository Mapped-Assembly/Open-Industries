import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { gameFail, validateGameRequest, validateGameResult } from './mcp-game-contract.mjs';

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
  const conductor = Math.floor(copper * 19 / 20), insulation = Math.floor(hdpe * 6 / 7);
  return { duration_ms: (copper + hdpe + dirt) * 2, outputs: [
    { output_role: 'conductor', form: 'wire', copper_g: conductor, hdpe_g: 0, dirt_g: 0 },
    { output_role: 'insulation', form: 'flakes', copper_g: 0, hdpe_g: insulation, dirt_g: 0 },
    { output_role: 'residue', form: 'residue', copper_g: copper - conductor, hdpe_g: hdpe - insulation, dirt_g: dirt },
  ] };
}

function player(owner, slot) {
  const copper = 5000 + randomBytes(1)[0] * 8;
  return { owner, slot,
    deposit: { id: randomUUID(), collected: false, observation: null, copper_g: copper, hdpe_g: 9500 - copper, dirt_g: 500 },
    machine: { id: randomUUID(), kind: 'cable-separator', status: 'ready', power_w: 500, energy_mj: 20000000, dissipated_mj: 0 },
    batches: [], jobs: [],
  };
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
    if (version !== 0 && version !== 1) { this.db.close(); throw new Error('UNSUPPORTED_SQLITE_SCHEMA'); }
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
      PRAGMA user_version=1;
    `);
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
    for (const p of match.players) {
      for (const constituent of ['copper_g', 'hdpe_g', 'dirt_g']) {
        const total = (p.deposit.collected ? 0 : p.deposit[constituent])
          + p.batches.filter(b => b.state !== 'consumed').reduce((sum, b) => sum + b[constituent], 0);
        if (total !== p.deposit[constituent]) gameFail('INVARIANT_FAILED');
      }
      if (p.machine.energy_mj < 0 || p.machine.energy_mj + p.machine.dissipated_mj
        + p.jobs.reduce((sum, j) => sum + j.energy_mj, 0) !== 20000000) gameFail('INVARIANT_FAILED');
    }
    this.db.prepare('UPDATE matches SET status=?,last_tick=?,state=? WHERE id=?').run(match.status, match.last_advanced_ms, JSON.stringify(match), match.id);
  }
  cancel(p, job, reason) {
    if (!live(job)) return;
    const batch = p.batches.find(b => b.id === job.input_batch_id);
    if (!batch || batch.state !== 'reserved') gameFail('INVARIANT_FAILED');
    batch.state = 'available'; job.state = 'cancelled'; job.pause_reason = null; job.cancellation_reason = reason;
  }
  advance(match) {
    const now = Math.max(this.clock(), match.last_advanced_ms);
    if (match.status === 'waiting' && match.invite_expires <= now) {
      match.status = 'abandoned'; match.invite_hash = null; match.revision++;
    }
    let changed = false;
    if (match.status === 'active') for (const p of match.players) for (const job of p.jobs.filter(j => j.state === 'running')) {
      const delta = Math.min(job.duration_ms - job.work_ms, Math.max(0, now - job.last_tick_ms), Math.floor(p.machine.energy_mj / 500));
      job.work_ms += delta; job.energy_mj += delta * 500; p.machine.energy_mj -= delta * 500;
      job.last_tick_ms = Math.max(job.last_tick_ms, now); changed ||= delta > 0;
      if (job.work_ms === job.duration_ms) {
        const input = p.batches.find(b => b.id === job.input_batch_id);
        if (!input || input.state !== 'reserved') gameFail('INVARIANT_FAILED');
        input.state = 'consumed'; job.state = 'completed'; changed = true;
        for (const output of job.outputs) if (output.copper_g + output.hdpe_g + output.dirt_g > 0) {
          if (p.batches.some(b => b.source_job_id === job.id && b.output_role === output.output_role)) gameFail('INVARIANT_FAILED');
          p.batches.push({ id: randomUUID(), state: 'available', ...output, observation_id: null, source_job_id: job.id, grade: 'recovered-ungraded' });
        }
      } else if (p.machine.energy_mj < 500) {
        job.state = 'paused'; job.pause_reason = 'power'; changed = true;
      }
    }
    if (changed) match.revision++;
    match.last_advanced_ms = now;
  }
  snapshot(match, owner) {
    const p = match.players.find(p => p.owner === owner);
    if (!p) gameFail('NOT_AVAILABLE');
    return { match_id: match.id, revision: match.revision, status: match.status,
      server_time_ms: Math.max(this.clock(), match.last_advanced_ms), scheduler_healthy: this.healthy(),
      players: match.players.map(p => ({ slot: p.slot, you: p.owner === owner })),
      deposits: [{ id: p.deposit.id, collected: p.deposit.collected, observation: p.deposit.observation
        ? { id: p.deposit.observation, sensor: 'cable-assay-v1', ...mass(p.deposit) } : null }],
      machines: [p.machine], batches: p.batches,
      jobs: p.jobs.map(({ last_tick_ms, outputs, ...visible }) => visible),
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
      if (operation !== 'read_match') {
        const receipt = this.db.prepare('SELECT * FROM receipts WHERE owner=? AND command_id=?').get(owner, args.command_id);
        if (receipt) { if (receipt.request !== request) gameFail('COMMAND_ID_REUSED'); return JSON.parse(receipt.result); }
      }
      let match, invite;
      if (operation === 'create_match') {
        this.quota(owner, true);
        if (!this.healthy()) gameFail('SCHEDULER_UNAVAILABLE');
        invite = randomUUID();
        match = { id: randomUUID(), revision: 1, status: 'waiting', invite_hash: hash(invite), invite_expires: this.clock() + 3600000,
          last_advanced_ms: this.clock(), players: [player(owner, 1)] };
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
        this.advance(match);
        if (operation !== 'read_match') {
          const action = operation === 'command' ? args.action : operation;
          if (action !== 'join_match' && action !== 'abandon_match' && match.status !== 'active') gameFail('MATCH_INACTIVE');
          if (action === 'abandon_match' && match.status === 'abandoned') gameFail('MATCH_INACTIVE');
          if (action !== 'abandon_match' && this.db.prepare('SELECT count(*) n FROM receipts WHERE owner=? AND match_id=?').get(owner, match.id).n >= 256) gameFail('LIMIT_REACHED');
          if (!['pause_job', 'cancel_job', 'dismantle_machine', 'abandon_match'].includes(action) && !this.healthy()) gameFail('SCHEDULER_UNAVAILABLE');
          if (action === 'join_match') {
            match.players.push(player(owner, 2)); match.status = 'active'; match.invite_hash = null;
            this.db.prepare('INSERT INTO members VALUES(?,?,2)').run(match.id, owner);
          } else this.command(match, own, args);
          match.revision++;
        }
      }
      this.save(match);
      const result = { version: 2, balance_version: 'dump-v1', snapshot: this.snapshot(match, owner),
        ...(operation !== 'read_match' ? { command_id: args.command_id } : {}), ...(invite ? { invite_code: invite } : {}) };
      validateGameResult(name, result);
      if (operation !== 'read_match') this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(owner, args.command_id, match.id, request, JSON.stringify(result));
      return result;
    });
  }
  command(match, p, args) {
    const { action } = args;
    if (action === 'inspect_deposit' || action === 'collect_deposit') {
      if (p.deposit.id !== args.deposit_id) gameFail('NOT_AVAILABLE');
      if (p.deposit.collected) gameFail('DEPOSIT_EMPTY');
      if (action === 'inspect_deposit') p.deposit.observation ||= randomUUID();
      else {
        if (!p.deposit.observation) gameFail('INSPECTION_REQUIRED');
        p.deposit.collected = true;
        p.batches.push({ id: randomUUID(), form: 'cable', state: 'available', ...mass(p.deposit), observation_id: p.deposit.observation,
          source_job_id: null, output_role: null, grade: 'assayed-feedstock' });
      }
    } else if (action === 'start_processing') {
      const batch = p.batches.find(b => b.id === args.batch_id);
      if (!batch || p.machine.id !== args.machine_id) gameFail('NOT_AVAILABLE');
      if (batch.state !== 'available' || batch.form !== 'cable' || p.machine.status !== 'ready' || p.machine.energy_mj < 500 || p.jobs.some(live)) gameFail('NOT_READY');
      if (batch.observation_id !== p.deposit.observation || !p.deposit.collected || canonical(mass(batch)) !== canonical(mass(p.deposit))) gameFail('INSPECTION_REQUIRED');
      const plan = cablePlan(batch); batch.state = 'reserved';
      p.jobs.push({ id: randomUUID(), machine_id: p.machine.id, input_batch_id: batch.id, recipe: 'strip-cable', recipe_version: 'dump-v1',
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
      p.machine.status = 'destroyed'; p.machine.dissipated_mj += p.machine.energy_mj; p.machine.energy_mj = 0;
    } else if (action === 'abandon_match') {
      for (const player of match.players) for (const job of player.jobs) this.cancel(player, job, 'match_abandoned');
      match.status = 'abandoned'; match.invite_hash = null;
    } else gameFail('INVALID_REQUEST');
  }
  close() { this.db.close(); }
}
