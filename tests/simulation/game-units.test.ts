import Ajv from "ajv";
import { GameDatabase } from "../../server/game-sqlite.mjs";
import { gameSnapshotSchema } from "../../server/mcp-game-contract.mjs";
import { manufacturingPlan } from "../../server/game-manufacturing.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
	installUnit,
	assertUnits,
	damageUnit,
	unitProjection,
	commandUnit,
} from "../../server/game-units.mjs";
import { validateGameRequest } from "../../server/mcp-game-contract.mjs";

const fail = (code: string): never => {
	throw Error(code);
};
/** Minimal isolated lifecycle fixture; full SQLite tests manufacture from actual recovered stock. */
function fixture() {
	const output = {
		id: randomUUID(),
		kind: "sentry-turret",
		category: "defense",
		state: "installed",
		enabled: true,
		contents: { steel: 2000, copper: 100, hdpe: 200 },
		components: [],
	};
	const p: any = {
		slot: 1,
		production: { products: [output] },
		machine: { status: "ready", energy_mj: 2000000, dissipated_mj: 0 },
		base: {
			assets: [{ kind: "tower", position: { x: 8, y: 24 }, status: "ready" }],
		},
		jobs: [],
		batches: [],
		components: [],
	};
	installUnit(p, output);
	const match: any = {
		world: {
			width: 96,
			height: 56,
			obstacles: [],
			towers: [{ id: randomUUID(), slot: 2, position: { x: 88, y: 24 } }],
		},
		players: [p, { slot: 2, base: { assets: [] } }],
	};
	return { p, match, output, u: p.units[0] };
}

test("unit attachment and policy invariants reject duplicate magazines, forged positions and missing unit records", () => {
	const { p, u, output } = fixture();
	assertUnits(p, fail);
	p.unit_version = "other-policy";
	assert.throws(() => assertUnits(p, fail), /INVARIANT_FAILED/);
	p.unit_version = "units-v1";
	const ammo = { id: randomUUID(), kind: "steel-slug", state: "installed" };
	p.production.products.push(ammo);
	u.ammunition_ids = [ammo.id, ammo.id];
	assert.throws(() => assertUnits(p, fail), /INVARIANT_FAILED/);
	u.ammunition_ids = [];
	u.state = "deployed";
	u.position = { x: NaN, y: 24 };
	assert.throws(() => assertUnits(p, fail), /INVARIANT_FAILED/);
	p.units = undefined;
	assert.throws(() => assertUnits(p, fail), /INVARIANT_FAILED/);
	assert.equal(output.enabled, false);
});

test("supplied equipment never fires autonomously; shot budget and public range checks are explicit", () => {
	const { p, u, match } = fixture();
	commandUnit(
		match,
		p,
		{ action: "deploy_unit", unit_id: u.id, position: { x: 45, y: 24 } },
		1000,
		fail,
	);
	const ammo = { id: randomUUID(), kind: "steel-slug", state: "available" };
	p.production.products.push(ammo);
	commandUnit(
		match,
		p,
		{ action: "load_unit_ammunition", unit_id: u.id, ammunition_id: ammo.id },
		1000,
		fail,
	);
	commandUnit(
		match,
		p,
		{ action: "set_unit_enabled", unit_id: u.id, enabled: true },
		1000,
		fail,
	);
	const before = structuredClone(p),
		projected = unitProjection(match, p, 1000000);
	assert.equal(projected.units[0].operational_ready, true);
	assert.equal(projected.units[0].can_fire, false);
	assert.equal(projected.units[0].targets[0].eligible, false);
	assert.equal(projected.units[0].targets[0].reason, "out-of-range");
	assert.deepEqual(p, before);
	p.machine.energy_mj = 0;
	assert(
		unitProjection(match, p, 1000).units[0].blocked_reasons.includes(
			"insufficient-base-power",
		),
	);
	u.last_fired_ms = 1000;
	assert(
		unitProjection(match, p, 1500).units[0].blocked_reasons.includes(
			"cooldown",
		),
	);
	assert(
		!unitProjection(match, p, 3000).units[0].blocked_reasons.includes(
			"cooldown",
		),
	);
});

