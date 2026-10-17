import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { GameDatabase } from "../../server/game-sqlite.mjs";
import {
	commandCombat,
	resolveCombat,
	combatTargets,
	assertCombat,
} from "../../server/game-combat.mjs";
import { installUnit, assertUnits } from "../../server/game-units.mjs";
import {
	validateGameRequest,
	gameSnapshotSchema,
} from "../../server/mcp-game-contract.mjs";
import Ajv from "ajv";
import {
	packGame,
	advanceGame,
	nativeGame,
} from "../../server/domains/game-core.mjs";
const fail = (c: string): never => {
	throw Error(c);
};
/** Isolated combat fixtures; the dedicated --combat integration manufactures actual stock. */
function fixture() {
	const db = new GameDatabase(":memory:", { clock: () => 1000 });
	const match: any = db.newMatch(randomUUID(), randomUUID());
	db.join(match, randomUUID());
	const [a, b] = match.players;
	commandCombat(match, a, { action: "start_combat" }, 1000, fail);
	const make = (
		p: any,
		kind = "raid-launcher",
		position = { x: 47, y: 24 },
	) => {
		const product = {
			id: randomUUID(),
			kind,
			category: "defense",
			state: "installed",
			enabled: false,
			contents: {},
			components: [],
			source_job_id: randomUUID(),
		};
		p.production ??= { version: "manufacturing-v1", products: [] };
		p.production.products.push(product);
		installUnit(p, product);
		const u = p.units.at(-1);
		u.state = "deployed";
		u.position = position;
		u.enabled = true;
		product.enabled = true;
		for (let i = 0; i < 2; i++) {
			const ammo = {
				id: randomUUID(),
				kind: "steel-slug",
				category: "part",
				state: "installed",
				enabled: false,
				contents: {},
				components: [],
				source_job_id: randomUUID(),
			};
			p.production.products.push(ammo);
			u.ammunition_ids.push(ammo.id);
		}
		return u;
	};
	const order = (p: any, u: any, type: string, target: any = null) =>
		commandCombat(
			match,
			p,
			{ action: "combat_order", unit_id: u.id, order: type, target_id: target },
			1000,
			fail,
		);
	const tick = (at: number) => resolveCombat(match, at, db);
	return { db, match, a, b, make, order, tick };
}
test("orders validate ownership, live targets, stationary range and payloads without immediate damage", () => {
	const { db, match, a, b, make, order } = fixture();
	try {
		const u = make(a),
			tower = match.world.towers.find((t: any) => t.slot === 2).id;
		assert.throws(() => order(b, u, "attack", tower), /NOT_AVAILABLE/);
		assert.throws(() => order(a, u, "target", tower), /COMBAT_RANGE/);
		assert.throws(() => order(a, u, "attack", randomUUID()), /INVALID_TARGET/);
		assert.throws(
			() => order(a, u, "attack", a.base.assets[0].id),
			/INVALID_TARGET/,
		);
		const before = structuredClone(b);
		order(a, u, "attack", tower);
		assert.deepEqual(b, before);
		assert.equal(u.ammunition_ids.length, 2);
		const common = {
			version: 5,
			command_id: randomUUID(),
			match_id: match.id,
			expected_revision: 1,
			action: "combat_order",
			unit_id: u.id,
			order: "attack",
			target_id: tower,
		};
		for (const patch of [
			{ damage: 999 },
			{ health: 0 },
			{ path: [] },
			{ slot: 2 },
			{ order: "fire" },
		])
			assert.throws(
				() =>
					validateGameRequest("astra.game_command", { ...common, ...patch }),
				{ code: "INVALID_REQUEST" },
			);
	} finally {
		db.close();
	}
});
test("server movement, line of sight, cooldown, ammunition and energy are deterministic across frequent and sparse pulses", () => {
	const f = fixture();
	try {
		const u = f.make(f.a),
			tower = f.match.world.towers.find((t: any) => t.slot === 2).id;
		f.order(f.a, u, "attack", tower);
		const start = f.a.machine.energy_mj;
		assert.equal(f.tick(1999), false);
		assert.deepEqual(u.position, { x: 47, y: 24 });
		f.tick(2000);
		assert.deepEqual(u.position, { x: 48, y: 24 });
		assert.equal(start - f.a.machine.energy_mj, 30000);
		for (let at = 3000; at <= 20000; at += 1000) f.tick(at);
		assert.equal(
			combatTargets(f.match).find((t) => t.id === tower)!.health,
			200,
		);
		assert.equal(u.ammunition_ids.length, 0);
		assert.equal(
			f.a.production.products.filter(
				(p: any) => p.kind === "steel-slug" && p.state === "destroyed",
			).length,
			2,
		);
		assert.equal(u.last_fired_ms, 16000); // 10 cells movement, first shot at 11 s, second at 16 s.
		assertUnits(f.a, fail);
		assertCombat(f.match, fail);
		assert.equal(
			new Ajv({ strict: false }).compile(gameSnapshotSchema)(
				f.db.snapshot(f.match, f.a.owner),
			),
			true,
		);
	} finally {
		f.db.close();
	}
});
test("equal-time shots are simultaneous and destroyed units never fire again", () => {
	const f = fixture();
	try {
		const x = f.make(f.a, "sentry-turret", { x: 46, y: 24 }),
			y = f.make(f.b, "sentry-turret", { x: 50, y: 24 });
		x.health = 25;
		y.health = 25;
		f.order(f.a, x, "target", y.id);
		f.order(f.b, y, "target", x.id);
		f.tick(2000);
		assert.equal(x.state, "destroyed");
		assert.equal(y.state, "destroyed");
		assert.equal(x.ammunition_ids.length, 1);
		assert.equal(y.ammunition_ids.length, 1);
		f.tick(3000);
		assert.equal(x.ammunition_ids.length, 1);
		assert.equal(y.ammunition_ids.length, 1);
		assertUnits(f.a, fail);
		assertUnits(f.b, fail);
	} finally {
		f.db.close();
	}
});
test("damage interrupts live hauler reservations, power generation, bench work, and manufactured machines while preserving stock", () => {
	for (const kind of [
		"robot",
		"solar",
		"battery",
		"bench",
		"separator",
		"fabricator",
	]) {
		const f = fixture();
		try {
			const asset = f.b.base.assets.find((a: any) => a.kind === kind),
				u = f.make(f.a, "raid-launcher", { x: 60, y: 24 });
			// Put the isolated gun in a valid firing cell for each declared asset.
			u.position = { x: asset.position.x - 10, y: asset.position.y };
			if (kind === "robot") {
				const robot = f.b.robots.find((r: any) => r.id === asset.id),
					d = f.match.world.deposits[0],
					stock = { ...d.stock.remaining };
				const material = Object.keys(d.stock.remaining)[0];
				d.stock.remaining[material] -= 100;
				const j = {
					id: randomUUID(),
					robot_id: robot.id,
					state: "running",
					reserved: { contents: { [material]: 100 } },
					target_id: d.id,
				};
				f.b.robot_jobs.push(j);
				robot.job_id = j.id;
				f.order(f.a, u, "target", asset.id);
				f.tick(2000);
				f.tick(7000);
				assert.equal(robot.retired, true);
				assert.equal(j.state, "cancelled");
				assert.deepEqual(
					Object.fromEntries(
						Object.entries(d.stock.remaining).filter(([, n]) => n),
					),
					stock,
				);
				assert.equal(robot.energy_mj, 0);
			} else {
				if (kind === "bench") {
					const batch = { id: randomUUID(), state: "reserved" };
					f.b.batches.push(batch);
					f.b.jobs.push({
						id: randomUUID(),
						input_batch_id: batch.id,
						machine_id: asset.id,
						kind: "batch-inspection",
						state: "running",
					});
				}
				f.order(f.a, u, "target", asset.id);
				f.tick(2000);
				f.tick(7000);
				assert.equal(asset.status, "destroyed", kind);
				if (kind === "solar") assert.equal(f.b.base.power.solar_w, 0);
				if (kind === "battery" || kind === "separator")
					assert.equal(f.b.machine.status, "destroyed");
				if (kind === "bench") assert.equal(f.b.jobs[0].state, "cancelled");
			}
		} finally {
			f.db.close();
		}
	}
});
test("capture takes travel plus five uncontested ticks; retreat is paid movement and cancels fire", () => {
	const f = fixture();
	try {
		const u = f.make(f.a, "raid-launcher", { x: 48, y: 12 }),
			post = f.match.world.outposts[0];
		f.order(f.a, u, "capture", post.id);
		f.tick(2000);
		assert.equal(post.owner_slot, null);
		const enemy = f.make(f.b, "sentry-turret", { x: 50, y: 10 });
		f.tick(3000);
		assert.equal(f.a.combat_orders[0].reason, "contested");
		assert.equal(f.a.combat_orders[0].progress_ms, 0);
		enemy.position = { x: 80, y: 45 };
		for (let at = 4000; at <= 8000; at += 1000) f.tick(at);
		assert.equal(post.owner_slot, 1);
		assert.equal(f.a.combat_orders[0].state, "completed");
		f.order(f.a, u, "retreat");
		for (let at = 9000; at <= 90000; at += 1000) f.tick(at);
		assert.equal(u.enabled, false);
		assert(Math.hypot(u.position.x - 8, u.position.y - 24) <= 2);
		assert.equal(u.ammunition_ids.length, 2);
	} finally {
		f.db.close();
	}
});
test("salvage waits for server clock and revalidates service position and supplies exactly once", () => {
	const f = fixture();
	try {
		const u = f.make(f.a, "raid-launcher", { x: 9, y: 24 });
		u.enabled = false;
		f.a.production.products.find((a: any) => a.id === u.id).enabled = false;
		commandCombat(
			f.match,
			f.a,
			{ action: "salvage_unit", unit_id: u.id },
			1000,
			fail,
		);
		assert.equal(u.state, "deployed");
		f.tick(1999);
		assert.equal(u.state, "deployed");
		f.tick(2000);
		assert.equal(u.state, "salvaged");
		const after = structuredClone(f.a);
		f.tick(3000);
		assert.deepEqual(f.a, after);
		assertUnits(f.a, fail);
	} finally {
		f.db.close();
	}
});

