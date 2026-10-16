import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { damageUnit, unitProfiles } from "../server/game-units.mjs";
import { GameDatabase, canonical } from "../server/game-sqlite.mjs";

const dir = await mkdtemp(join(tmpdir(), "oi-manufacturing-")),
	path = join(dir, "game.sqlite");
let now = 1000000,
	db = new GameDatabase(path, { clock: () => now });
try {
	db.tick();
	const a = (
			await db.authenticate(
				{ username: "alice", password: "manufacturing-password" },
				true,
			)
		).token,
		b = (
			await db.authenticate(
				{ username: "bobby", password: "manufacturing-password" },
				true,
			)
		).token;
	const command = () => ({ version: 5, command_id: randomUUID() }),
		call = (name: string, args: object, token = a) =>
			db.dispatch(token, "astra.game_" + name, args);
	const created = call("create_match", command()),
		id = created.snapshot.match_id;
	call(
		"join_match",
		{ ...command(), match_id: id, invite_code: created.invite_code },
		b,
	);
	const read = () => call("read_match", { version: 5, match_id: id }).snapshot,
		act = (action: string, fields: object = {}) =>
			call("command", {
				...command(),
				match_id: id,
				expected_revision: read().revision,
				action,
				...fields,
			}),
		tick = (ms: number) => {
			now += ms;
			db.tick();
		};
	const collect = async (kind: string, recipe: string) => {
		const robot = read().field.robots[0].id,
			target = read().world.deposits.find(
				(d: any) => d.kind === kind && d.home_slot === 1,
			).id;
		act("recharge_robot", { robot_id: robot });
		tick(180000);
		act("survey_robot", {
			robot_id: robot,
			deposit_id: target,
			sensor: "camera-depth",
		});
		tick(60000);
		const observation = read().field.observations.findLast(
			(o: any) => o.target_id === target,
		).id;
		act("collect_robot", {
			robot_id: robot,
			deposit_id: target,
			observation_id: observation,
			material_class: "unclassified",
		});
		tick(60000);
		const input = read().batches.findLast(
			(v: any) => v.source_job_id === null && v.state === "available",
		).id;
		act("inspect_batch", { batch_id: input });
		tick(3000);
		act("start_material_process", {
			batch_id: input,
			machine_id: read().machines[0].id,
			recipe_id: recipe,
		});
		tick(30000);
		const job = read().jobs.at(-1).id,
			usable = read().batches.find(
				(v: any) =>
					v.source_job_id === job &&
					["usable", "conductor", "insulation"].includes(v.output_role),
			);
		assert(usable);
		for (const output of read().batches.filter(
			(v: any) => v.source_job_id === job && v.output_role !== "residue",
		)) {
			act("inspect_batch", { batch_id: output.id });
			tick(3000);
		}
		console.log("PASS collected/processed", kind);
	};
	await collect("construction", "bench-recover-steel");
	await collect("construction", "bench-recover-steel");
	await collect("cable", "strip-cable");
	await collect("packaging", "bench-trim-hdpe");
	await collect("glass", "bench-sort-glass");
	await collect("tire", "bench-cut-tire");
	await collect("appliance", "isolate-appliance");
	await collect("vehicle", "isolate-vehicle");
	const catalog = call("manufacturing_catalog", {
		version: 5,
		match_id: id,
	}).catalog;
	const selection = (recipe: string) => {
		const r = catalog.recipes.find((r: any) => r.id === recipe),
			s = read();
		const batch_ids = r.materials
			.map(
				(m: any) =>
					s.science.batches
						.toSorted(
							(a: any, b: any) =>
								(a.evidence.massG ?? Infinity) - (b.evidence.massG ?? Infinity),
						)
						.find((b: any) => {
							const raw = s.batches.find((v: any) => v.id === b.id);
							return (
								raw?.state === "available" &&
								b.evidence.grade ===
									`game-${m.use === "copper-conductor" ? "copper" : m.use === "traction-tread" ? "rubber" : m.use === "glass-filler" ? "glass" : m.use.split("-")[0]}-v1` &&
								b.evidence.massG >= m.mass_g
							);
						})?.id,
			)
			.filter(Boolean);
		const product_ids = r.products.flatMap((d: any) =>
			s.manufacturing.products
				.filter((p: any) => p.state === "available" && p.kind === d.kind)
				.slice(0, d.quantity)
				.map((p: any) => p.id),
		);
		const component_ids = r.components.flatMap((d: any) => {
			let remaining = d.quantity;
			const ids = [];
			for (const c of s.science.components.filter(
				(c: any) => c.kind === d.kind && c.tested,
			)) {
				if (remaining <= 0) break;
				ids.push(c.id);
				remaining -= c.quantity;
			}
			return ids;
		});
		return { recipe_id: recipe, batch_ids, product_ids, component_ids };
	};
	const enqueue = (recipe: string) => {
		const args = selection(recipe),
			preview = call("manufacturing_preview", {
				version: 5,
				match_id: id,
				...args,
			});
		assert.equal(preview.result.status, "eligible", JSON.stringify(preview));
		act("enqueue_manufacturing", args);
		return read().manufacturing.jobs.at(-1);
	};
	const make = (recipe: string) => {
		const job = enqueue(recipe);
		tick(20000);
		assert.equal(
			read().manufacturing.jobs.find((j: any) => j.id === job.id).state,
			"completed",
		);
		return read().manufacturing.products.find(
			(p: any) => p.source_job_id === job.id,
		);
	};
	// A real write failure cannot reserve a source without its immutable receipt.
	const args = selection("steel-bracket"),
		before = canonical(db.loadInstance(id));
	db.db.exec(
		"CREATE TRIGGER production_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'production-fault'); END",
	);
	assert.throws(() => act("enqueue_manufacturing", args));
	assert.equal(canonical(db.loadInstance(id)), before);
	db.db.exec("DROP TRIGGER production_fault");
	const cancelled = enqueue("steel-bracket");
	tick(1000);
	act("pause_job", { job_id: cancelled.id });
	const spent = read().manufacturing.jobs.at(-1).energy_mj;
	tick(5000);
	assert.equal(read().manufacturing.jobs.at(-1).energy_mj, spent);
	act("cancel_job", { job_id: cancelled.id });
	assert.equal(read().manufacturing.products.length, 0);
	const first = make("steel-bracket");
	assert.equal(first.mass_g, 1000);
	const held = enqueue("steel-bracket");
	const retry = {
		...command(),
		match_id: id,
		expected_revision: read().revision,
		action: "pause_job",
		job_id: held.id,
	};
	const receipt = call("command", retry);
	db.close();
	db = new GameDatabase(path, { clock: () => now });
	assert.deepEqual(call("command", retry), receipt);
	act("resume_job", { job_id: held.id });
	tick(20000);
	assert.equal(read().manufacturing.jobs.at(-1).state, "completed");
	make("copper-conductor");
	for (const c of read().science.components.filter(
		(c: any) => c.kind === "fastener",
	)) {
		act("inspect_component", { component_id: c.id });
		tick(3000);
	}
	const press = make("metal-press");
	assert.equal(press.state, "installed");
	const paused = enqueue("steel-chassis");
	tick(1000);
	act("set_production_machine", { machine_id: press.id, enabled: false });
	tick(1000);
	assert.equal(read().manufacturing.jobs.at(-1).reason, "machine-disabled");
	act("set_production_machine", { machine_id: press.id, enabled: true });
	tick(20000);
	assert.equal(read().manufacturing.jobs.at(-1).state, "completed");
	assert(
		!JSON.stringify(
			call("read_match", { version: 5, match_id: id }, b),
		).includes(press.id),
	);

	const inspectStock = () => {
		for (const c of read().science.components.filter((c: any) => !c.tested)) {
			act("inspect_component", { component_id: c.id });
			tick(3000);
		}
	};
	for (let i = 0; i < 2; i++) make("steel-bracket");
	make("glass-filler");
	make("copper-conductor");
	inspectStock();
	const furnace = make("furnace");
	act("salvage_starter_asset", {
		asset_id: read().base.assets.find((a: any) => a.kind === "fabricator").id,
	});
	inspectStock();
	make("steel-bracket");
	make("copper-conductor");
	make("fabricator");

	if (process.argv.includes("--units")) {
		// All bulk stock above was recovered, processed and graded through real commands.
		for (const r of read().field.robots) {
			act("recharge_robot", { robot_id: r.id });
			tick(180000);
			act("salvage_starter_asset", { asset_id: r.id });
		}
		inspectStock();
		for (let i = 0; i < 2; i++) make("steel-bracket");
		make("copper-conductor");
		make("hdpe-housing");
		const turret = make("sentry-turret");
		const ownUnit = () =>
			read().units.units.find((u: any) => u.id === turret.id);
		assert.equal(ownUnit().state, "stowed");
		assert.equal(ownUnit().enabled, false);
		assert.equal(ownUnit().ammunition_count, 0);
		make("steel-slug");
		const ammo = read().manufacturing.products.find(
			(p: any) => p.kind === "steel-slug",
		);
		const invalidBefore = canonical(db.loadInstance(id));
		assert.throws(
			() =>
				act("deploy_unit", { unit_id: turret.id, position: { x: 55, y: 24 } }),
			{ code: "UNIT_SITE" },
		);
		assert.equal(canonical(db.loadInstance(id)), invalidBefore);
		assert.throws(
			() =>
				act("deploy_unit", { unit_id: turret.id, position: { x: 39, y: 8 } }),
			{ code: "UNIT_SITE" },
		);
		assert.throws(
			() =>
				act("deploy_unit", { unit_id: turret.id, position: { x: 8, y: 24 } }),
			{ code: "UNIT_SITE" },
		);
		const enemyRequest = {
			...command(),
			match_id: id,
			expected_revision: read().revision,
			action: "deploy_unit",
			unit_id: turret.id,
			position: { x: 70, y: 24 },
		};
		assert.throws(() => call("command", enemyRequest, b), {
			code: "NOT_AVAILABLE",
		});
		const deployRequest = {
			...command(),
			match_id: id,
			expected_revision: read().revision,
			action: "deploy_unit",
			unit_id: turret.id,
			position: { x: 38, y: 24 },
		};
		const energy = read().machines[0].energy_mj,
			deployReceipt = call("command", deployRequest);
		assert.equal(read().machines[0].energy_mj, energy - 500000);
		assert.deepEqual(call("command", deployRequest), deployReceipt);
		act("load_unit_ammunition", { unit_id: turret.id, ammunition_id: ammo.id });
		assert.throws(
			() =>
				act("load_unit_ammunition", {
					unit_id: turret.id,
					ammunition_id: ammo.id,
				}),
			{ code: "NOT_AVAILABLE" },
		);
		act("set_unit_enabled", { unit_id: turret.id, enabled: true });
		assert.equal(ownUnit().operational_ready, true);
		assert.equal(ownUnit().can_fire, false);
		assert(ownUnit().blocked_reasons.includes("combat-not-implemented"));
		assert.equal(ownUnit().targets[0].in_range, false);
		assert.throws(() => act("salvage_unit", { unit_id: turret.id }), {
			code: "NOT_READY",
		});
		assert.throws(
			() => act("destroy_manufactured_product", { product_id: ammo.id }),
			{ code: "NOT_READY" },
		);
		act("set_unit_enabled", { unit_id: turret.id, enabled: false });
		const patch = make("steel-bracket");
		assert.throws(
			() => act("repair_unit", { unit_id: turret.id, product_id: patch.id }),
			{ code: "NOT_READY" },
		);
		const damaged = db.load(id);
		damageUnit(damaged.players[0], turret.id, 50);
		db.save(damaged);
		act("repair_unit", { unit_id: turret.id, product_id: patch.id });
		assert.equal(ownUnit().health, 90);
		assert.throws(
			() => act("repair_unit", { unit_id: turret.id, product_id: patch.id }),
			{ code: "NOT_AVAILABLE" },
		);
		const privateJson = JSON.stringify(
			call("read_match", { version: 5, match_id: id }, b),
		);
		for (const secret of [turret.id, ammo.id, patch.id])
			assert(!privateJson.includes(secret));
		const otherDb = new GameDatabase(path, { clock: () => now });
		try {
			const unload = {
				...command(),
				match_id: id,
				expected_revision: read().revision,
				action: "salvage_unit",
				unit_id: turret.id,
			};
			db.db.exec(
				"CREATE TRIGGER unit_fault BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'unit-fault'); END",
			);
			const rollback = canonical(db.loadInstance(id));
			assert.throws(() => call("command", unload));
			assert.equal(canonical(db.loadInstance(id)), rollback);
			db.db.exec("DROP TRIGGER unit_fault");
			const receipt = call("command", unload);
			assert.deepEqual(
				otherDb.dispatch(a, "astra.game_command", unload),
				receipt,
			);
			assert.throws(
				() =>
					otherDb.dispatch(a, "astra.game_command", {
						...unload,
						command_id: randomUUID(),
					}),
				{ code: "CONFLICT" },
			);
			db.close();
			db = new GameDatabase(path, { clock: () => now });
			assert.deepEqual(call("command", unload), receipt);
			assert.equal(ownUnit().state, "salvaged");
			assert.equal(
				read().manufacturing.products.find((p: any) => p.id === ammo.id).state,
				"available",
			);
			assert.equal(
				read().manufacturing.products.find((p: any) => p.id === patch.id).state,
				"available",
			);
			assert(
				read().science.components.some(
					(c: any) => c.kind === "camera" && !c.tested,
				),
			);
			assert.throws(() => act("salvage_unit", { unit_id: turret.id }), {
				code: "NOT_AVAILABLE",
			});
		} finally {
			otherDb.close();
		}
		inspectStock();
		// Build the aluminum variant using reclaimed tested detectors, then verify its declared health effect.
		for (let i = 0; i < 2; i++) make("steel-bracket");
		make("copper-conductor");
		make("aluminum-housing");
		const armored = make("armored-turret");
		assert.equal(
			read().units.units.find((u: any) => u.id === armored.id).health,
			140,
		);
		assert.equal(unitProfiles["sentry-turret"].max_health, 100);
		act("destroy_manufactured_product", { product_id: armored.id });
		assert.equal(
			read().units.units.find((u: any) => u.id === armored.id).state,
			"destroyed",
		);
		act("salvage_unit", { unit_id: armored.id });
		inspectStock();
		make("copper-conductor");
		make("hdpe-housing");
		make("traction-tread");
		make("traction-tread");
		const launcher = make("raid-launcher");
		const native = db.load(id),
			own = native.players[0];
		own.machine.dissipated_mj += own.machine.energy_mj;
		own.machine.energy_mj = 0;
		db.save(native);
		assert.throws(
			() =>
				act("deploy_unit", {
					unit_id: launcher.id,
					position: { x: 47, y: 24 },
				}),
			{ code: "UNIT_POWER" },
		);
		tick(20000);
		act("deploy_unit", { unit_id: launcher.id, position: { x: 47, y: 24 } });
		act("load_unit_ammunition", {
			unit_id: launcher.id,
			ammunition_id: ammo.id,
		});
		make("steel-slug");
		const ammo2 = read().manufacturing.products.find(
			(p: any) => p.kind === "steel-slug" && p.state === "available",
		);
		act("load_unit_ammunition", {
			unit_id: launcher.id,
			ammunition_id: ammo2.id,
		});
		assert.throws(
			() =>
				act("load_unit_ammunition", {
					unit_id: launcher.id,
					ammunition_id: randomUUID(),
				}),
			{ code: "NOT_READY" },
		);
		act("set_unit_enabled", { unit_id: launcher.id, enabled: true });
		const beforeTick = read().units;
		tick(120000);
		assert.deepEqual(read().units, beforeTick); // No phantom idle firing, ammo use or tower damage.
		act("set_unit_enabled", { unit_id: launcher.id, enabled: false });
		const destroyed = db.load(id);
		damageUnit(destroyed.players[0], launcher.id, 1000);
		db.save(destroyed);
		act("salvage_unit", { unit_id: launcher.id });
		const saved = db.loadInstance(id);
		db.close();
		db = new GameDatabase(path, { clock: () => now });
		assert.deepEqual(db.loadInstance(id), saved);
		db.transaction(() => assert.deepEqual(db.history.replay(id).state, saved));
		console.log(
			"PASS real recovered/graded stock -> both turrets and raid launcher; metered deployment, ammo capacity, ownership/privacy, repair, destruction, salvage, rollback, competing connections, restart and immutable retry",
		);
	} else {
		make("steel-bracket");
		make("hdpe-housing");
		make("copper-conductor");
		make("polymer-processor");
		// Actual heater + polymer process admission and interruption, not just an installed-machine label.
		const flakes = read().batches.find(
			(b: any) => b.form === "flakes" && b.state === "available",
		);
		assert(flakes);
		const polymer = read().manufacturing.products.find(
			(p: any) => p.kind === "polymer-processor",
		);
		act("start_material_process", {
			batch_id: flakes.id,
			machine_id: polymer.id,
			recipe_id: "mold-hdpe",
		});
		tick(1000);
		act("set_production_machine", { machine_id: furnace.id, enabled: false });
		tick(1000);
		assert.equal(read().jobs.at(-1).pause_reason, "machine-disabled");
		act("set_production_machine", { machine_id: furnace.id, enabled: true });
		tick(30000);
		assert.equal(read().jobs.at(-1).state, "completed");
		act("salvage_starter_asset", { asset_id: read().field.robots[0].id });
		inspectStock();
		make("copper-conductor");
		make("hdpe-housing");
		make("traction-tread");
		make("traction-tread");
		const robot = make("scavenger-robot");
		assert.equal(
			read().field.robots.find((r: any) => r.id === robot.id).energy_mj,
			0,
		);
		act("recharge_robot", { robot_id: robot.id });
		tick(180000);
		assert.equal(
			read().field.robots.find((r: any) => r.id === robot.id).energy_mj,
			8000000,
		);
		make("steel-bracket");
		make("steel-bracket");
		make("traction-tread");
		make("scrap-barricade");
		make("steel-bracket");
		make("glass-filler");
		make("solar-reflector");
		assert.equal(read().base.power.solar_w, 150);
		make("steel-bracket");
		make("copper-conductor");
		make("hdpe-housing");
		make("charging-port");
		make("steel-bracket");
		make("copper-conductor");
		act("salvage_starter_asset", {
			asset_id: read().base.assets.find((a: any) => a.kind === "solar").id,
		});
		inspectStock();
		const solar = make("solar-array");
		assert.equal(read().base.power.solar_w, 150);
		const doomed = enqueue("aluminum-housing");
		tick(1000);
		act("destroy_manufactured_product", { product_id: press.id });
		tick(1000);
		assert.equal(
			read().manufacturing.jobs.find((j: any) => j.id === doomed.id).state,
			"failed",
		);
		// A zero-energy fixture moves existing charge into the irreversible dissipation account.
		act("set_production_machine", { machine_id: solar.id, enabled: false });
		const native = db.load(id),
			own = native.players[0];
		own.machine.dissipated_mj += own.machine.energy_mj;
		own.machine.energy_mj = 0;
		db.save(native);
		const starved = enqueue("copper-conductor");
		tick(1000);
		assert.equal(read().manufacturing.jobs.at(-1).reason, "power");
		act("set_production_machine", { machine_id: solar.id, enabled: true });
		tick(60000);
		assert.equal(
			read().manufacturing.jobs.find((j: any) => j.id === starved.id).state,
			"completed",
		);
		while (read().manufacturing.storage_used < 16) make("copper-conductor");
		const blocked = enqueue("copper-conductor");
		tick(20000);
		assert.equal(read().manufacturing.jobs.at(-1).reason, "storage-full");
		const discarded = read().manufacturing.products.find(
			(p: any) => p.kind === "copper-conductor" && p.state === "available",
		);
		act("destroy_manufactured_product", { product_id: discarded.id });
		tick(20000);
		assert.equal(
			read().manufacturing.jobs.find((j: any) => j.id === blocked.id).state,
			"completed",
		);
		const competing = selection("copper-conductor"),
			fresh = read(),
			intent = {
				...command(),
				match_id: id,
				expected_revision: fresh.revision,
				action: "enqueue_manufacturing",
				...competing,
			};
		const db2 = new GameDatabase(path, { clock: () => now });
		try {
			const receipt = call("command", intent);
			assert.deepEqual(db2.dispatch(a, "astra.game_command", intent), receipt);
			assert.throws(
				() =>
					db2.dispatch(a, "astra.game_command", {
						...intent,
						command_id: randomUUID(),
					}),
				{ code: "CONFLICT" },
			);
		} finally {
			db2.close();
		}
		act("cancel_job", { job_id: read().manufacturing.jobs.at(-1).id });
		console.log(
			"PASS full machine chain, tested reclaimed hardware, empty-battery robot, defenses/upgrades, heater interlock, charging/solar, failure, starvation, storage, concurrent reservation and exactly-once retries",
		);
		console.log(
			"PASS manufacturing reservation rollback, exact offcuts, cancellation, paid energy, restart/retry, press construction, machine pause/resume and ownership",
		);
	}
} finally {
	db.close();
	await rm(dir, { recursive: true, force: true });
}
