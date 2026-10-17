import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GameDatabase, canonical } from "../server/game-sqlite.mjs";
/** Continuation of the real recovered-stock manufacturing chain, with no granted combat inventory. */
export function manufacturedCombat(h: any) {
	let { db } = h;
	const { path, now, token, other, id, launcher, read, act, tick, call, make } =
		h;
	act("start_combat");
	const target = (kind: string) =>
		read().combat.targets.find((t: any) => t.slot === 2 && t.kind === kind);
	const tower = target("tower").id,
		unit = () => read().units.units.find((u: any) => u.id === launcher.id);
	assert.equal(target("tower").health, 300);
	const request = {
		version: 5,
		command_id: randomUUID(),
		match_id: id,
		expected_revision: read().revision,
		action: "combat_order",
		unit_id: launcher.id,
		order: "attack",
		target_id: tower,
	};
	assert.throws(() => call("command", request, other), {
		code: "NOT_AVAILABLE",
	});
	assert.throws(
		() =>
			call("command", {
				...request,
				command_id: randomUUID(),
				target_id: randomUUID(),
			}),
		{ code: "INVALID_TARGET" },
	);
	assert.throws(
		() =>
			call("command", {
				...request,
				command_id: randomUUID(),
				order: "target",
			}),
		{ code: "COMBAT_RANGE" },
	);
	db.db.exec(
		"CREATE TRIGGER combat_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'combat-fault'); END",
	);
	const before = canonical(db.loadInstance(id));
	assert.throws(() => call("command", request));
	assert.equal(canonical(db.loadInstance(id)), before);
	db.db.exec("DROP TRIGGER combat_fault");
	const receipt = call("command", request);
	assert.equal(target("tower").health, 300);
	assert.equal(unit().ammunition_count, 2);
	const concurrent = new GameDatabase(path, { clock: now });
	try {
		assert.deepEqual(
			concurrent.dispatch(token, "astra.game_command", request),
			receipt,
		);
		assert.throws(
			() =>
				concurrent.dispatch(token, "astra.game_command", {
					...request,
					command_id: randomUUID(),
				}),
			{ code: "CONFLICT" },
		);
	} finally {
		concurrent.close();
	}
	tick(1000);
	assert.equal(unit().position.x, 48);
	assert.equal(target("tower").health, 300);
	// Every client is absent: only the file-backed worker and its persisted clock resolve the next steps.
	db.close();
	h.replaceDb(new GameDatabase(path, { clock: now }));
	db = h.getDb();
	tick(20000);
	assert.equal(target("tower").health, 200);
	assert.equal(unit().ammunition_count, 0);
	assert.deepEqual(call("command", request), receipt);
	assert.equal(target("tower").health, 200);
	const own = read(),
		opponent = call("read_match", { version: 5, match_id: id }, other).snapshot;
	assert(opponent.combat.targets.some((t: any) => t.id === launcher.id));
	for (const secret of [
		own.manufacturing.products.find((p: any) => p.kind === "steel-slug").id,
		own.science.components[0]?.id,
	].filter(Boolean))
		assert(!JSON.stringify(opponent).includes(secret));
	// Refill through the same real press; disable cancels the old firing order at its next boundary.
	act("set_unit_enabled", { unit_id: launcher.id, enabled: false });
	const reload = () => {
		for (let i = 0; i < 2; i++) {
			const ammo = make("steel-slug");
			act("load_unit_ammunition", {
				unit_id: launcher.id,
				ammunition_id: ammo.id,
			});
		}
		act("set_unit_enabled", { unit_id: launcher.id, enabled: true });
	};
	reload();
	act("combat_order", {
		unit_id: launcher.id,
		order: "attack",
		target_id: target("solar").id,
	});
	tick(60000);
	assert.equal(target("solar").health, 0);
	assert.equal(
		call("read_match", { version: 5, match_id: id }, other).snapshot.base.power
			.solar_w,
		0,
	);
	if (process.argv.includes("--victory")) {
		for (let wave = 0; wave < 2; wave++) {
			act("set_unit_enabled", { unit_id: launcher.id, enabled: false });
			reload();
			act("combat_order", {
				unit_id: launcher.id,
				order: "attack",
				target_id: tower,
			});
			tick(60000);
			assert.equal(target("tower").health, 100 - wave * 100);
		}
		const result = read().completion;
		assert.equal(read().status, "completed");
		assert.equal(result.winner_slot, 1);
		assert.equal(result.result_version, "victory-v1");
		assert.deepEqual(
			call("read_match", { version: 5, match_id: id }, other).snapshot
				.completion,
			result,
		);
		const physical = canonical(db.load(id).players);
		tick(180000);
		assert.equal(canonical(db.load(id).players), physical);
		assert.deepEqual(read().completion, result);
		assert.throws(() => act("abandon_match"), { code: "MATCH_INACTIVE" });
		assert.deepEqual(call("command", request), receipt);
		db.close();
		h.replaceDb(new GameDatabase(path, { clock: now }));
		db = h.getDb();
		assert.deepEqual(read().completion, result);
		db.transaction(() =>
			assert.deepEqual(db.history.replay(id).state, db.loadInstance(id)),
		);
		console.log(
			"PASS actual recovered stock -> manufactured launcher and ammunition -> authoritative tower destruction and victory; exact two-player result, frozen resources, post-match rejection, restart/history and immutable retry",
		);
		return;
	}
	// Capture neutral ground, then retreat home with the original chassis and remaining materials.
	const outpost = read().world.outposts[0];
	act("combat_order", {
		unit_id: launcher.id,
		order: "capture",
		target_id: outpost.id,
	});
	tick(90000);
	assert.equal(read().world.outposts[0].owner_slot, 1);
	act("combat_order", {
		unit_id: launcher.id,
		order: "retreat",
		target_id: null,
	});
	tick(120000);
	assert.equal(unit().enabled, false);
	assert.equal(
		read().combat.orders.find((o: any) => o.unit_id === launcher.id).state,
		"completed",
	);
	const salvage = {
		version: 5,
		command_id: randomUUID(),
		match_id: id,
		expected_revision: read().revision,
		action: "salvage_unit",
		unit_id: launcher.id,
	};
	const salvageReceipt = call("command", salvage);
	assert.equal(unit().state, "deployed");
	tick(1000);
	assert.equal(unit().state, "salvaged");
	const saved = db.loadInstance(id);
	assert.deepEqual(call("command", salvage), salvageReceipt);
	assert.deepEqual(db.loadInstance(id), saved);
	db.close();
	h.replaceDb(new GameDatabase(path, { clock: now }));
	db = h.getDb();
	assert.deepEqual(db.loadInstance(id), saved);
	db.transaction(() => assert.deepEqual(db.history.replay(id).state, saved));
	console.log(
		"PASS manufactured two-player combat: server movement, tower damage, metered ammunition, power disruption, capture, retreat, timed salvage, auth/ownership, stale and invalid targets, write rollback, competing connections, offline restart, private inventory and immutable retries",
	);
}