test("shared durable clock catches up sparse ticks exactly like frequent ticks and cannot replay damage", () => {
	const f = fixture();
	try {
		const u = f.make(f.a),
			tower = f.match.world.towers.find((t: any) => t.slot === 2).id;
		f.order(f.a, u, "attack", tower);
		let frequent = packGame(f.match);
		const original = structuredClone(frequent);
		for (let at = 2000; at <= 21000; at += 1000)
			frequent = advanceGame(frequent, at);
		const sparse = advanceGame(original, 21000),
			a = nativeGame(frequent),
			b = nativeGame(sparse);
		assert.deepEqual(a.players, b.players);
		assert.deepEqual(a.combat_events, b.combat_events);
		assert.equal(a.next_combat_ms, b.next_combat_ms);
		assert.equal(combatTargets(b).find((t) => t.id === tower)!.health, 200);
		assert.deepEqual(advanceGame(sparse, 21000), sparse);
	} finally {
		f.db.close();
	}
});
test("manufactured processors, upgrades and passive defenses are valid destructible tactical targets", () => {
	for (const [kind, category] of [
		["metal-press", "machine"],
		["solar-reflector", "upgrade"],
		["scrap-barricade", "defense"],
	]) {
		const f = fixture();
		try {
			const target = {
				id: randomUUID(),
				kind,
				category,
				state: "installed",
				enabled: true,
				contents: {},
				components: [],
				source_job_id: randomUUID(),
			};
			f.b.production = { version: "manufacturing-v1", products: [target] };
			const u = f.make(f.a, "raid-launcher", { x: 70, y: 20 });
			f.order(f.a, u, "target", target.id);
			f.tick(2000);
			f.tick(7000);
			assert.equal(target.state, "destroyed");
			assert.equal(target.enabled, false);
		} finally {
			f.db.close();
		}
	}
});

