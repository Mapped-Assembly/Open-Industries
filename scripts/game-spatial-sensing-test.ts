import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameDatabase } from '../server/game-sqlite.mjs';

const dir = await mkdtemp(join(tmpdir(), 'oi-spatial-sensing-'));
const path = join(dir, 'sensing.sqlite');
let time = 1_000_000;
const db = new GameDatabase(path, { clock: () => time });
const req = () => ({ version: 5, command_id: randomUUID() });
const call = (token: string, name: string, args: object) =>
  db.dispatch(token, `astra.game_${name}`, args);

try {
  const alice = (await db.authenticate({ username: 'alice-sensing', password: 'spatial-sensing-password' }, true)).token;
  const bob = (await db.authenticate({ username: 'bob-sensing', password: 'spatial-sensing-password' }, true)).token;
  db.tick();
  const created = call(alice, 'create_match', req());
  const matchId = created.snapshot.match_id;
  call(bob, 'join_match', { ...req(), match_id: matchId, invite_code: created.invite_code });

  const read = (token = alice) => call(token, 'read_match', { version: 5, match_id: matchId }).snapshot;
  const act = (action: string, args: object = {}, token = alice) =>
    call(token, 'command', {
      ...req(),
      match_id: matchId,
      expected_revision: read(token).revision,
      action,
      ...args,
    });
  const tick = (ms: number) => {
    time += ms;
    db.tick();
  };

  const robot = read().field.robots[0];
  const packaging = read().world.deposits.find((d: any) => d.kind === 'packaging' && d.home_slot === 1);
  const vehicle = read().world.deposits.find((d: any) => d.kind === 'vehicle' && d.home_slot === 1);
  assert(robot && packaging && vehicle);

  const component = (kind: string) => read().science.components.find((c: any) => c.kind === kind);
  const nirKit = component('nir-sensor-kit');
  const thermalKit = component('thermal-sensor-kit');
  assert(nirKit && thermalKit, 'finite advanced sensor kits are present in owned starter inventory');
  assert.equal(nirKit.tested, false);
  assert.equal(thermalKit.tested, false);

  assert.throws(
    () => act('survey_robot', { robot_id: robot.id, deposit_id: packaging.id, sensor: 'nir' }),
    { code: 'SENSOR_UNAVAILABLE' },
  );
  assert.throws(
    () => act('survey_robot', { robot_id: robot.id, deposit_id: vehicle.id, sensor: 'thermal' }),
    { code: 'SENSOR_UNAVAILABLE' },
  );

  act('inspect_component', { component_id: nirKit.id });
  tick(3_000);
  assert.equal(component('nir-sensor-kit').tested, true);
  act('survey_robot', { robot_id: robot.id, deposit_id: packaging.id, sensor: 'nir' });
  tick(60_000);
  const nir = read().field.observations.filter((o: any) => o.sensor === 'nir').at(-1);
  assert(nir);
  assert.equal(nir.target_id, packaging.id);
  assert.equal(nir.sensor_version, 'field-sensors-v1');
  assert(Number.isInteger(nir.timestamp_ms));
  assert(Number.isInteger(nir.target_revision));
  assert(Number.isInteger(nir.confidence_bps));
  assert(Array.isArray(nir.cues) && nir.cues.length > 0);
  assert(Array.isArray(nir.next_actions) && nir.next_actions.length > 0);
  assert(!JSON.stringify(read(bob)).includes(nir.id), 'opponent projection must not contain private NIR evidence');

  const before = read().field.observations.length;
  act('survey_robot', { robot_id: robot.id, deposit_id: packaging.id, sensor: 'nir' });
  tick(60_000);
  assert.equal(read().field.observations.length, before, 'identical NIR survey must reuse stable uncertainty instead of rerolling');

  act('inspect_component', { component_id: thermalKit.id });
  tick(3_000);
  assert.equal(component('thermal-sensor-kit').tested, true);
  act('survey_robot', { robot_id: robot.id, deposit_id: vehicle.id, sensor: 'thermal' });
  tick(60_000);
  const thermal = read().field.observations.filter((o: any) => o.sensor === 'thermal').at(-1);
  assert(thermal);
  assert.equal(thermal.target_id, vehicle.id);
  assert.equal(thermal.quality, 'occluded');
  assert.equal(thermal.confidence_bps, 0);
  assert(thermal.cues.some((cue: string) => cue.toLowerCase().includes('thermal')));
  assert(!JSON.stringify(read(bob)).includes(thermal.id), 'opponent projection must not contain private thermal evidence');

  const publicSnapshot = JSON.stringify(read());
  const hidden = db.load(matchId);
  assert(!publicSnapshot.includes(hidden.world.seed));
  assert(!publicSnapshot.includes('remaining'));
  assert(!publicSnapshot.includes('cache'));

  console.log('PASS spatial sensing: tested NIR/thermal upgrades, stable uncertainty, occlusion and private evidence');
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
