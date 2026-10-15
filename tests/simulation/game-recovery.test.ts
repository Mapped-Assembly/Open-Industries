import assert from "node:assert/strict";
import test from "node:test";
import {
	recoveryPlan,
	recoveryInspection,
	recoveryOutputMetadata,
	recoveryVersion,
} from "../../server/game-recovery.mjs";
import { evaluateUse } from "../../packages/material-science/dist/engine.js";

/** Trusted game fixtures deliberately omit any real-world material certification. */
function fixture(
	kind = "construction",
	material = "steel",
	hazard = "none-detected",
) {
	const batch: any = {
		id: "batch-1",
		source_deposit_id: "site-1",
		material: {
			id: "batch-1",
			catalogVersion: "materials-v2",
			massG: 10000,
			constituents: [
				{ material, massG: 9000 },
				{ material: "dirt", massG: 1000 },
			],
			form: "mixed",
			inspection: "graded",
			grade: `game-${material}-feedstock-v1`,
			condition: "sound",
			hazard,
			properties: [],
		},
	};
	const player: any = {
		machine: {
			id: "separator-1",
			kind: "cable-separator",
			status: "ready",
			power_w: 500,
			energy_mj: 20000000,
		},
		base: {
			assets: [
				{ id: "separator-1", status: "ready" },
				{ id: "bench-1", kind: "bench", status: "ready" },
			],
		},
	};
	return {
		batch,
		player,
		match: { world: { deposits: [{ id: "site-1", kind }] } },
	};
}

/** Assert stable rejections without weakening the plan union. */
function reason(result: ReturnType<typeof recoveryPlan>): string {
	assert(result && "code" in result);
	return result.code;
}

test("cold recovery validates evidence, exact grade, condition, contaminants, equipment, energy and nonzero outputs", () => {
	const { batch, player, match } = fixture();
	const plan = (b = batch, p = player) =>
		recoveryPlan(p, b, "bench-recover-steel", match);
	assert.equal(plan()!.status, "eligible");
	for (const [patch, code] of [
		[{ inspection: "uninspected", grade: null }, "NEEDS_INSPECTION"],
		[{ condition: "damaged" }, "DAMAGED_MATERIAL"],
		[{ grade: "game-steel-unreviewed" }, "UNSUPPORTED_GRADE"],
		[{ hazard: "suspect-battery" }, "ISOLATE_COMPONENT"],
	] as const) {
		const b = structuredClone(batch);
		Object.assign(b.material, patch);
		assert.equal(reason(plan(b)), code);
	}
	const dirty = structuredClone(batch);
	dirty.material.constituents = [
		{ material: "steel", massG: 8000 },
		{ material: "dirt", massG: 2000 },
	];
	assert.equal(reason(plan(dirty)), "UNSUITABLE_COMPOSITION");
	dirty.material.constituents = [
		{ material: "steel", massG: 9000 },
		{ material: "unknown", massG: 1000 },
	];
	assert.equal(reason(plan(dirty)), "UNKNOWN_CONSTITUENTS");
	const tiny = structuredClone(batch);
	tiny.material.massG = 1;
	tiny.material.constituents = [{ material: "steel", massG: 1 }];
	assert.equal(reason(plan(tiny)), "INSUFFICIENT_INPUT");
	const machine = structuredClone(player);
	machine.machine.power_w = 1;
	assert.equal(reason(plan(batch, machine)), "INSUFFICIENT_POWER");
	machine.machine.power_w = 500;
	machine.machine.energy_mj = 1;
	assert.equal(reason(plan(batch, machine)), "INSUFFICIENT_ENERGY");
	machine.machine.energy_mj = 20000000;
	machine.base.assets[1].status = "destroyed";
	assert.equal(reason(plan(batch, machine)), "MACHINE_UNAVAILABLE");
});