test("minimum range, walls, power starvation and a destroyed outpost prevent invalid effects", () => {
	const f = fixture();
	try {
		const u = f.make(f.a, "raid-launcher", { x: 48, y: 10 }),
			post = f.match.world.outposts[0];
		post.owner_slot = 2;
		assert.throws(() => f.order(f.a, u, "target", post.id), /COMBAT_RANGE/);
		u.position = { x: 46, y: 10 };
		f.match.world.obstacles.push({
			id: randomUUID(),
			kind: "scrap-wall",
			x: 47,
			y: 1,
			width: 1,
			height: 54,
		});
		const target = f.b.base.assets.find((a: any) => a.kind === "tower");
		u.position = { x: 60, y: 24 };
		f.match.world.obstacles.push({
			id: randomUUID(),
			kind: "scrap-wall",
			x: 70,
			y: 1,
			width: 1,
			height: 54,
		});
		assert.throws(() => f.order(f.a, u, "target", target.id), /COMBAT_RANGE/);
		f.match.world.obstacles = [];
		f.order(f.a, u, "target", target.id);
		f.a.machine.energy_mj = 0;
		f.tick(2000);
		assert.equal(u.ammunition_ids.length, 2);
		assert.equal(f.a.combat_orders[0].reason, "insufficient-base-power");
		post.health = 0;
		assert.throws(() => f.order(f.a, u, "capture", post.id), /INVALID_TARGET/);
	} finally {
		f.db.close();
	}
});

