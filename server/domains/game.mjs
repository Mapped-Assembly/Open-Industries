import { createHash, randomUUID } from 'node:crypto';
import { gameFail } from '../mcp-game-contract.mjs';
import { SqliteAuthority } from '../simulation/sqlite-authority.mjs';
import { makeWorld, provisionPlayer, starterBase, worldProjection } from '../game-world.mjs';
import {
  assertResourceConservation,
  energyForPower,
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
const live = (job) => job.state === 'running' || job.state === 'paused';
/** Preserve published game errors while using exact shared accounting. */
const accountedEnergy = (power, duration) => {
  try {
    return energyForPower(power, duration);
  } catch {
    gameFail('INVARIANT_FAILED');
  }
};
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
export class VersionedGameDomain extends SqliteAuthority {
  domainPin = gameRulePin;
  /** Stable instance-scoped links to changed game jobs and instrument entities. */
  historyLinks(match, previous) {
    const changedJobs = match.players.flatMap((p) =>
      p.jobs
        .filter((job) => {
          const prior = previous.state.players
            .find((old) => old.owner === p.owner)
            ?.jobs.find((old) => old.id === job.id);
          return !prior || canonical(prior) !== canonical(job);
        })
        .map((job) => job.id),
    );
    return { entity_ids: match.players.map((p) => p.machine.id), job_ids: changedJobs };
  }

  /** Domain-authorized history view; raw history is never a client projection. */
  historyProjection() {
    const project = (state, principal, at) => {
      if (!state.players.some((p) => p.owner === principal)) return null;
      const { scheduler_healthy, ...snapshot } = this.snapshot(state, principal);
      snapshot.server_time_ms = at;
      return { ...snapshot, rule: gameRulePin };
    };
    return {
      version: 'game-history-v1',
      authorize: (state, principal) => state.players.some((p) => p.owner === principal),
      validateState: (state, rule) => {
        if (canonical(rule) !== canonical(gameRulePin)) gameFail('INVARIANT_FAILED');
        this.assertState(state);
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

  cancel(p, job, reason) {
    if (!live(job)) return;
    const batch = p.batches.find((b) => b.id === job.input_batch_id);
    if (!batch || batch.state !== 'reserved') gameFail('INVARIANT_FAILED');
    batch.state = 'available';
    job.state = 'cancelled';
    job.pause_reason = null;
    job.cancellation_reason = reason;
  }

  complete(match, reason) {
    match.status = 'completed';
    match.completion = { reason, winner_slot: null };
    match.invite_hash = null;
  }

  advance(match) {
    const now = accountedTime(this.clock(), match.last_advanced_ms);
    if (match.status === 'waiting' && match.invite_expires <= now) {
      this.complete(match, 'invite-expired');
      match.revision++;
    }
    let changed = false;
    if (match.status === 'active')
      for (const p of match.players) {
        const elapsed = now - match.last_advanced_ms;
        const solar = p.machine.status === 'ready' ? p.base.power.solar_w : 0;
        const generated = accountedEnergy(solar, elapsed);
        let spent = 0;
        for (const job of p.jobs.filter((j) => j.state === 'running')) {
          const requested = Math.min(
            job.duration_ms - job.work_ms,
            Math.max(0, now - job.last_tick_ms),
          );
          const delta = Math.min(requested, Math.floor(p.machine.energy_mj / (500 - solar)));
          job.work_ms += delta;
          job.energy_mj += accountedEnergy(500, delta);
          spent += accountedEnergy(500, delta);
          job.last_tick_ms = Math.max(job.last_tick_ms, now);
          if (job.work_ms === job.duration_ms) {
            const input = p.batches.find((b) => b.id === job.input_batch_id);
            if (!input || input.state !== 'reserved') gameFail('INVARIANT_FAILED');
            input.state = 'consumed';
            job.state = 'completed';
            changed = true;
            for (const output of job.outputs)
              if (output.copper_g + output.hdpe_g + output.dirt_g > 0) {
                if (
                  p.batches.some(
                    (b) => b.source_job_id === job.id && b.output_role === output.output_role,
                  )
                )
                  gameFail('INVARIANT_FAILED');
                p.batches.push({
                  id: randomUUID(),
                  state: 'available',
                  ...output,
                  observation_id: null,
                  source_job_id: job.id,
                  grade: 'recovered-ungraded',
                });
              }
          } else if (delta < requested) {
            job.state = 'paused';
            job.pause_reason = 'power';
            changed = true;
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
      !['pause_job', 'cancel_job', 'dismantle_machine', 'abandon_match'].includes(action) &&
      !this.healthy()
    )
      gameFail('SCHEDULER_UNAVAILABLE');
  }
  /** Adopt one real command without changing its wire schema, tables or receipt fingerprint. */

  command(match, p, args) {
    const { action } = args;
    if (action === 'inspect_deposit' || action === 'collect_deposit') {
      if (p.deposit.id !== args.deposit_id) gameFail('NOT_AVAILABLE');
      if (p.deposit.collected) gameFail('DEPOSIT_EMPTY');
      if (action === 'inspect_deposit') p.deposit.observation ||= randomUUID();
      else {
        if (!p.deposit.observation) gameFail('INSPECTION_REQUIRED');
        p.deposit.collected = true;
        p.batches.push({
          id: randomUUID(),
          form: 'cable',
          state: 'available',
          ...mass(p.deposit),
          observation_id: p.deposit.observation,
          source_job_id: null,
          output_role: null,
          grade: 'assayed-feedstock',
        });
      }
    } else if (action === 'start_processing') {
      const batch = p.batches.find((b) => b.id === args.batch_id);
      if (!batch || p.machine.id !== args.machine_id) gameFail('NOT_AVAILABLE');
      if (
        batch.state !== 'available' ||
        batch.form !== 'cable' ||
        p.machine.status !== 'ready' ||
        p.machine.energy_mj < 500 ||
        p.jobs.some(live)
      )
        gameFail('NOT_READY');
      if (
        batch.observation_id !== p.deposit.observation ||
        !p.deposit.collected ||
        canonical(mass(batch)) !== canonical(mass(p.deposit))
      )
        gameFail('INSPECTION_REQUIRED');
      const plan = cablePlan(batch);
      batch.state = 'reserved';
      p.jobs.push({
        id: randomUUID(),
        machine_id: p.machine.id,
        input_batch_id: batch.id,
        recipe: 'strip-cable',
        recipe_version: 'dump-v1',
        state: 'running',
        pause_reason: null,
        cancellation_reason: null,
        duration_ms: plan.duration_ms,
        work_ms: 0,
        energy_mj: 0,
        last_tick_ms: Math.max(this.clock(), match.last_advanced_ms),
        outputs: plan.outputs,
      });
    } else if (['pause_job', 'resume_job', 'cancel_job'].includes(action)) {
      const job = p.jobs.find((j) => j.id === args.job_id);
      if (!job) gameFail('NOT_AVAILABLE');
      if (!live(job)) gameFail('NOT_READY');
      if (action === 'cancel_job') this.cancel(p, job, 'requested');
      else if (action === 'pause_job') {
        job.state = 'paused';
        job.pause_reason = 'requested';
      } else {
        if (job.state !== 'paused' || p.machine.status !== 'ready' || p.machine.energy_mj < 500)
          gameFail('NOT_READY');
        job.state = 'running';
        job.pause_reason = null;
        job.last_tick_ms = Math.max(this.clock(), match.last_advanced_ms);
      }
    } else if (action === 'dismantle_machine') {
      if (p.machine.id !== args.machine_id) gameFail('NOT_AVAILABLE');
      if (p.machine.status !== 'ready') gameFail('NOT_READY');
      for (const job of p.jobs) this.cancel(p, job, 'machine_destroyed');
      p.machine.status = 'destroyed';
      p.base.assets.find((a) => a.id === p.machine.id).status = 'destroyed';
      p.machine.dissipated_mj += p.machine.energy_mj;
      p.machine.energy_mj = 0;
    } else if (action === 'abandon_match') {
      for (const player of match.players)
        for (const job of player.jobs) this.cancel(player, job, 'match_abandoned');
      this.complete(match, 'abandoned');
    } else if (action === 'finish_recovery') {
      if (!p.jobs.some((j) => j.state === 'completed') || p.jobs.some(live)) gameFail('NOT_READY');
      p.base.ready_to_finish = true;
      if (match.players.every((player) => player.base.ready_to_finish))
        this.complete(match, 'recovery-complete');
    } else gameFail('INVALID_REQUEST');
  }
}
