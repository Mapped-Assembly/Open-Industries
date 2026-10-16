import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { GameDatabase } from "../../server/game-sqlite.mjs";
import {
	packGame,
	advanceGame,
	nativeGame,
} from "../../server/domains/game-core.mjs";
import {
	initializeScience,
	inspectAtBench,
} from "../../server/game-materials.mjs";
import {
	enqueueManufacturing,
	manufacturingPlan,
	settleManufacturing,
	manufacturingProjection,
	assertManufacturing,
} from "../../server/game-manufacturing.mjs";

/** Conservation-valid isolated fixture; integration tests separately pay for recovery/inspection. */
function fixture() {
	const db = new GameDatabase(":memory:", { clock: () => 1000 });
	try {
		const match: any = db.newMatch(randomUUID(), randomUUID());
		db.join(match, randomUUID());
		const p = match.players[0],
			source = match.world.deposits.find(
				(d: any) => d.kind === "cable" && d.home_slot === 1,
			);
		source.stock.remaining.copper -= 1000;
		const batch: any = {
			id: randomUUID(),
			form: "wire",
			state: "available",
			contents: { copper: 1000 },
			copper_g: 1000,
			hdpe_g: 0,
			dirt_g: 0,
			field_collected: true,
			observation_id: null,
			source_job_id: null,
			output_role: "conductor",
			grade: "recovered-ungraded",
		};
		p.batches.push(batch);
		initializeScience(match);
		inspectAtBench(
			match,
			p,
			{ kind: "batch-inspection", input_batch_id: batch.id },
			1000,
		);
		const args = {
			recipe_id: "copper-conductor",
			batch_ids: [batch.id],
			product_ids: [],
			component_ids: [],
		};
		return { match, p, batch, args };
	} finally {
		db.close();
	}
}
const fail = (code: string): never => {
	throw Error(code);
};

test("manufacturing uses exact owned homogeneous eligible stock, never caller grades or generic currency", () => {
	const { p, batch, args } = fixture();
	assert.equal(manufacturingPlan(p, args).status, "eligible");
	assert.equal(
		manufacturingPlan(p, { ...args, batch_ids: [randomUUID()] }).code,
		"UNMET_REQUIREMENTS",
	);
	assert.equal(
		manufacturingPlan(p, { ...args, batch_ids: [batch.id, batch.id] }).code,
		"DUPLICATE_INPUT",
	);
	batch.material.grade = null;
	assert.equal(manufacturingPlan(p, args).code, "UNMET_REQUIREMENTS");
	const { p: other, args: otherArgs } = fixture();
	enqueueManufacturing(other, otherArgs, 1000, fail);
	assert.equal(manufacturingPlan(other, otherArgs).code, "UNMET_REQUIREMENTS");
});

test("shared clock catches up power-starved manufacture identically to short ticks with exact offcuts and no energy issuance", () => {
	const { match, p, args } = fixture();
	p.machine.dissipated_mj += p.machine.energy_mj;
	p.machine.energy_mj = 0;
	enqueueManufacturing(p, args, 1000, fail);
	const start = packGame(match),
		long = advanceGame(start, 61000, 1000);
	let fine = start;
	for (let at = 2000; at <= 61000; at += 1000)
		fine = advanceGame(fine, at, 1000);
	const a = nativeGame(long).players[0],
		b = nativeGame(fine).players[0];
	for (const own of [a, b]) {
		assert.equal(own.jobs[0].state, "completed");
		assert.equal(own.jobs[0].work_ms, 4000);
		assert.equal(own.jobs[0].energy_mj, 1000000);
		assert.equal(own.machine.energy_mj, 5000000);
		assert.equal(own.production.products[0].contents.copper, 100);
		assert.equal(
			own.batches
				.filter((v: any) => v.state === "available")
				.reduce((n: number, v: any) => n + v.contents.copper, 0),
			900,
		);
		assertManufacturing(own, fail);
	}
	const twice = nativeGame(advanceGame(long, 61000, 1000)).players[0];
	assert.equal(twice.production.products.length, 1);
});

test("disabled/destroyed construction equipment preserves WIP and releases reservations only on terminal failure", () => {
	const { match, p, args } = fixture();
	enqueueManufacturing(p, args, 1000, fail);
	const bench = p.base.assets.find((a: any) => a.kind === "bench");
	bench.status = "parked";
	settleManufacturing(p, 1000);
	assert.equal(p.jobs[0].state, "paused");
	assert.equal(p.jobs[0].pause_reason, "machine-disabled");
	assert.equal(p.batches[0].state, "reserved");
	bench.status = "destroyed";
	settleManufacturing(p, 1000);
	assert.equal(p.jobs[0].state, "failed");
	assert.equal(p.batches[0].state, "available");
	assert.equal(manufacturingProjection(p).products.length, 0);
	assert.doesNotThrow(() => packGame(match));
});
