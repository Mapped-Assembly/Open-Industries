import { combatTargets, inCombatRange } from "./game-combat.mjs";
import { randomUUID } from "node:crypto";

/** Bounded game-balance fixtures. These are not physical weapon performance claims. */
export const unitVersion = "units-v1";
export const unitProfiles = Object.freeze({
	"sentry-turret": {
		role: "defense",
		max_health: 100,
		range_cells: 16,
		minimum_range_cells: 0,
		cooldown_ms: 2000,
		shot_energy_j: 500,
		deployment_energy_j: 500,
		ammunition_capacity: 4,
		idle_power_w: 0,
		material_effect: "Eligible HDPE housing: 100 health, 500 J deployment.",
	},
	"armored-turret": {
		role: "defense",
		max_health: 140,
		range_cells: 16,
		minimum_range_cells: 0,
		cooldown_ms: 2000,
		shot_energy_j: 500,
		deployment_energy_j: 750,
		ammunition_capacity: 4,
		idle_power_w: 0,
		material_effect:
			"Eligible aluminum housing: 140 health, 750 J deployment; +40 health and +250 J versus HDPE.",
	},
	"raid-launcher": {
		role: "raider",
		max_health: 160,
		range_cells: 32,
		minimum_range_cells: 8,
		cooldown_ms: 5000,
		shot_energy_j: 1000,
		deployment_energy_j: 1000,
		ammunition_capacity: 2,
		idle_power_w: 0,
		material_effect:
			"Graded steel chassis and two recovered treads: 160 health; deployable raiding platform.",
	},
});
const products = (p) => p.production?.products ?? [];
const product = (p, id) => products(p).find((a) => a.id === id);
const units = (p) => p.units ?? [];
const profile = (u) => unitProfiles[u.kind];
const home = (p) => p.base.assets.find((a) => a.kind === "tower").position;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Newly manufactured platforms are stowed and disabled, with no ammunition or free power. */
export function installUnit(p, output) {
	const spec = unitProfiles[output.kind];
	if (!spec) return;
	p.unit_version = unitVersion;
	p.units ??= [];
	p.units.push({
		id: output.id,
		kind: output.kind,
		state: "stowed",
		enabled: false,
		position: null,
		health: spec.max_health,
		ammunition_ids: [],
		repair_product_ids: [],
		last_fired_ms: null,
	});
	output.enabled = false;
}
/** A cell must have a path to the home tower through public traversable terrain. */
function reachable(match, p, position) {
	const w = match.world,
		blocked = (x, y) =>
			w.obstacles.some(
				(o) => x >= o.x && x < o.x + o.width && y >= o.y && y < o.y + o.height,
			);
	if (
		!Number.isInteger(position.x) ||
		!Number.isInteger(position.y) ||
		position.x < 1 ||
		position.x >= w.width - 1 ||
		position.y < 1 ||
		position.y >= w.height - 1 ||
		blocked(position.x, position.y)
	)
		return false;
	// Home-side commissioning only; combat movement and contested deployment belong to the combat policy.
	if (p.slot === 1 ? position.x >= 48 : position.x <= 48) return false;
	const origin = home(p),
		queue = [origin],
		seen = new Set([`${origin.x},${origin.y}`]);
	for (let i = 0; i < queue.length; i++) {
		const a = queue[i];
		if (a.x === position.x && a.y === position.y) return true;
		for (const [dx, dy] of [
			[1, 0],
			[-1, 0],
			[0, 1],
			[0, -1],
		]) {
			const x = a.x + dx,
				y = a.y + dy,
				key = `${x},${y}`;
			if (
				x < 1 ||
				x >= w.width - 1 ||
				y < 1 ||
				y >= w.height - 1 ||
				blocked(x, y) ||
				seen.has(key)
			)
				continue;
			seen.add(key);
			queue.push({ x, y });
		}
	}
	return false;
}
const spend = (p, joules, fail) => {
	if (p.machine.status !== "ready" || p.machine.energy_mj < joules * 1000)
		fail("UNIT_POWER");
	p.machine.energy_mj -= joules * 1000;
	p.machine.dissipated_mj += joules * 1000;
};
/** Owner-only lifecycle transitions execute inside the existing versioned SQLite transaction. */
export function commandUnit(match, p, args, now, fail) {
	const u = units(p).find((u) => u.id === args.unit_id),
		a = u && product(p, u.id);
	if (!u || !a || u.state === "salvaged") fail("NOT_AVAILABLE");
	const spec = profile(u);
	if (args.action === "deploy_unit") {
		if (u.state !== "stowed" || a.state !== "installed") fail("NOT_READY");
		if (
			!reachable(match, p, args.position) ||
			match.players.some(
				(own) =>
					own.base.assets.some(
						(a) =>
							a.status !== "destroyed" &&
							distance(a.position, args.position) < 1,
					) ||
					units(own).some(
						(other) =>
							other.state === "deployed" &&
							distance(other.position, args.position) < 1,
					),
			)
		)
			fail("UNIT_SITE");
		spend(p, spec.deployment_energy_j, fail);
		u.position = { ...args.position };
		u.state = "deployed";
	} else if (args.action === "set_unit_enabled") {
		if (u.state !== "deployed" || !u.health) fail("NOT_READY");
		u.enabled = args.enabled;
		a.enabled = args.enabled;
	} else if (args.action === "load_unit_ammunition") {
		if (
			u.enabled ||
			!["stowed", "deployed"].includes(u.state) ||
			u.ammunition_ids.length >= spec.ammunition_capacity
		)
			fail("NOT_READY");
		const ammo = product(p, args.ammunition_id);
		if (!ammo || ammo.kind !== "steel-slug" || ammo.state !== "available")
			fail("NOT_AVAILABLE");
		ammo.state = "installed";
		ammo.enabled = false;
		u.ammunition_ids.push(ammo.id);
	} else if (args.action === "repair_unit") {
		if (
			u.enabled ||
			!["stowed", "deployed"].includes(u.state) ||
			u.health <= 0 ||
			u.health === spec.max_health ||
			u.repair_product_ids.length >= 4
		)
			fail("NOT_READY");
		const patch = product(p, args.product_id);
		if (!patch || patch.kind !== "steel-bracket" || patch.state !== "available")
			fail("NOT_AVAILABLE");
		spend(p, 500, fail);
		patch.state = "installed";
		patch.enabled = false;
		u.repair_product_ids.push(patch.id);
		u.health = Math.min(spec.max_health, u.health + 40);
	} else if (args.action === "salvage_unit") {
		if (
			u.enabled ||
			!["stowed", "deployed", "destroyed"].includes(u.state) ||
			p.jobs.some((j) => ["waiting", "running", "paused"].includes(j.state))
		)
			fail("NOT_READY");
		const entries = Object.entries(a.contents).filter(([, g]) => g > 0);
		if (
			p.batches.length + entries.length > 512 ||
			p.components.length + a.components.length > 128 ||
			products(p).filter((a) => a.state === "available").length +
				u.ammunition_ids.length +
				u.repair_product_ids.length >
				16
		)
			fail("LIMIT_REACHED");
		spend(p, 300, fail);
		for (const [material, mass] of entries)
			p.batches.push({
				id: randomUUID(),
				form:
					material === "copper"
						? "wire"
						: material === "rubber"
							? "tread"
							: material === "glass"
								? "granulate"
								: "stock",
				state: "available",
				contents: { [material]: mass },
				copper_g: material === "copper" ? mass : 0,
				hdpe_g: material === "hdpe" ? mass : 0,
				dirt_g: 0,
				field_collected: true,
				observation_id: null,
				source_job_id: null,
				output_role: "usable",
				grade: "recovered-ungraded",
				hazard_truth: "none-detected",
				manufacturing_stock_rule: "manufacturing-v1",
				salvaged_from: a.id,
			});
		for (const c of a.components)
			p.components.push({
				id: randomUUID(),
				owner: p.owner,
				location: "store",
				kind: c.kind,
				quantity: c.quantity,
				unitMassG: c.unit_mass_g,
				condition: "unknown",
				tested: false,
				compatibleAssemblies: [],
				allocation: "component-only",
				revision: 1,
			});
		for (const id of [...u.ammunition_ids, ...u.repair_product_ids]) {
			const item = product(p, id);
			item.state = "available";
			item.enabled = true;
		}
		u.ammunition_ids = [];
		u.repair_product_ids = [];
		u.state = "salvaged";
		u.position = null;
		u.health = 0;
		a.state = "consumed";
		a.enabled = false;
		p.base.inventory = p.components.map((c) => ({
			kind: c.kind,
			quantity: c.quantity,
			unit_mass_g: c.unitMassG,
		}));
	} else fail("INVALID_REQUEST");
	p.base.ready_to_finish = false;
}
/** Trusted damage hook for the later combat resolver; clients cannot supply damage or health. */
export function damageUnit(p, id, amount) {
	const u = units(p).find((u) => u.id === id);
	if (!u || !Number.isSafeInteger(amount) || amount < 0)
		throw Error("INVALID_UNIT_DAMAGE");
	if (["destroyed", "salvaged"].includes(u.state)) return;
	u.health = Math.max(0, u.health - amount);
	if (!u.health) {
		u.state = "destroyed";
		u.enabled = false;
		const a = product(p, id);
		a.state = "destroyed";
		a.enabled = false;
	}
}
/** Projection never walks opponent inventories, positions or loadouts. Public towers are target candidates only. */
export function unitProjection(match, p, now) {
	return {
		version: unitVersion,
		profiles: structuredClone(unitProfiles),
		combat_available: !!match.combat_version,
		units: units(p).map((u) => {
			const spec = profile(u),
				reasons = [];
			if(match.status==='completed')reasons.push('match-completed');
			if (u.state !== "deployed")
				reasons.push(u.state === "destroyed" ? "destroyed" : "deploy-first");
			if (!u.enabled) reasons.push("enable-unit");
			if (!u.ammunition_ids.length) reasons.push("load-steel-slug");
			if (
				p.machine.status !== "ready" ||
				p.machine.energy_mj < spec.shot_energy_j * 1000
			)
				reasons.push("insufficient-base-power");
			if (u.last_fired_ms !== null && now < u.last_fired_ms + spec.cooldown_ms)
				reasons.push("cooldown");
			const candidates = match.combat_version
				? combatTargets(match).filter(
						(t) => t.slot !== null && t.slot !== p.slot && t.health > 0,
					)
				: match.world.towers;
			const targets = candidates
				.filter(
					(t) =>
						t.slot !== p.slot && match.players.some((p) => p.slot === t.slot),
				)
				.sort(
					(a, b) =>
						(u.position
							? distance(u.position, a.position) -
								distance(u.position, b.position)
							: 0) || a.id.localeCompare(b.id),
				)
				.slice(0, 16)
				.map((t) => {
					const d = u.position ? distance(u.position, t.position) : null;
					return {
						id: t.id,
						kind: t.kind ?? "tower",
						distance_cells: d,
						in_range:
							d !== null &&
							d >= spec.minimum_range_cells &&
							d <= spec.range_cells,
						eligible:
							!!match.combat_version &&
							!reasons.length &&
							inCombatRange(match, u, t),
						reason:
							d === null
								? "deploy-first"
								: d < spec.minimum_range_cells || d > spec.range_cells
									? "out-of-range"
									: match.combat_version
										? inCombatRange(match, u, t)
											? "in-range"
											: "line-of-sight-blocked"
										: "combat-not-started",
					};
				});
			return {
				...u,
				ammunition_count: u.ammunition_ids.length,
				ammunition_capacity: spec.ammunition_capacity,
				operational_ready: !reasons.length,
				can_fire:
					!!match.combat_version &&
					!reasons.length &&
					targets.some((t) => t.eligible),
				blocked_reasons: [
					...reasons,
					...(!match.combat_version ? ["combat-not-started"] : []),
				],
				targets,
			};
		}),
	};
}
/** Check attachment uniqueness, finite health, product state and the immutable policy pin. */
export function assertUnits(p, fail) {
	if (!p.units) {
		if (products(p).some((a) => unitProfiles[a.kind])) fail("INVARIANT_FAILED");
		return;
	}
	if (p.unit_version !== unitVersion || p.units.length > 16)
		fail("INVARIANT_FAILED");
	const held = new Set(),
		ids = new Set();
	for (const u of p.units) {
		const spec = profile(u),
			a = product(p, u.id);
		if (
			!spec ||
			ids.has(u.id) ||
			!a ||
			a.kind !== u.kind ||
			a.category !== "defense" ||
			!["stowed", "deployed", "destroyed", "salvaged"].includes(u.state) ||
			!Number.isSafeInteger(u.health) ||
			u.health < 0 ||
			u.health > spec.max_health ||
			u.ammunition_ids.length > spec.ammunition_capacity ||
			u.repair_product_ids.length > 4 ||
			u.enabled !== a.enabled ||
			(u.enabled && u.state !== "deployed") ||
			(u.state === "deployed" &&
				(!u.position ||
					!Number.isInteger(u.position.x) ||
					!Number.isInteger(u.position.y) ||
					u.position.x < 1 ||
					u.position.x > 94 ||
					u.position.y < 1 ||
					u.position.y > 54)) ||
			(u.state === "destroyed" &&
				(a.state !== "destroyed" || u.health !== 0)) ||
			(u.state === "salvaged" &&
				(a.state !== "consumed" ||
					u.ammunition_ids.length ||
					u.repair_product_ids.length)) ||
			(["stowed", "deployed"].includes(u.state) &&
				(a.state !== "installed" || u.health <= 0))
		)
			fail("INVARIANT_FAILED");
		ids.add(u.id);
		for (const [list, kind] of [
			[u.ammunition_ids, "steel-slug"],
			[u.repair_product_ids, "steel-bracket"],
		])
			for (const id of list) {
				const part = product(p, id);
				if (
					held.has(id) ||
					!part ||
					part.kind !== kind ||
					!["installed", "destroyed"].includes(part.state)
				)
					fail("INVARIANT_FAILED");
				held.add(id);
			}
	}
	for (const a of products(p))
		if (unitProfiles[a.kind] && !ids.has(a.id)) fail("INVARIANT_FAILED");
}
