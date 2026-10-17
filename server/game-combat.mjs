import { unitProfiles, damageUnit, commandUnit } from "./game-units.mjs";
import { route, lineOfSight, stopRobot } from "./game-robots.mjs";
import { productionSolar } from "./game-manufacturing.mjs";

// Explicit game fixtures, not physical weapon, vehicle or material performance.
export const combatVersion = "combat-v1";
export const combatPolicy = Object.freeze({
	tick_ms: 1000,
	movement_energy_j: 30,
	capture_ms: 5000,
	salvage_ms: 1000,
	damage: { "sentry-turret": 25, "armored-turret": 25, "raid-launcher": 50 },
	health: {
		tower: 300,
		robot: 80,
		solar: 80,
		battery: 100,
		bench: 80,
		fabricator: 100,
		separator: 100,
		machine: 100,
		upgrade: 60,
		defense: 80,
		outpost: 100,
	},
});
const live = (u) => u.state === "deployed" && u.health > 0;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const home = (p) => p.base.assets.find((a) => a.kind === "tower").position;
const products = (p) => p.production?.products ?? [];
const health = (p, id, max, status) =>
	status === "destroyed" ? 0 : (p.combat_health?.[id] ?? max);
/** Public tactical information deliberately excludes inventories, evidence, cargo and routes. */
export function combatTargets(match) {
	const targets = [];
	for (const p of match.players) {
		for (const a of p.base.assets) {
			const r = p.robots.find((r) => r.id === a.id);
			if (r?.retired && a.status !== "destroyed") continue;
			const max = combatPolicy.health[a.kind];
			targets.push({
				id: a.id,
				slot: p.slot,
				kind: a.kind,
				position: r?.position ?? a.position,
				health: health(p, a.id, max, a.status),
				max_health: max,
			});
		}
		for (const a of products(p).filter((a) =>
			["installed", "destroyed"].includes(a.state),
		)) {
			const u = p.units?.find((u) => u.id === a.id),
				r = p.robots.find((r) => r.id === a.id);
			if (u && !u.position) continue;
			if (["part"].includes(a.category)) continue;
			const max = u
				? unitProfiles[u.kind].max_health
				: (combatPolicy.health[a.category] ?? 100);
			targets.push({
				id: a.id,
				slot: p.slot,
				kind: a.kind,
				position:
					u?.position ??
					r?.position ??
					p.base.assets.find((a) => a.kind === "fabricator").position,
				health: u ? u.health : health(p, a.id, max, a.state),
				max_health: max,
			});
		}
	}
	for (const o of match.world.outposts)
		targets.push({
			id: o.id,
			slot: o.owner_slot,
			kind: "outpost",
			position: o.position,
			health: o.health ?? 100,
			max_health: 100,
		});
	return targets;
}
export function inCombatRange(match, u, t) {
	if (!u.position || !t?.position) return false;
	const s = unitProfiles[u.kind],
		d = dist(u.position, t.position);
	return (
		d >= s.minimum_range_cells &&
		d <= s.range_cells &&
		lineOfSight(match.world, u.position, t.position)
	);
}
export function combatProjection(match, p) {
	if (!match.combat_version) return null;
	return {
		version: combatVersion,
		policy: structuredClone(combatPolicy),
		next_tick_ms: match.next_combat_ms,
		targets: combatTargets(match),
		orders: (p.combat_orders ?? []).map(
			({ ordered_at_ms, last_tick_ms, ...visible }) => structuredClone(visible),
		),
		events: structuredClone(match.combat_events ?? []),
	};
}
function orderFor(p, id) {
	return p.combat_orders?.find((o) => o.unit_id === id);
}
function spending(p, j) {
	if (p.machine.status !== "ready" || p.machine.energy_mj < j * 1000)
		return false;
	p.machine.energy_mj -= j * 1000;
	p.machine.dissipated_mj += j * 1000;
	return true;
}
function log(match, at, kind, unit, target) {
	match.combat_events.push({
		at_ms: at,
		kind,
		unit_id: unit ?? null,
		target_id: target ?? null,
	});
	if (match.combat_events.length > 32) match.combat_events.shift();
}
export function commandCombat(match, p, args, now, fail) {
	if (args.action === "start_combat") {
		if (match.combat_version) fail("NOT_READY");
		match.combat_version = combatVersion;
		match.next_combat_ms = null;
		match.combat_events = [];
		for (const own of match.players) {
			own.combat_orders = [];
			own.combat_health = {};
			own.base.ready_to_finish = false;
		}
		return;
	}
	if (!match.combat_version) fail("COMBAT_NOT_STARTED");
	const u = p.units?.find((u) => u.id === args.unit_id);
	if (!u) fail("NOT_AVAILABLE");
	const type = args.action === "salvage_unit" ? "salvage" : args.order;
	if (type === "salvage") {
		if (u.enabled || !["stowed", "deployed", "destroyed"].includes(u.state))
			fail("NOT_READY");
		if (
			u.position &&
			dist(u.position, home(p)) > 3 &&
			!p.robots.some((r) => !r.retired && dist(r.position, u.position) <= 2)
		)
			fail("COMBAT_SERVICE");
	} else {
		if (!live(u) || !u.enabled) fail("NOT_READY");
		if (["retreat", "capture"].includes(type) && u.kind !== "raid-launcher")
			fail("INVALID_TARGET");
		if (type === "retreat" && args.target_id !== null) fail("INVALID_TARGET");
		if (type === "defend" && args.target_id !== null) fail("INVALID_TARGET");
		if (["attack", "target", "capture"].includes(type)) {
			const t = combatTargets(match).find(
				(t) => t.id === args.target_id && t.health > 0,
			);
			if (
				!t ||
				t.slot === p.slot ||
				(type === "capture" ? t.kind !== "outpost" : t.slot === null)
			)
				fail("INVALID_TARGET");
			if (
				type === "target" ||
				(type === "attack" && u.kind !== "raid-launcher")
			)
				if (!inCombatRange(match, u, t)) fail("COMBAT_RANGE");
		}
	}
	p.combat_orders ??= [];
	const old = orderFor(p, u.id);
	if (old) p.combat_orders.splice(p.combat_orders.indexOf(old), 1);
	p.combat_orders.push({
		unit_id: u.id,
		order: type,
		target_id: args.target_id ?? null,
		state: "pending",
		reason: null,
		progress_ms: 0,
		ordered_at_ms: now,
		last_tick_ms: now,
	});
	match.next_combat_ms ??= now + combatPolicy.tick_ms;
	p.base.ready_to_finish = false;
}
function move(match, p, u, accepts) {
	// Occupied cells block movement; deterministic BFS chooses every step on the server.
	const blocked = combatTargets(match)
		.filter((t) => t.id !== u.id && t.kind !== "outpost" && t.health > 0)
		.map((t) => ({ x: t.position.x, y: t.position.y, width: 1, height: 1 }));
	const path = route(
		{ ...match.world, obstacles: [...match.world.obstacles, ...blocked] },
		u.position,
		accepts,
	);
	if (!path) return "route-blocked";
	if (!path.length) return null;
	if (!spending(p, combatPolicy.movement_energy_j))
		return "insufficient-base-power";
	u.position = { ...path[0] };
	return "moving";
}
function destroyTarget(match, t, policy, at) {
	if (t.kind === "outpost") {
		const o = match.world.outposts.find((o) => o.id === t.id);
		o.health = 0;
		o.owner_slot = null;
		return;
	}
	const p = match.players.find((p) => p.slot === t.slot),
		u = p.units?.find((u) => u.id === t.id);
	if (u) {
		damageUnit(p, t.id, u.health);
		return;
	}
	p.combat_health[t.id] = 0;
	const a = p.base.assets.find((a) => a.id === t.id),
		product = products(p).find((a) => a.id === t.id);
	if (a) a.status = "destroyed";
	if (product) {
		product.state = "destroyed";
		product.enabled = false;
	}
	const r = p.robots.find((r) => r.id === t.id);
	if (r) {
		stopRobot(match, p, r, "combat-destroyed");
		r.retired = true;
		r.spent_mj += r.energy_mj;
		r.energy_mj = 0;
	}
	// The battery/separator share one process circuit. Destroying either cuts it safely.
	if (t.id === p.machine.id || a?.kind === "battery") {
		p.machine.status = "destroyed";
		p.machine.dissipated_mj += p.machine.energy_mj;
		p.machine.energy_mj = 0;
	}
	for (const j of p.jobs.filter((j) =>
		["waiting", "running", "paused"].includes(j.state),
	)) {
		if (j.machine_id === t.id || p.machine.status !== "ready")
			policy.cancel(p, j, "machine_destroyed");
	}
	p.base.power.solar_w = productionSolar(p);
	log(match, at, "destroyed", null, t.id);
}
// Clock cursors and unchanged waits are durable progress, not a new gameplay revision.
const combatFingerprint = (match) =>
	JSON.stringify({
		units: match.players.map((p) => p.units ?? []),
		orders: match.players.map((p) =>
			(p.combat_orders ?? []).map(({ last_tick_ms, ...visible }) => visible),
		),
		outposts: match.world.outposts,
		events: match.combat_events,
	});