test("client requests cannot assign damage, health, loadouts, statistics or fractional placement", () => {
	const common = {
		version: 5,
		match_id: randomUUID(),
		command_id: randomUUID(),
		expected_revision: 1,
		unit_id: randomUUID(),
	};
	for (const args of [
		{ action: "damage_unit", damage: 10 },
		{ action: "set_unit_enabled", enabled: true, health: 160 },
		{
			action: "load_unit_ammunition",
			ammunition_id: randomUUID(),
			quantity: 100,
		},
		{ action: "deploy_unit", position: { x: 1.5, y: 24 } },
	])
		assert.throws(
			() => validateGameRequest("astra.game_command", { ...common, ...args }),
			{ code: "INVALID_REQUEST" },
		);
	const { p, u } = fixture();
	assert.throws(() => damageUnit(p, u.id, -1), /INVALID_UNIT_DAMAGE/);
	damageUnit(p, u.id, 1000);
	assert.equal(u.health, 0);
	damageUnit(p, u.id, 1000);
	assert.equal(u.health, 0);
	assertUnits(p, fail);
});

test("250 g ammunition stock is independent of the 1 kg bracket geometry and still requires exact paid steel evidence", () => {
	const { p } = fixture();
	const press = {
		id: randomUUID(),
		kind: "metal-press",
		state: "installed",
		enabled: true,
	};
	p.production.products.push(press);
	const b: any = {
		id: randomUUID(),
		state: "available",
		material: {
			massG: 250,
			inspection: "graded",
			grade: "game-steel-v1",
			condition: "sound",
			hazard: "none-detected",
			form: "stock",
			constituents: [{ material: "steel", massG: 250 }],
		},
	};
	p.batches.push(b);
	const args = {
		recipe_id: "steel-slug",
		batch_ids: [b.id],
		product_ids: [],
		component_ids: [],
	};
	assert.equal(manufacturingPlan(p, args).status, "eligible");
	for (const [key, bad] of [
		["grade", null],
		["inspection", "uninspected"],
		["hazard", "unknown"],
		["massG", 249],
		["form", "wire"],
		["condition", "damaged"],
	] as const) {
		const old = b.material[key];
		b.material[key] = bad;
		assert.equal(manufacturingPlan(p, args).status, "ineligible", key);
		b.material[key] = old;
	}
	b.material.constituents = [{ material: "aluminum", massG: 250 }];
	assert.equal(manufacturingPlan(p, args).status, "ineligible");
});

test("salvage returns ungraded lots that conform to the actual participant snapshot contract", () => {
	const db = new GameDatabase(":memory:", { clock: () => 1000 });
	try {
		const owner = randomUUID(),
			match = db.newMatch(owner, randomUUID());
		db.join(match, randomUUID());
		const p: any = match.players[0],
			output = {
				id: randomUUID(),
				kind: "sentry-turret",
				category: "defense",
				state: "installed",
				enabled: false,
				contents: { steel: 2000, copper: 100, hdpe: 200 },
				components: [],
				source_job_id: randomUUID(),
			};
		p.production = { version: "manufacturing-v1", products: [output] };
		installUnit(p, output);
		commandUnit(
			match,
			p,
			{ action: "salvage_unit", unit_id: output.id },
			1000,
			fail,
		);
		db.prepareState(match);
		const snapshot: any = db.snapshot(match, owner),
			validate = new Ajv({ strict: false }).compile(gameSnapshotSchema);
		assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
		assert(
			snapshot.batches.every((b: any) => b.grade === "recovered-ungraded"),
		);
		assert.equal(snapshot.units.units[0].state, "salvaged");
	} finally {
		db.close();
	}
});
