import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameDatabase, canonical } from '../server/game-sqlite.mjs';
import { checkRobotInvariants, contentsOf, grams } from '../server/game-robots.mjs';
import { recoveryPlan } from '../server/game-recovery.mjs';

const dir = await mkdtemp(join(tmpdir(), 'oi-all-waste-')),
  path = join(dir, 'game.sqlite');
let time = 1000000,
  db = new GameDatabase(path, { clock: () => time });
try {
  const a = (await db.authenticate({ username: 'alice', password: 'all-waste-password-123' }, true))
      .token,
    b = (await db.authenticate({ username: 'bobby', password: 'all-waste-password-123' }, true))
      .token;
  const req = () => ({ version: 5, command_id: randomUUID() }),
    call = (token: string, name: string, args: object) =>
      db.dispatch(token, `astra.game_${name}`, args);
  db.tick();
  const created = call(a, 'create_match', req()),
    id = created.snapshot.match_id;
  call(b, 'join_match', { ...req(), match_id: id, invite_code: created.invite_code });
  const read = (token = a) => call(token, 'read_match', { version: 5, match_id: id }).snapshot;
  const act = (action: string, fields: object = {}) =>
    call(a, 'command', {
      ...req(),
      match_id: id,
      expected_revision: read().revision,
      action,
      ...fields,
    });
  const tick = (ms: number) => {
    time += ms;
    db.tick();
  };
  const evaluate = (target_id: string, query: string, design_id: string, temperature_c = 20) =>
    call(a, 'evaluate', { version: 5, match_id: id, target_id, query, design_id, temperature_c })
      .result;
  const conservation = () =>
    checkRobotInvariants(db.load(id), (code: string) => {
      throw Error(code);
    });
  const flows = [
    ['construction', 'bench-recover-steel', 'steel-bracket'],
    ['packaging', 'bench-trim-hdpe', 'hdpe-housing'],
    ['glass', 'bench-sort-glass', 'glass-filler'],
    ['tire', 'bench-cut-tire', 'traction-tread'],
    ['appliance', 'isolate-appliance', 'steel-bracket'],
    ['vehicle', 'isolate-vehicle', 'aluminum-housing'],
  ] as const;
  for (const [kind, recipe, use] of flows) {
    const robot = read().field.robots[0].id;
    act('recharge_robot', { robot_id: robot });
    tick(180000);
    const target = read().world.deposits.find((d: any) => d.kind === kind && d.home_slot === 1).id;
    act('survey_robot', { robot_id: robot, deposit_id: target, sensor: 'camera-depth' });
    tick(60000);
    const observation = read().field.observations.findLast((o: any) => o.target_id === target).id;
    act('collect_robot', {
      robot_id: robot,
      deposit_id: target,
      observation_id: observation,
      material_class: 'unclassified',
    });
    tick(60000);
    const batch = read().batches.findLast(
      (v: any) => v.source_job_id === null && v.state === 'available',
    ).id;
    assert.equal(evaluate(batch, 'process', recipe).code, 'NEEDS_INSPECTION');
    assert.throws(
      () =>
        act('start_material_process', {
          batch_id: batch,
          machine_id: read().machines[0].id,
          recipe_id: recipe,
        }),
      { code: 'INSPECTION_REQUIRED' },
    );
    act('inspect_batch', { batch_id: batch });
    tick(3000);
    const grade = read().science.batches.find((v: any) => v.id === batch).evidence;
    assert.equal(evaluate(batch, 'process', recipe).status, 'eligible', JSON.stringify(grade));
    if (kind === 'appliance' || kind === 'vehicle') {
      assert.equal(grade.hazard, 'suspect-battery');
      assert.equal(evaluate(batch, 'process', 'bench-recover-steel').code, 'ISOLATE_COMPONENT');
      assert.equal(
        evaluate(batch, 'process', kind === 'appliance' ? 'isolate-vehicle' : 'isolate-appliance')
          .code,
        'UNSUPPORTED_ISOLATION',
      );
    }
    const plan = evaluate(batch, 'process', recipe),
      initial = canonical(db.loadInstance(id));
    const command = {
      ...req(),
      match_id: id,
      expected_revision: read().revision,
      action: 'start_material_process',
      batch_id: batch,
      machine_id: read().machines[0].id,
      recipe_id: recipe,
    };
    db.db.exec(
      "CREATE TRIGGER reject_recovery_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'recovery-fault'); END;",
    );
    assert.throws(() => call(a, 'command', command));
    assert.equal(canonical(db.loadInstance(id)), initial);
    db.db.exec('DROP TRIGGER reject_recovery_receipt');
    const receipt = call(a, 'command', command);
    tick(1000);
    const job = read().jobs.at(-1);
    assert.equal(job.recipe_version, 'starter-recovery-v1');
    act('pause_job', { job_id: job.id });
    const paid = read().jobs.at(-1).energy_mj;
    tick(1000);
    assert.equal(read().jobs.at(-1).energy_mj, paid);
    act('cancel_job', { job_id: job.id });
    assert.equal(read().jobs.at(-1).energy_mj, paid);
    assert.equal(read().batches.find((v: any) => v.id === batch).state, 'available');
    conservation();
    act('start_material_process', {
      batch_id: batch,
      machine_id: read().machines[0].id,
      recipe_id: recipe,
    });
    tick(1000);
    db.close();
    db = new GameDatabase(path, { clock: () => time });
    assert.deepEqual(call(a, 'command', command), receipt);
    tick(30000);
    const completed = read().jobs.at(-1);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.energy_mj, plan.energyJ * 1000);
    assert.equal(evaluate(batch, 'process', recipe).code, 'BATCH_UNAVAILABLE');
    const usable = read().batches.find(
      (v: any) => v.source_job_id === completed.id && v.output_role === 'usable',
    );
    assert(usable);
    const native = db.load(id),
      player = native.players[0],
      outputs = player.batches.filter((v: any) => v.source_job_id === completed.id),
      input = player.batches.find((v: any) => v.id === batch);
    for (const resource of Object.keys(contentsOf(input)))
      assert.equal(
        outputs.reduce((n: number, o: any) => n + (contentsOf(o)[resource] ?? 0), 0),
        contentsOf(input)[resource],
      );
    assert.equal(
      outputs.reduce((n: number, o: any) => n + grams(contentsOf(o)), 0),
      plan.inputMassG,
    );
    conservation();
    assert.equal(
      evaluate(usable.id, 'use', use, use === 'hdpe-housing' ? 60 : 20).code,
      'NEEDS_INSPECTION',
    );
    act('inspect_batch', { batch_id: usable.id });
    tick(3000);
    assert.equal(
      evaluate(usable.id, 'use', use, use === 'hdpe-housing' ? 60 : 20).status,
      'eligible',
    );
    assert.throws(
      () =>
        call(b, 'evaluate', {
          version: 5,
          match_id: id,
          target_id: usable.id,
          query: 'use',
          design_id: use,
          temperature_c: 20,
        }),
      { code: 'NOT_AVAILABLE' },
    );
    assert(!JSON.stringify(read(b)).includes(usable.id));
    assert.equal(
      evaluate(usable.id, 'process', recipe).code,
      kind === 'appliance' || kind === 'vehicle' ? 'UNSUPPORTED_ISOLATION' : 'WRONG_FORM',
    );
    if (kind === 'appliance' || kind === 'vehicle') {
      const residue = read().batches.find(
        (v: any) => v.source_job_id === completed.id && v.output_role === 'residue',
      );
      act('inspect_batch', { batch_id: residue.id });
      tick(3000);
      assert.equal(
        read().science.batches.find((v: any) => v.id === residue.id).evidence.hazard,
        'suspect-battery',
      );
      assert.equal(
        evaluate(residue.id, 'process', 'bench-recover-steel').code,
        'ISOLATE_COMPONENT',
      );
      assert.equal(evaluate(residue.id, 'process', recipe).code, 'UNSUPPORTED_ISOLATION');
      assert.equal(
        evaluate(residue.id, 'process', 'recover-cable-residue').code,
        'ISOLATE_COMPONENT',
      );
    }
    const own = db.load(id).players[0],
      feed = own.batches.find((v: any) => v.id === batch),
      saved = structuredClone(own);
    saved.machine.power_w = 1;
    assert.equal(recoveryPlan(saved, feed, recipe, db.load(id)).code, 'INSUFFICIENT_POWER');
    saved.machine.power_w = 500;
    saved.machine.energy_mj = 0;
    assert.equal(recoveryPlan(saved, feed, recipe, db.load(id)).code, 'INSUFFICIENT_ENERGY');
    saved.machine.energy_mj = 20000000;
    saved.base.assets.find((v: any) => v.kind === 'bench').status = 'destroyed';
    assert.equal(recoveryPlan(saved, feed, recipe, db.load(id)).code, 'MACHINE_UNAVAILABLE');
    console.log(
      `PASS ${kind}: paid inspection, ${recipe}, ${use}, exact constituents/energy, rollback, pause/cancel, restart, privacy and quarantine`,
    );
  }
  console.log(
    'PASS every initial non-cable waste family; existing cable/material suites retain copper-conductor recovery coverage.',
  );
} finally {
  db.close();
  await rm(dir, { recursive: true, force: true });
}