test("isolation preserves every unknown gram in suspect residue and cannot be repeated on its output", () => {
	const { batch, player, match } = fixture(
		"appliance",
		"steel",
		"suspect-battery",
	);
	batch.material.grade = null;
	batch.material.constituents = [
		{ material: "steel", massG: 7000 },
		{ material: "unknown", massG: 2000 },
		{ material: "dirt", massG: 1000 },
	];
	const result = recoveryPlan(player, batch, "isolate-appliance", match);
	assert.equal(result!.status, "eligible");
	assert(result && "residue" in result);
	assert.equal(
		result.residue.constituents.find((c) => c.material === "unknown")?.massG,
		2000,
	);
	const output = recoveryOutputMetadata(result, batch, { id: "usable" }),
		residue = recoveryOutputMetadata(result, batch, { id: "residue" });
	assert.equal(output.hazard_truth, "none-detected");
	assert.equal(residue.hazard_truth, "suspect-battery");
	assert.equal(
		reason(
			recoveryPlan(
				player,
				{ ...batch, ...residue },
				"isolate-appliance",
				match,
			),
		),
		"UNSUPPORTED_ISOLATION",
	);
	assert.equal(
		reason(recoveryPlan(player, batch, "isolate-vehicle", match)),
		"UNSUPPORTED_ISOLATION",
	);
});

test("compatible glass provenance and paid output fixtures gate uses and temperature limits", () => {
	const { batch, player, match } = fixture("packaging", "glass");
	assert.equal(
		reason(recoveryPlan(player, batch, "bench-sort-glass", match)),
		"INCOMPATIBLE_GLASS",
	);
	const recovered: any = {
		output_role: "usable",
		recovery_rule: recoveryVersion,
		recovery_recipe: "bench-trim-hdpe",
	};
	const material: any = {
		id: "hdpe-output",
		catalogVersion: "materials-v2",
		massG: 1000,
		constituents: [{ material: "hdpe", massG: 1000 }],
		form: "stock",
		inspection: "graded",
		condition: "sound",
		hazard: "none-detected",
		grade: null,
		properties: [],
	};
	assert.equal(
		evaluateUse(material, "hdpe-housing", 60).status,
		"needs-inspection",
	);
	recoveryInspection(recovered, material, match);
	assert.equal(evaluateUse(material, "hdpe-housing", 60).status, "eligible");
	assert.notEqual(evaluateUse(material, "hdpe-housing", 90).status, "eligible");
});

test("schema-5 envelope upgrades its compatibility gate without rewriting state or receipts", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises"),
		{ tmpdir } = await import("node:os"),
		{ join } = await import("node:path");
	const { GameDatabase } = await import("../../server/game-sqlite.mjs");
	const dir = await mkdtemp(join(tmpdir(), "oi-recovery-gate-")),
		path = join(dir, "game.sqlite");
	let db = new GameDatabase(path, { clock: () => 1000 });
	try {
		const a = await db.authenticate(
			{ username: "alice", password: "recovery-gate-password" },
			true,
		);
		db.tick();
		const command = {
				version: 5,
				command_id: "11111111-1111-4111-8111-111111111111",
			},
			created = db.dispatch(a.token, "astra.game_create_match", command);
		const before = db.db.prepare("SELECT state FROM matches").get()!.state,
			receipts = db.db.prepare("SELECT request,result FROM receipts").all();
		db.db.exec("PRAGMA user_version=5");
		db.close();
		db = new GameDatabase(path, { clock: () => 1000 });
		assert.equal(db.db.prepare("PRAGMA user_version").get()!.user_version, 6);
		assert.equal(
			db.db.prepare("SELECT state FROM matches").get()!.state,
			before,
		);
		assert.deepEqual(
			db.db.prepare("SELECT request,result FROM receipts").all(),
			receipts,
		);
		assert.deepEqual(
			db.dispatch(a.token, "astra.game_create_match", command),
			created,
		);
	} finally {
		db.close();
		await rm(dir, { recursive: true, force: true });
	}
});
