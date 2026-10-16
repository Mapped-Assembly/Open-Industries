import { commandUnit, unitProjection, assertUnits, damageUnit, unitProfiles } from '../game-units.mjs';
import { manufacturingCatalog, manufacturingVersion, manufacturingPlan, enqueueManufacturing, isManufacturing, productionLive, cancelManufacturing, finishManufacturing, settleManufacturing, manufacturingProjection, assertManufacturing, salvageStarterAsset, productionSolar, chargingPower, productionProducts } from '../game-manufacturing.mjs';
import { isRecoveryRecipe, recoveryVersion } from '../game-recovery.mjs';
import { initializeScience, materialBatch, scienceProjection, processPlan, processOutputs, inspectAtBench, evaluateScience, catalog, scienceVersions } from '../game-materials.mjs';
import { initializeRobots, robotVersion, contentsOf, grams, commandRobot, stopRobot, settleRobots, robotStepLimit, chargingRobot, advanceRobots, robotProjection, checkRobotInvariants, robotsBusy } from '../game-robots.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { gameFail } from '../mcp-game-contract.mjs';
import { SqliteAuthority } from '../simulation/sqlite-authority.mjs';
import { makeWorld, provisionPlayer, starterBase, worldProjection } from '../game-world.mjs';
import {
  assertResourceConservation,
  splitQuantity,
} from '../simulation/resources.mjs';
import { authoritativeTime } from '../simulation/time.mjs';

export const gameRulePin = {
  module_id: 'game-runtime',
  module_version: 'dump-world-v1',
  schema_version: 3,
};

const hash = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) =>
  JSON.stringify(value, function (_key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item;
  });
const live = (job) => ['waiting','running','paused'].includes(job.state);
const conserved = (expected, actual) => {
  try {
    assertResourceConservation(expected, actual);
  } catch {
    gameFail('INVARIANT_FAILED');
  }
};
const accountedTime = (now, previous) => {
  try {
    return authoritativeTime(now, previous);
  } catch {
    gameFail('INVARIANT_FAILED');
  }
};
const mass = (value) => ({ copper_g: value.copper_g, hdpe_g: value.hdpe_g, dirt_g: value.dirt_g });

export function cablePlan(input) {
  const { copper_g: copper, hdpe_g: hdpe, dirt_g: dirt } = input;
  if (
    ![copper, hdpe, dirt].every((n) => Number.isInteger(n) && n >= 0) ||
    copper + hdpe + dirt < 1 ||
    copper + hdpe + dirt > 10000 ||
    copper * 2 < copper + hdpe + dirt
  )
    gameFail('INVALID_FEEDSTOCK');
  const conductor = splitQuantity(copper, 19, 20).allocated,
    insulation = splitQuantity(hdpe, 6, 7).allocated;
  return {
    duration_ms: (copper + hdpe + dirt) * 2,
    outputs: [
      { output_role: 'conductor', form: 'wire', copper_g: conductor, hdpe_g: 0, dirt_g: 0 },
      { output_role: 'insulation', form: 'flakes', copper_g: 0, hdpe_g: insulation, dirt_g: 0 },
      {
        output_role: 'residue',
        form: 'residue',
        copper_g: copper - conductor,
        hdpe_g: hdpe - insulation,
        dirt_g: dirt,
      },
    ],
  };
}

/** Versioned legacy game compatibility module: balance, ownership, world, processing and outcomes. */
class LegacyGameDomain extends SqliteAuthority {
  domainPin = gameRulePin;
  /** Stable instance-scoped links to changed game jobs and instrument entities. */
  historyLinks(match, previous) {
    const changedJobs = match.players.flatMap(p => {
      const old = previous.state.players.find(prior => prior.owner === p.owner);
      const prior = [...(old?.jobs ?? []), ...(old?.robot_jobs ?? [])];
      return [...p.jobs, ...(p.robot_jobs ?? [])]
        .filter(job => canonical(prior.find(old => old.id === job.id) ?? null) !== canonical(job))
        .map(job => job.id);
    });
    return {entity_ids:match.players.flatMap(p => [p.machine.id,...(p.robots ?? []).map(r => r.id)]), job_ids:changedJobs};
  }