/** One bounded pulse. All shots are decided before any damage: equal-time fire is simultaneous. */
export function resolveCombat(match, at, policy) {
	if (
		!match.combat_version ||
		match.next_combat_ms === null ||
		at < match.next_combat_ms
	)
		return false;
	const before = combatFingerprint(match);
	const hits = new Map();
	let active = false;
	for (const p of match.players)
		for (const o of p.combat_orders ?? []) {
			if (["completed", "cancelled"].includes(o.state)) continue;
			const u = p.units?.find((u) => u.id === o.unit_id);
			const stop = (reason) => {
				o.state = "cancelled";
				o.reason = reason;
			};
			if (!u) {
				stop("unavailable");
				continue;
			}
			const elapsed = Math.min(combatPolicy.tick_ms, at - o.last_tick_ms);
			o.last_tick_ms = at;
			if (o.order === "salvage") {
				if (at < o.ordered_at_ms + combatPolicy.salvage_ms) {
					active = true;
					continue;
				}
				// Service position and inventory/power are revalidated at completion, never reserved twice.
				try {
					if (
						u.position &&
						dist(u.position, home(p)) > 3 &&
						!p.robots.some(
							(r) => !r.retired && dist(r.position, u.position) <= 2,
						)
					) {
						stop("service-robot-required");
						continue;
					}
					commandUnit(
						match,
						p,
						{ action: "salvage_unit", unit_id: u.id },
						at,
						(code) => {
							throw Error(code);
						},
					);
					o.state = "completed";
					log(match, at, "salvaged", u.id, u.id);
				} catch (e) {
					if (
						![
							"NOT_READY",
							"NOT_AVAILABLE",
							"LIMIT_REACHED",
							"UNIT_POWER",
						].includes(e.message)
					)
						throw e;
					stop(e.message);
				}
				continue;
			}
			if (!live(u) || !u.enabled) {
				stop("unit-disabled-or-destroyed");
				continue;
			}
			o.state = "running";
			o.reason = null;
			if (o.order === "retreat") {
				const result = move(match, p, u, (a) => dist(a, home(p)) <= 2);
				if (result) o.reason = result;
				if (!result || dist(u.position, home(p)) <= 2) {
					o.state = "completed";
					u.enabled = false;
					products(p).find((a) => a.id === u.id).enabled = false;
					log(match, at, "retreated", u.id, null);
				} else active = true;
				continue;
			}
			let targets = combatTargets(match);
			if (o.order === "capture") {
				const t = targets.find(
					(t) => t.id === o.target_id && t.kind === "outpost" && t.health > 0,
				);
				if (!t || t.slot === p.slot) {
					stop("target-unavailable");
					continue;
				}
				if (dist(u.position, t.position) > 1) {
					o.reason = move(match, p, u, (a) => dist(a, t.position) <= 1);
					o.progress_ms = 0;
				} else if (
					targets.some(
						(other) =>
							other.id !== t.id &&
							other.slot !== null &&
							other.slot !== p.slot &&
							other.health > 0 &&
							dist(other.position, t.position) <= 3,
					)
				) {
					o.reason = "contested";
					o.progress_ms = 0;
				} else {
					o.progress_ms = Math.min(
						combatPolicy.capture_ms,
						o.progress_ms + elapsed,
					);
					if (o.progress_ms >= combatPolicy.capture_ms) {
						match.world.outposts.find((t) => t.id === o.target_id).owner_slot =
							p.slot;
						o.state = "completed";
						log(match, at, "captured", u.id, o.target_id);
					}
				}
				active ||= o.state !== "completed";
				continue;
			}
			let t =
				o.order === "defend"
					? targets
							.filter(
								(t) =>
									t.slot !== null &&
									t.slot !== p.slot &&
									t.health > 0 &&
									inCombatRange(match, u, t),
							)
							.sort(
								(a, b) =>
									dist(u.position, a.position) - dist(u.position, b.position) ||
									a.id.localeCompare(b.id),
							)[0]
					: targets.find(
							(t) =>
								t.id === o.target_id &&
								t.slot !== p.slot &&
								t.slot !== null &&
								t.health > 0,
						);
			if (!t) {
				if (o.order === "defend") {
					o.reason = "no-target";
					active = true;
				} else stop("target-unavailable");
				continue;
			}
			if (!inCombatRange(match, u, t)) {
				if (o.order === "attack" && u.kind === "raid-launcher")
					o.reason = move(match, p, u, (a) =>
						inCombatRange(match, { ...u, position: a }, t),
					);
				else o.reason = "out-of-range";
				active = true;
				continue;
			}
			const spec = unitProfiles[u.kind];
			if (u.last_fired_ms !== null && at < u.last_fired_ms + spec.cooldown_ms)
				o.reason = "cooldown";
			else if (!u.ammunition_ids.length) o.reason = "load-steel-slug";
			else if (!spending(p, spec.shot_energy_j))
				o.reason = "insufficient-base-power";
			else {
				const ammoId = u.ammunition_ids.shift(),
					ammo = products(p).find((a) => a.id === ammoId);
				// Spent ammunition stays as an immutable destroyed product, preserving all mass.
				ammo.state = "destroyed";
				ammo.enabled = false;
				u.last_fired_ms = at;
				hits.set(t.id, {
					target: t,
					amount: (hits.get(t.id)?.amount ?? 0) + combatPolicy.damage[u.kind],
				});
				log(match, at, "shot", u.id, t.id);
			}
			active = true;
		}
	for (const { target: t, amount } of hits.values()) {
		const p = match.players.find((p) => p.slot === t.slot),
			u = p?.units?.find((u) => u.id === t.id);
		if (u) damageUnit(p, t.id, amount);
		else if (t.kind === "outpost")
			match.world.outposts.find((o) => o.id === t.id).health = Math.max(
				0,
				t.health - amount,
			);
		else p.combat_health[t.id] = Math.max(0, t.health - amount);
		if (t.health <= amount) destroyTarget(match, t, policy, at);
	}
	match.next_combat_ms = active ? at + combatPolicy.tick_ms : null;
	return combatFingerprint(match) !== before;
}
export function assertCombat(match, fail) {
	if (!match.combat_version) return;
	if (
		match.combat_version !== combatVersion ||
		match.combat_events.length > 32 ||
		!(
			match.next_combat_ms === null ||
			Number.isSafeInteger(match.next_combat_ms)
		)
	)
		fail("INVARIANT_FAILED");
	for (const p of match.players) {
		if (
			!p.combat_health ||
			!Array.isArray(p.combat_orders) ||
			p.combat_orders.length > 16 ||
			new Set(p.combat_orders.map((o) => o.unit_id)).size !==
				p.combat_orders.length
		)
			fail("INVARIANT_FAILED");
		for (const [id, n] of Object.entries(p.combat_health)) {
			const t = combatTargets(match).find(
				(t) => t.id === id && t.slot === p.slot,
			);
			if (!t || !Number.isSafeInteger(n) || n < 0 || n > t.max_health)
				fail("INVARIANT_FAILED");
		}
		for (const o of p.combat_orders)
			if (
				!p.units?.some((u) => u.id === o.unit_id) ||
				![
					"attack",
					"target",
					"defend",
					"retreat",
					"capture",
					"salvage",
				].includes(o.order) ||
				!["pending", "running", "completed", "cancelled"].includes(o.state) ||
				!Number.isSafeInteger(o.progress_ms) ||
				o.progress_ms < 0 ||
				o.progress_ms > combatPolicy.capture_ms ||
				!Number.isSafeInteger(o.ordered_at_ms) ||
				!Number.isSafeInteger(o.last_tick_ms) ||
				o.last_tick_ms < o.ordered_at_ms
			)
				fail("INVARIANT_FAILED");
	}
	for (const o of match.world.outposts)
		if (
			(o.health !== undefined &&
				(!Number.isSafeInteger(o.health) || o.health < 0 || o.health > 100)) ||
			![null, 1, 2].includes(o.owner_slot)
		)
			fail("INVARIANT_FAILED");
}
