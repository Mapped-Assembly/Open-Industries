import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameDatabase, canonical } from '../server/game-sqlite.mjs';
import { contentsOf, grams, route, walkable, lineOfSight, checkRobotInvariants } from '../server/game-robots.mjs';

const dir = await mkdtemp(join(tmpdir(), 'oi-robots-'));
const path = join(dir, 'robots.sqlite');
let time = 1000000, db = new GameDatabase(path, { clock: () => time });
const req = () => ({ version: 5, command_id: randomUUID() });
const call = (token: string, name: string, args: object) => db.dispatch(token, `astra.game_${name}`, args);
try {
  const [a, b, outsider] = await Promise.all(['alice', 'bobby', 'outsider'].map(async username => (await db.authenticate({ username, password: 'robots-test-password' }, true)).token));
  db.tick();
  const created = call(a, 'create_match', req()), id = created.snapshot.match_id;
  call(b, 'join_match', { ...req(), match_id: id, invite_code: created.invite_code });
  const read = (token = a) => call(token, 'read_match', { version: 5, match_id: id }).snapshot;
  const act = (action: string, args = {}, token = a) => call(token, 'command', { ...req(), match_id: id, expected_revision: read(token).revision, action, ...args });
  const tick = (ms: number) => { time += ms; db.tick(); };
  const robot = (index = 0, token = a) => read(token).field.robots[index];
  const r = robot().id, second = robot(1).id;
  const cable = read().world.deposits.find((d: any) => d.kind === 'cable' && d.home_slot === 1).id;
  const deposit = (kind: string, slot = 1) => read().world.deposits.find((d: any) => d.kind === kind && d.home_slot === slot).id;
  const scan = (deposit_id: string, robot_id = r, sensor = 'camera-depth', token = a) => {
    act('survey_robot', { robot_id, deposit_id, sensor }, token); tick(60000);
    return read(token).field.observations.filter((o: any) => o.target_id === deposit_id && o.sensor === sensor).at(-1);
  };
  const collect = (o: any, robot_id = r, token = a) => act('collect_robot', { robot_id, deposit_id: o.target_id, observation_id: o.id, material_class: 'unclassified' }, token);
  const assertLedger = () => checkRobotInvariants(db.load(id), (code: string) => { throw new Error(code); });
  assert.equal(read().legacy_recovery, false);
  assert.throws(() => act('inspect_deposit', { deposit_id: cable }), { code: 'ROBOT_REQUIRED' });
  assert.throws(() => act('collect_deposit', { deposit_id: cable }), { code: 'ROBOT_REQUIRED' });
  assert.throws(() => act('survey_robot', { robot_id: robot(0, b).id, deposit_id: cable, sensor: 'camera-depth' }), { code: 'NOT_AVAILABLE' });
  assert.throws(() => act('survey_robot', { robot_id: r, deposit_id: cable, sensor: 'nir' }), { code: 'SENSOR_UNAVAILABLE' });
  assert.throws(() => act('survey_robot', { robot_id: r, deposit_id: cable, sensor: 'camera-depth', position: { x: 19, y: 13 } }), { code: 'INVALID_REQUEST' });
  assert.throws(() => call(outsider, 'read_match', { version: 5, match_id: id }), { code: 'NOT_AVAILABLE' });
  const o = scan(cable);
  assert(o.range <= 8); assert.equal(o.target_revision, 1); assert.equal(o.position.x, robot().position.x);
  assert(lineOfSight(db.load(id).world, o.position, db.load(id).world.deposits[0].position));
  const beforeRescan = robot().energy_mj, observations = read().field.observations.length;
  const again = scan(cable);
  assert.deepEqual(again, o); assert.equal(read().field.observations.length, observations);
  assert.equal(beforeRescan - robot().energy_mj, 40000, 'rescan still costs energy, without rerolling');
  assert(!JSON.stringify(read(b)).includes(o.id));
  assert.throws(() => collect(o, robot(0, b).id, b), { code: 'INSPECTION_REQUIRED' });
  assert.throws(() => act('collect_robot', { robot_id: r, deposit_id: cable, observation_id: o.id, material_class: 'rubber-candidate' }), { code: 'CLASS_UNSUPPORTED' });

  // Two SQLite writers race on the final cable; a committed receipt replays unchanged.
  const o2 = scan(cable, second);
  const expected = read().revision;
  const request = { ...req(), match_id: id, expected_revision: expected, action: 'collect_robot', robot_id: r, deposit_id: cable, observation_id: o.id, material_class: 'unclassified' };
  db.db.exec("CREATE TRIGGER reject_robot_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'rollback-test'); END;");
  assert.throws(() => call(a, 'command', request));
  assert.equal(grams(db.load(id).world.deposits[0].stock.remaining), 10000);
  db.db.exec('DROP TRIGGER reject_robot_receipt');
  const receipt = call(a, 'command', request);
  const other = new GameDatabase(path, { clock: () => time });
  try {
    assert.throws(() => other.dispatch(a, 'astra.game_command', { ...request, command_id: randomUUID(), robot_id: second, observation_id: o2.id }), { code: 'CONFLICT' });
    assert.deepEqual(other.dispatch(a, 'astra.game_command', request), receipt);
  } finally { other.close(); }
  assert.throws(() => collect(o2, second), { code: 'STALE_TARGET' });
  assert.equal(read().batches.length, 0, 'reservation is not inventory');
  assertLedger();
  tick(1000); db.close(); db = new GameDatabase(path, { clock: () => time }); tick(30000);
  assert.deepEqual(call(a, 'command', request), receipt);
  let batch = read().batches[0]; assert.equal(batch.mass_g, 10000); assert.equal(batch.copper_g, null);
  assert.equal(robot().cargo.length, 0); assert.deepEqual(robot().position, robot().home);
  assert.equal(read().science.batches[0].evidence.inspection, 'uninspected');
  const hidden = db.load(id), serialized = JSON.stringify([read(), read(b)]);
  assert(!serialized.includes(hidden.world.seed)); assert(!serialized.includes('hazard_truth')); assert(!serialized.includes('remaining')); assert(!serialized.includes('cache'));
  for (const d of hidden.world.deposits) for (const c of d.truth.components ?? []) assert(!serialized.includes(c.id));
  const evaluate = (batch_id: string, token = a) => call(token, 'evaluate', { version: 5, match_id: id, target_id: batch_id, query: 'process', design_id: 'strip-cable', temperature_c: 20 }).result;
  assert.equal(evaluate(batch.id).code, 'NEEDS_INSPECTION');
  assert.throws(() => evaluate(batch.id, b), { code: 'NOT_AVAILABLE' });
  act('inspect_batch', { batch_id: batch.id }); tick(3000); batch = read().batches[0];
  assert.equal(batch.copper_g + batch.hdpe_g + batch.dirt_g, 10000); assert.equal(evaluate(batch.id).status, 'eligible');

  // Processing has priority on the shared base bus; charging waits and resumes by itself.
  const spent = robot().spent_mj;
  act('start_processing', { batch_id: batch.id, machine_id: read().machines[0].id });
  act('recharge_robot', { robot_id: r }); tick(1000);
  assert.equal(read().field.jobs.at(-1).reason, 'base-busy'); assert.equal(robot().charged_mj, 0);
  tick(40000); assert.equal(robot().energy_mj, 8000000); assert.equal(robot().charged_mj, spent);
  assert.equal(read().jobs.at(-1).energy_mj, 10000000);
  assert.equal(read().field.transferred_mj, spent); assertLedger();
  const empty = scan(cable); assert.throws(() => collect(empty), { code: 'DEPOSIT_EMPTY' });

  // Interrupt before pickup returns the reservation. Interrupt after pickup retains real cargo.
  const packaging = deposit('packaging');
  const dirty = scan(packaging);
  assert(['dirty', 'low-signal'].includes(dirty.quality)); assert.deepEqual(dirty.candidate_classes, ['unclassified']); assert(dirty.next_actions.length);
  collect(dirty); const reserved = grams(db.load(id).players[0].robot_jobs.at(-1).reserved.contents);
  act('interrupt_robot', { robot_id: r }); assert.equal(robot().cargo.length, 0);
  assert.equal(grams(db.load(id).world.deposits.find((d: any) => d.id === packaging).stock.remaining), hidden.world.deposits.find((d: any) => d.id === packaging).truth.mass_g);
  const revised = scan(packaging); assert.notEqual(revised.target_revision, dirty.target_revision);
  collect(revised);
  for (let n = 0; !robot().cargo.length && n < 200; n++) tick(250);
  assert.equal(robot().cargo[0].mass_g, reserved);
  act('interrupt_robot', { robot_id: r }); assert.equal(robot().cargo[0].mass_g, reserved);
  const beforeReturn = robot().energy_mj;
  act('retreat_robot', { robot_id: r }); tick(60000);
  assert(robot().energy_mj < beforeReturn); assert.equal(robot().cargo.length, 0);
  assert(read().batches.some((b: any) => b.form === 'mixed' && b.mass_g === 10000)); assertLedger();
  act('recharge_robot', { robot_id: r }); tick(60000);

  // Unknown battery-bearing scrap is held for bench inspection, then remains isolated.
  const appliance = scan(deposit('appliance')); collect(appliance); tick(60000);
  const hazardous = read().batches.at(-1);
  assert.equal(evaluate(hazardous.id).code, 'NEEDS_INSPECTION');
  act('inspect_batch', { batch_id: hazardous.id }); tick(3000);
  assert.equal(evaluate(hazardous.id).code, 'ISOLATE_COMPONENT');
  assert.equal(read().science.batches.find((b: any) => b.id === hazardous.id).evidence.hazard, 'suspect-battery');
  assert.throws(() => act('start_material_process', { batch_id: hazardous.id, machine_id: read().machines[0].id, recipe_id: 'strip-cable' }), { code: 'INVALID_FEEDSTOCK' });
  const occluded = scan(deposit('vehicle'), second); assert.equal(occluded.quality, 'occluded'); assert.equal(occluded.confidence_bps, 0);

  // Routes go around walls. The same algorithm rejects an enclosed robot.
  const w = db.load(id).world, detour = route(w, { x: 38, y: 10 }, at => at.x === 42 && at.y === 10);
  assert(detour && detour.length > 4); assert(detour.every((p: any) => walkable(w, p)));
  const boxed = structuredClone(w); boxed.obstacles.push({ x: 1, y: 1, width: 94, height: 54 });
  assert.equal(route(boxed, { x: 13, y: 27 }, at => at.x === 42), null);
  const saved = db.load(id);
  saved.players[0].robots[1].spent_mj += saved.players[0].robots[1].energy_mj; saved.players[0].robots[1].energy_mj = 0; db.save(saved);
  assert.throws(() => act('survey_robot', { robot_id: second, deposit_id: deposit('glass'), sensor: 'camera-depth' }), { code: 'ROBOT_ENERGY' });

  // Event integration must produce identical physics for one long tick or many short ticks.
  act('recharge_robot', { robot_id: r }); tick(60000);
  const last = scan(deposit('tire')); collect(last);
  const checkpoint = db.load(id), t0 = time;
  tick(100000); const long = db.load(id);
  db.db.prepare('UPDATE matches SET state=?,last_tick=? WHERE id=?').run(JSON.stringify(checkpoint), t0, id); time = t0;
  for (let i = 0; i < 400; i++) tick(250);
  const short = db.load(id);
  assert.deepEqual(short.players.map((p: any) => p.robots), long.players.map((p: any) => p.robots));
  assert.deepEqual(short.players.map((p: any) => p.machine), long.players.map((p: any) => p.machine));
  assert.deepEqual(short.players.map((p: any) => p.base.power), long.players.map((p: any) => p.base.power));
  assert.deepEqual(short.players.map((p: any) => p.robot_jobs), long.players.map((p: any) => p.robot_jobs));
  assertLedger();

  // An empty base supplies only solar; two chargers share one port without borrowing energy.
  const starved = db.load(id), crew = starved.players[0];
  crew.machine.dissipated_mj += crew.machine.energy_mj; crew.machine.energy_mj = 0;
  for (const r of crew.robots) { r.spent_mj += r.energy_mj; r.energy_mj = 0; r.position = { ...r.home }; }
  db.save(starved);
  const transferred = read().field.transferred_mj;
  act('recharge_robot', { robot_id: r }); act('recharge_robot', { robot_id: second }); tick(1000);
  assert.equal(robot().energy_mj, 100000); assert.equal(robot(1).energy_mj, 0);
  assert.equal(read().machines[0].energy_mj, 0); assert.equal(read().field.jobs.at(-1).reason, 'charging-port');
  tick(159000);
  assert.equal(robot().energy_mj, 8000000); assert.equal(robot(1).energy_mj, 8000000);
  assert.equal(read().field.transferred_mj - transferred, 16000000); assertLedger();

  // Legacy schema-3 upgrade preserves prior content, energy, jobs, and original receipts.
  act('abandon_match');
  const prior = db.load(id); const cableTruth = canonical(prior.world.deposits[0].truth);
  // A separately created untouched world represents a real pre-robot save.
  db.tick(); const old = call(a, 'create_match', req()), oldId = old.snapshot.match_id;
  const v3 = db.load(oldId); delete v3.robot_version; delete v3.legacy_recovery;
  for (const d of v3.world.deposits) { delete d.stock; delete d.surface; }
  for (const p of v3.players) { delete p.robots; delete p.robot_jobs; delete p.surveys; delete p.robot_charge_mj; }
  db.db.prepare('UPDATE matches SET state=? WHERE id=?').run(JSON.stringify(v3), oldId); db.db.exec('PRAGMA user_version=3');
  db.close(); db = new GameDatabase(path, { clock: () => time });
  assert.equal(db.load(oldId).legacy_recovery, true); assert.equal(db.load(id).legacy_recovery, false);
  assert.equal(canonical(db.load(id).world.deposits[0].truth), cableTruth);
  const migrated = canonical(db.load(oldId)); db.close(); db = new GameDatabase(path, { clock: () => time }); assert.equal(canonical(db.load(oldId)), migrated);
  console.log('PASS robot authority: routes, paid stable sensing, private unknown cargo, two-writer reservation race, rollback, exact retries, restart, inspection, shared charging, hazards, interruption/retreat, stale/depleted targets, conservation, tick equivalence and schema-4 migration');
} finally { db.close(); await rm(dir, { recursive: true, force: true }); }