  /** Domain-authorized history view; raw history is never a client projection. */
  historyProjection() {
    const project = (state, principal, at) => {
      if (!state.players.some((p) => p.owner === principal)) return null;
      const { scheduler_healthy, ...snapshot } = this.historicalSnapshot(state, principal);
      snapshot.server_time_ms = at;
      return { ...snapshot, rule: gameRulePin };
    };
    return {
      version: 'game-history-v2',
      authorize: (state, principal) => state.players.some((p) => p.owner === principal),
      validateState: (state, rule) => {
        if (canonical(rule) !== canonical(gameRulePin)) gameFail('INVARIANT_FAILED');
        this.validateHistoricalState(state);
      },
      snapshot: project,
      event: (event, principal) => {
        if (event.source.kind === 'command' && event.source.principal_id !== principal) return null;
        const snapshot = project(event.state, principal, event.simulation_time_ms);
        if (!snapshot) return null;
        return {
          id: event.id,
          instance_id: event.instance_id,
          command_id: event.source.kind === 'command' ? event.source.id : null,
          kind: event.source.kind,
          action: event.payload.action,
          simulation_time_ms: event.simulation_time_ms,
          rule: event.rule,
          provenance: event.provenance,
          units: event.units,
          snapshot,
        };
      },
    };
  }

  /** Preserve native membership semantics without making slots a core requirement. */
  member(match, owner) {
    return match.players.find((p) => p.owner === owner);
  }
  /** Construct the pinned game world; neutral modules never call this hook. */
  newMatch(owner, invite) {
    const match = {
      id: randomUUID(),
      revision: 1,
      status: 'waiting',
      invite_hash: hash(invite),
      invite_expires: this.clock() + 3600000,
      last_advanced_ms: this.clock(),
      completion: null,
      world: makeWorld(),
      players: [],
    };
    match.players.push(provisionPlayer(owner, 1, match.world));
    return match;
  }
  /** Check invitation and privacy under the caller's existing write lock. */
  checkJoin(match, owner, invite) {
    if (
      match.status !== 'waiting' ||
      this.member(match, owner) ||
      match.invite_hash !== hash(invite) ||
      match.invite_expires <= this.clock()
    )
      gameFail('NOT_AVAILABLE');
  }
  join(match, owner) {
    match.players.push(provisionPlayer(owner, 2, match.world));
    match.status = 'active';
    match.invite_hash = null;
  }
  rotate(match, owner, invite) {
    if (this.member(match, owner)?.slot !== 1 || match.status !== 'waiting')
      gameFail('NOT_AVAILABLE');
    match.invite_hash = hash(invite);
    match.invite_expires = this.clock() + 3600000;
  }
  /** Explicit legacy migration preserves jobs, IDs and original no-solar settlement. */
  upgradeLegacy(match) {
    match.world = makeWorld(match.players);
    match.completion =
      match.status === 'abandoned' ? { reason: 'abandoned', winner_slot: null } : null;
    if (match.completion) match.status = 'completed';
    for (const p of match.players) {
      p.base = starterBase(
        p.slot,
        p.machine.id,
        match.world.towers.find((t) => t.slot === p.slot).id,
      );
      p.base.assets.find((a) => a.id === p.machine.id).status = p.machine.status;
      p.base.power.solar_w = 0;
    }
    this.advance(match);
    for (const p of match.players) p.base.power.solar_w = 100;
    match.revision++;
  }
  assertState(match) {
    for (const p of match.players) {
      for (const constituent of ['copper_g', 'hdpe_g', 'dirt_g']) {
        const total =
          (p.deposit.collected ? 0 : p.deposit[constituent]) +
          p.batches
            .filter((b) => b.state !== 'consumed')
            .reduce((sum, b) => sum + b[constituent], 0);
        conserved({ [constituent]: p.deposit[constituent] }, { [constituent]: total });
      }
      if (
        p.machine.energy_mj < 0 ||
        p.machine.energy_mj > p.base.power.capacity_mj ||
        p.machine.energy_mj +
          p.machine.dissipated_mj +
          p.base.power.spilled_mj +
          p.jobs.reduce((sum, j) => sum + j.energy_mj, 0) !==
          p.base.power.initial_mj + p.base.power.generated_mj
      )
        gameFail('INVARIANT_FAILED');
      const allocations = [
        ...p.base.assets.flatMap((a) => a.components.map((c) => ({ ...c, allocation_id: a.id }))),
        ...p.base.inventory.map((c) => ({ ...c, allocation_id: 'store' })),
      ];
      if (
        canonical(allocations) !== canonical(p.base.starter_ledger) ||
        p.base.assets.filter((a) => a.kind === 'tower').length !== 1 ||
        p.base.assets.filter((a) => a.kind === 'robot').length !== 2
      )
        gameFail('INVARIANT_FAILED');
    }
  }