test("orders cannot earn salvage or capture time before their admission between existing pulses", () => {
	const f = fixture();
	try {
		const guard = f.make(f.a, "sentry-turret", { x: 20, y: 24 });
		f.order(f.a, guard, "defend");
		const u = f.make(f.a, "raid-launcher", { x: 9, y: 24 });
		u.enabled = false;
		f.a.production.products.find((p: any) => p.id === u.id).enabled = false;
		commandCombat(
			f.match,
			f.a,
			{ action: "salvage_unit", unit_id: u.id },
			1500,
			fail,
		);
		f.tick(2000);
		assert.equal(u.state, "deployed");
		f.tick(3000);
		assert.equal(u.state, "salvaged");
		const raider = f.make(f.b, "raid-launcher", { x: 48, y: 11 }),
			post = f.match.world.outposts[0];
		commandCombat(
			f.match,
			f.b,
			{
				action: "combat_order",
				unit_id: raider.id,
				order: "capture",
				target_id: post.id,
			},
			3500,
			fail,
		);
		for (let at = 4000; at <= 8000; at += 1000) f.tick(at);
		assert.equal(post.owner_slot, null);
		assert.equal(f.b.combat_orders[0].progress_ms, 4500);
		f.tick(9000);
		assert.equal(post.owner_slot, 2);
	} finally {
		f.db.close();
	}
});
test("remote salvage requires a surviving service robot and rechecks its position on the completion tick", () => {
	const f = fixture();
	try {
		const u = f.make(f.a);
		u.enabled = false;
		f.a.production.products.find((p: any) => p.id === u.id).enabled = false;
		assert.throws(
			() =>
				commandCombat(
					f.match,
					f.a,
					{ action: "salvage_unit", unit_id: u.id },
					1000,
					fail,
				),
			/COMBAT_SERVICE/,
		);
		const r = f.a.robots[0];
		r.position = { x: 46, y: 24 };
		commandCombat(
			f.match,
			f.a,
			{ action: "salvage_unit", unit_id: u.id },
			1000,
			fail,
		);
		r.position = { x: 40, y: 24 };
		f.tick(2000);
		assert.equal(u.state, "deployed");
		assert.equal(f.a.combat_orders[0].reason, "service-robot-required");
		r.position = { x: 46, y: 24 };
		commandCombat(
			f.match,
			f.a,
			{ action: "salvage_unit", unit_id: u.id },
			2000,
			fail,
		);
		f.tick(3000);
		assert.equal(u.state, "salvaged");
	} finally {
		f.db.close();
	}
});
