import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GameDatabase, canonical } from '../server/game-sqlite.mjs';

const root = await mkdtemp(join(tmpdir(), 'oi-world-'));
let time = 1000000;
const path = join(root, 'world.sqlite');
let db = new GameDatabase(path, { clock: () => time });
const cmd = () => ({ version: 3, command_id: randomUUID() });
const call = (token: string, name: string, args: object) => db.dispatch(token, `astra.game_${name}`, args);
try {
  const accounts = await Promise.all(['north', 'south', 'outsider'].map(username => db.authenticate({ username, password: 'world-test-password' }, true)));
  const [a, b, c] = accounts.map(x => x.token);
  db.tick();
  const created = call(a, 'create_match', cmd());
  const id = created.snapshot.match_id;
  const read = (token = a) => call(token, 'read_match', { version: 3, match_id: id }).snapshot;
  const action = (token: string, action: string, fields = {}) => call(token, 'command', { ...cmd(), match_id: id, expected_revision: read(token).revision, action, ...fields });
  const rotated = action(a, 'rotate_invite');
  assert.notEqual(rotated.invite_code, created.invite_code);
  assert.throws(() => call(b, 'join_match', { ...cmd(), match_id: id, invite_code: created.invite_code }), { code: 'NOT_AVAILABLE' });
  const joined = call(b, 'join_match', { ...cmd(), match_id: id, invite_code: rotated.invite_code });
  assert.equal(joined.snapshot.status, 'active');
  assert.equal(call(c, 'list_matches', { version: 3, cursor: null }).matches.length, 0);
  assert.equal(call(b, 'list_matches', { version: 3, cursor: null }).matches[0].match_id, id);
  assert.throws(() => action(b, 'rotate_invite'), { code: 'NOT_AVAILABLE' });
  const w = read().world;
  assert.equal(w.deposits.length, 14);
  assert.equal(new Set(w.deposits.map((d: any) => d.kind)).size, 7);
  for (const d of w.deposits.filter((d: any) => d.home_slot === 1)) {
    const mirror = w.deposits.find((v: any) => v.home_slot === 2 && v.kind === d.kind);
    assert.equal(d.position.x + mirror.position.x, 96);
    assert.equal(d.position.y, mirror.position.y);
  }
  assert.equal(w.outposts.length, 2);
  assert.equal(w.roads.length, 2); assert.equal(w.obstacles.length, 4);
  for (const token of [a, b]) {
    const s = read(token), base = s.base;
    assert.equal(base.assets.filter((v: any) => v.kind === 'robot').length, 2);
    assert.equal(base.assets.filter((v: any) => v.kind === 'tower').length, 1);
    const ledger = [...base.assets.flatMap((asset: any) => asset.components.map((part: any) => ({ ...part, allocation_id: asset.id }))), ...base.inventory.map((part: any) => ({ ...part, allocation_id: 'store' }))];
    assert.equal(canonical(ledger), canonical(base.starter_ledger));
    assert(s.machines[0].energy_mj >= 10000000);
    assert.throws(() => action(token, 'finish_recovery'), { code: 'NOT_READY' });
    const d = s.deposits[0].id;
    action(token, 'inspect_deposit', { deposit_id: d });
    const collected = action(token, 'collect_deposit', { deposit_id: d }).snapshot;
    action(token, 'start_processing', { batch_id: collected.batches[0].id, machine_id: s.machines[0].id });
  }
  assert(!JSON.stringify(read(a)).includes(read(b).deposits[0].observation.id));
  const secret = db.load(id).world;
  const publicData = JSON.stringify([read(a), read(b)]);
  assert(!publicData.includes(secret.seed));
  for (const d of secret.deposits.filter((d: any) => d.kind !== 'cable')) assert(!publicData.includes(d.truth.components[0].id));
  time += 5000; db.tick();
  const checkpoint = read();
  db.close(); db = new GameDatabase(path, { clock: () => time });
  time += 15000; db.tick();
  for (const token of [a, b]) {
    const s = read(token);
    assert.equal(s.jobs[0].state, 'completed'); assert.equal(s.jobs[0].energy_mj, 10000000);
    assert.equal(s.machines[0].energy_mj, 12000000);
    assert.equal(s.world.deposits.filter((d: any) => d.depleted).length, 2);
    assert.deepEqual(s.world.deposits.map((d: any) => d.id), checkpoint.world.deposits.map((d: any) => d.id));
    assert.throws(() => action(token, 'collect_deposit', { deposit_id: s.deposits[0].id }), { code: 'DEPOSIT_EMPTY' });
  }
  time += 1000000; db.tick();
  const powered = read();
  assert.equal(powered.machines[0].energy_mj, 20000000);
  assert(powered.base.power.spilled_mj > 0);
  action(a, 'finish_recovery'); assert.equal(read().status, 'active');
  action(b, 'finish_recovery'); assert.equal(read().status, 'completed');
  assert.deepEqual(read().completion, { reason: 'recovery-complete', winner_slot: null });
  const energy = read().base.power.generated_mj;
  time += 10000; db.tick(); assert.equal(read().base.power.generated_mj, energy);
  assert.throws(() => action(a, 'inspect_deposit', { deposit_id: read().deposits[0].id }), { code: 'MATCH_INACTIVE' });
  // A real persisted legacy row migrates once, with cable/batches/jobs/receipts intact.
  const before = db.load(id); const preserved = before.players.map((p: any) => ({ deposit: p.deposit, batches: p.batches, jobs: p.jobs }));
  for (const p of before.players) { delete p.base; p.machine.energy_mj = 10000000; }
  delete before.world; delete before.completion; before.status = 'abandoned';
  db.db.prepare('UPDATE matches SET state=? WHERE id=?').run(JSON.stringify(before), id);
  db.db.exec('PRAGMA user_version=1'); db.close();
  db = new GameDatabase(path, { clock: () => time });
  const migrated = db.load(id);
  assert.deepEqual(migrated.players.map((p: any) => ({ deposit: p.deposit, batches: p.batches, jobs: p.jobs })), preserved);
  assert.equal(read().completion.reason, 'abandoned');
  const seed = migrated.world.seed; db.close(); db = new GameDatabase(path, { clock: () => time });
  assert.equal(db.load(id).world.seed, seed);
  // Active legacy work catches up without receiving solar retroactively.
  const legacy = db.load(id);
  legacy.status = 'active'; legacy.completion = null; legacy.last_advanced_ms = time;
  for (const p of legacy.players) {
    delete p.base;
    p.batches = [p.batches.find((b: any) => b.form === 'cable')];
    p.batches[0].state = 'reserved';
    p.jobs = [p.jobs[0]];
    Object.assign(p.jobs[0], { state: 'running', work_ms: 5000, energy_mj: 2500000, last_tick_ms: time });
    p.machine.energy_mj = 17500000;
  }
  delete legacy.world;
  db.db.prepare('UPDATE matches SET state=?,status=? WHERE id=?').run(JSON.stringify(legacy), 'active', id);
  db.db.exec('PRAGMA user_version=1'); db.close(); time += 5000;
  db = new GameDatabase(path, { clock: () => time });
  assert.equal(read().jobs[0].work_ms, 10000);
  assert.equal(read().machines[0].energy_mj, 15000000);
  assert.equal(read().base.power.generated_mj, 0);
  db.tick(); action(a, 'abandon_match');
  // More than one page: no omitted/duplicated membership or outsider exposure.
  for (let i = 0; i < 21; i++) {
    if (i === 18) time += 86400000;
    db.tick();
    const session = i >= 18 ? (await db.authenticate({ username: 'north', password: 'world-test-password' })).token : a;
    const m = call(session, 'create_match', cmd());
    call(session, 'command', { ...cmd(), match_id: m.snapshot.match_id, expected_revision: m.snapshot.revision, action: 'abandon_match' });
  }
  const token = (await db.authenticate({ username: 'north', password: 'world-test-password' })).token;
  const page1 = call(token, 'list_matches', { version: 3, cursor: null });
  const page2 = call(token, 'list_matches', { version: 3, cursor: page1.next_cursor });
  assert.equal(page1.matches.length, 20); assert.equal(page2.matches.length, 2); assert.equal(page2.next_cursor, null);
  assert.equal(new Set([...page1.matches, ...page2.matches].map(m => m.match_id)).size, 22);
  console.log('PASS finite mirrored world, secret projections, starter ledgers, invite rotation, both recovery loops, solar accounting, restart, completion, migration and membership pagination');
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