  complete(match, reason) {
    match.status = 'completed';
    match.completion = { reason, winner_slot: null };
    match.invite_hash = null;
  }

  snapshot(match, owner) {
    const p = match.players.find((p) => p.owner === owner);
    if (!p) gameFail('NOT_AVAILABLE');
    return {
      match_id: match.id,
      revision: match.revision,
      status: match.status,
      completion: match.completion,
      world: worldProjection(match),
      base: p.base,
      invite_expires_at_ms:
        match.status === 'waiting' && p.slot === 1 ? match.invite_expires : null,
      server_time_ms: Math.max(this.clock(), match.last_advanced_ms),
      scheduler_healthy: this.healthy(),
      players: match.players.map((p) => ({ slot: p.slot, you: p.owner === owner })),
      deposits: [
        {
          id: p.deposit.id,
          collected: p.deposit.collected,
          observation: p.deposit.observation
            ? { id: p.deposit.observation, sensor: 'cable-assay-v1', ...mass(p.deposit) }
            : null,
        },
      ],
      machines: [p.machine],
      batches: p.batches,
      jobs: p.jobs.map(({ last_tick_ms, outputs, ...visible }) => visible),
    };
  }

  quota(owner, creating) {
    const rows = this.db
      .prepare('SELECT m.state FROM matches m JOIN members p ON p.match_id=m.id WHERE p.owner=?')
      .all(owner);
    const open = rows
      .map((row) => JSON.parse(row.state))
      .filter(
        (m) => m.status === 'active' || (m.status === 'waiting' && m.invite_expires > this.clock()),
      );
    if (
      open.length >= 3 ||
      (creating &&
        this.db
          .prepare('SELECT count(*) n FROM matches WHERE host=? AND created>?')
          .get(owner, this.clock() - 86400000).n >= 20)
    )
      gameFail('LIMIT_REACHED');
  }
  /** Existing game preconditions shared by old dispatch and the extracted command path. */

  checkMutation(match, owner, action) {
    if (
      !['join_match', 'abandon_match', 'rotate_invite'].includes(action) &&
      match.status !== 'active'
    )
      gameFail('MATCH_INACTIVE');
    if (action === 'abandon_match' && match.status === 'completed') gameFail('MATCH_INACTIVE');
    if (
      action !== 'abandon_match' &&
      this.db
        .prepare('SELECT count(*) n FROM receipts WHERE owner=? AND match_id=?')
        .get(owner, match.id).n >= 256
    )
      gameFail('LIMIT_REACHED');
    if (
      !['pause_job', 'cancel_job', 'interrupt_robot', 'retreat_robot', 'dismantle_machine', 'abandon_match'].includes(action) &&
      !this.healthy()
    )
      gameFail('SCHEDULER_UNAVAILABLE');
  }

}

/** Native v5 game policy. Existing orders retain their published event-boundary advancement. */
export class VersionedGameDomain extends LegacyGameDomain {
  newMatch(owner, invite) {
    const match = super.newMatch(owner, invite);
    initializeRobots(match);
    initializeScience(match);
    return match;
  }
  join(match, owner) {
    super.join(match, owner);
    initializeRobots(match);
    initializeScience(match);
  }
  /** Upgrade pinned native formats, keeping stock, paid work and immutable receipts intact. */
  upgradeScience(match) { initializeScience(match); match.revision++; }
  upgradeRobots(match) {
    this.advance(match);
    initializeRobots(match, true);
    initializeScience(match);
    match.revision++;
  }
  validateCurrentState(match) {
    if (match.robot_version !== robotVersion) gameFail('INVARIANT_FAILED');
    this.assertState(match);
  }
  prepareState(match) { initializeScience(match); for (const p of match.players) if (p.production) p.base.power.solar_w = productionSolar(p); }
  scienceRead(match, owner, operation, args) {
    if (operation === 'manufacturing_catalog') return { version: 5, catalog: manufacturingCatalog() };
    if (operation === 'manufacturing_preview') return { version: 5, match_id: match.id, revision: match.revision, result: manufacturingPlan(this.member(match, owner), args) };
    if (canonical(match.science) !== canonical(scienceVersions)) gameFail('INVARIANT_FAILED');
    return operation === 'science_catalog'
      ? { version: 5, catalog: catalog() }
      : { version: 5, match_id: match.id, revision: match.revision, result: evaluateScience(this.member(match, owner), args, gameFail, match) };
  }
  assertState(match) {
    if (canonical(match.science) !== canonical(scienceVersions)) gameFail('INVARIANT_FAILED');
    if (match.robot_version) checkRobotInvariants(match, gameFail);
    for (const p of match.players) {
      assertManufacturing(p, gameFail);
      assertUnits(p, gameFail);
      if (!match.robot_version) for (const constituent of ['copper_g', 'hdpe_g', 'dirt_g']) {
        const total = (p.deposit.collected ? 0 : p.deposit[constituent])
          + p.batches.filter(b => b.state !== 'consumed').reduce((sum, b) => sum + b[constituent], 0);
        if (total !== p.deposit[constituent]) gameFail('INVARIANT_FAILED');
      }
      if (p.machine.energy_mj < 0 || p.machine.energy_mj > p.base.power.capacity_mj || p.machine.energy_mj + p.machine.dissipated_mj
        + p.base.power.spilled_mj + (p.robot_charge_mj ?? 0) + p.jobs.reduce((sum, j) => sum + j.energy_mj, 0) !== p.base.power.initial_mj + p.base.power.generated_mj) gameFail('INVARIANT_FAILED');
      if (canonical(p.components.map(c => ({ kind: c.kind, quantity: c.quantity, unit_mass_g: c.unitMassG }))) !== canonical(p.base.inventory)
        || p.components.some(c => c.owner !== p.owner || c.allocation !== 'component-only')) gameFail('INVARIANT_FAILED');
      for (const job of p.jobs) if ((isRecoveryRecipe(job.recipe) && job.recipe_version !== recoveryVersion)
        || (job.recipe_version === recoveryVersion && !isRecoveryRecipe(job.recipe))) gameFail('INVARIANT_FAILED');
      for(const b of p.batches)if(b.manufacturing_stock_rule&&b.manufacturing_stock_rule!==manufacturingVersion)gameFail('INVARIANT_FAILED');
      for (const b of p.batches) if (b.recovery_rule && (b.recovery_rule !== recoveryVersion
        || !isRecoveryRecipe(b.recovery_recipe))) gameFail('INVARIANT_FAILED');
      for (const b of p.batches) if (b.material.massG !== grams(contentsOf(b))
        || canonical(b.material.constituents) !== canonical(materialBatch(b).constituents)) gameFail('INVARIANT_FAILED');
      const allocations = [...p.base.assets.flatMap(a => a.components.map(c => ({ ...c, allocation_id: a.id }))), ...p.base.inventory.map(c => ({ ...c, allocation_id: 'store' }))];
      if ((!p.production && canonical(allocations) !== canonical(p.base.starter_ledger)) || p.base.assets.filter(a => a.kind === 'tower').length !== 1
        || p.base.assets.filter(a => a.kind === 'robot').length !== 2) gameFail('INVARIANT_FAILED');
    }
  }
  cancel(p, job, reason) {
    if (!live(job)) return;
    if (isManufacturing(job)) { cancelManufacturing(p, job, reason, reason === 'machine_destroyed'); return; }
    if (job.kind === 'component-inspection') { job.state = 'cancelled'; job.pause_reason = null; job.cancellation_reason = reason; return; }
    const batch = p.batches.find(b => b.id === job.input_batch_id);
    if (!batch || batch.state !== 'reserved') gameFail('INVARIANT_FAILED');
    batch.state = 'available'; job.state = 'cancelled'; job.pause_reason = null; job.cancellation_reason = reason;
  }
  advance(match) {
    if (match.robot_version) return this.advanceWithRobots(match);
    const now = accountedTime(this.clock(), match.last_advanced_ms);
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
    if (isManufacturing(job)) { finishManufacturing(p, job); return; }
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
    const now = accountedTime(this.clock(), match.last_advanced_ms);
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
      world: worldProjection(match), base: p.base, units: unitProjection(match,p,Math.max(this.clock(),match.last_advanced_ms)), manufacturing: manufacturingProjection(p), science: scienceProjection(match, p), field: robotProjection(p), legacy_recovery: match.legacy_recovery, invite_expires_at_ms: match.status === 'waiting' && p.slot === 1 ? match.invite_expires : null,
      server_time_ms: Math.max(this.clock(), match.last_advanced_ms), scheduler_healthy: this.healthy(),
      players: match.players.map(p => ({ slot: p.slot, you: p.owner === owner })),
      deposits: [{ id: p.deposit.id, collected: p.deposit.collected, observation: p.deposit.observation
        ? { id: p.deposit.observation, sensor: 'cable-assay-v1', ...mass(p.deposit) } : null }],
      machines: [p.machine], batches: p.batches.map(b => ({ id: b.id, form: b.form, state: b.state, mass_g: grams(contentsOf(b)),
        ...Object.fromEntries(['copper', 'hdpe', 'dirt'].map(k => [`${k}_g`, b.field_collected && b.material.inspection !== 'graded' ? null : contentsOf(b)[k] ?? 0])),
        observation_id: b.observation_id, source_job_id: b.source_job_id, output_role: b.output_role, grade: b.grade })),
      jobs: p.jobs.filter(j => !isManufacturing(j)).map(({ last_tick_ms, outputs, kind, power_w, ...visible }) => visible),
    };
  }
  command(match, p, args) {
    const { action } = args;
    if (['deploy_unit','set_unit_enabled','load_unit_ammunition','repair_unit','salvage_unit'].includes(action)) {
      commandUnit(match,p,args,Math.max(this.clock(),match.last_advanced_ms),gameFail);
    } else if (action === 'enqueue_manufacturing') {
      enqueueManufacturing(p, args, Math.max(this.clock(), match.last_advanced_ms), gameFail);
    } else if (action === 'salvage_starter_asset') {
      salvageStarterAsset(p, args.asset_id, gameFail);
    } else if (action === 'set_production_machine' || action === 'destroy_manufactured_product') {
      const product = productionProducts(p).find(a => a.id === (args.product_id??args.machine_id) && (a.state === 'installed' || (action === 'destroy_manufactured_product' && a.state === 'available')));
      if (!product || (action === 'set_production_machine' && !['machine','upgrade'].includes(product.category))) gameFail('NOT_AVAILABLE');
      if (action === 'set_production_machine') product.enabled = args.enabled;
      else { if(p.units?.some(u=>u.ammunition_ids.includes(product.id)||u.repair_product_ids.includes(product.id)))gameFail('NOT_READY'); if(unitProfiles[product.kind])damageUnit(p,product.id,Number.MAX_SAFE_INTEGER); product.state = 'destroyed'; product.enabled = false; for (const j of p.jobs.filter(j => isManufacturing(j) && j.machine_id === product.id)) cancelManufacturing(p,j,'machine_destroyed',true); const robot=p.robots.find(r=>r.id===product.id); if(robot) { if(robot.job_id||robot.cargo.length)gameFail('NOT_READY'); robot.retired=true;robot.spent_mj+=robot.energy_mj;robot.energy_mj=0; } }
    } else if (action === 'inspect_deposit' || action === 'collect_deposit') {
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
      if (!batch || (p.machine.id !== args.machine_id && !productionProducts(p).some(a=>a.id===args.machine_id&&a.state==='installed'&&a.enabled))) gameFail('NOT_AVAILABLE');
      if (batch.state !== 'available' || p.machine.status !== 'ready' || p.machine.energy_mj < 500 || p.jobs.some(live)) gameFail('NOT_READY');
      const recipe = action === 'start_processing' ? 'strip-cable' : args.recipe_id;
      const evaluated = processPlan(p, batch, recipe, match, args.machine_id);
      if (evaluated.status === 'needs-inspection') gameFail('INSPECTION_REQUIRED');
      if (evaluated.status !== 'eligible') gameFail('INVALID_FEEDSTOCK');
      const plan = { duration_ms: evaluated.durationMs, outputs: processOutputs(evaluated, batch) }; batch.state = 'reserved'; p.base.ready_to_finish = false;
      p.jobs.push({ id: randomUUID(), machine_id: args.machine_id, input_batch_id: batch.id, recipe, recipe_version: isRecoveryRecipe(recipe) ? recoveryVersion : match.science.recipes,
        state: 'running', pause_reason: null, cancellation_reason: null, duration_ms: plan.duration_ms, work_ms: 0, energy_mj: 0,
        last_tick_ms: Math.max(this.clock(), match.last_advanced_ms), outputs: plan.outputs });
    } else if (['pause_job', 'resume_job', 'cancel_job'].includes(action)) {
      const job = p.jobs.find(j => j.id === args.job_id);
      if (!job) gameFail('NOT_AVAILABLE');
      if (!live(job)) gameFail('NOT_READY');
      if (action === 'resume_job' && isManufacturing(job)) { if (job.state !== 'paused') gameFail('NOT_READY'); job.pause_reason = 'resume'; settleManufacturing(p, Math.max(this.clock(),match.last_advanced_ms)); return; }
      if (action === 'cancel_job') this.cancel(p, job, 'requested');
      else if (action === 'pause_job') { job.state = 'paused'; job.pause_reason = 'requested'; }
      else {
        if (job.state !== 'paused' || p.jobs.some(other=>other!==job&&other.state==='running') || p.machine.status !== 'ready' || p.machine.energy_mj < 500) gameFail('NOT_READY');
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
  /** Old history is projected with its original field boundaries; never initialize on replay. */
  historicalSnapshot(match, owner) {
    if (match.robot_version) return this.snapshot(match, owner);
    const snapshot = super.snapshot(match, owner);
    snapshot.world.deposits = snapshot.world.deposits.map(({revision, ...visible}) => visible);
    if (!match.science) return snapshot;
    snapshot.science = scienceProjection(match, this.member(match, owner));
    snapshot.batches = this.member(match, owner).batches.map(({material, material_revision, ...visible}) => visible);
    snapshot.jobs = this.member(match, owner).jobs.map(({last_tick_ms, outputs, kind, power_w, ...visible}) => visible);
    return snapshot;
  }
  validateHistoricalState(match) {
    if (!match.science) return super.assertState(match);
    this.assertState(match);
  }
}
