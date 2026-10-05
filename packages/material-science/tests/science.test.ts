import assert from "node:assert/strict";
import { test } from "node:test";
import { getRecipe, listParts, listRecipes } from "../src/catalog.js";
import {
	calculateProcess,
	conductorLoss,
	energyForDuration,
	evaluateUse,
	planProcess,
	projectBatch,
} from "../src/engine.js";
import { cableFixture, separatorFixture } from "../src/fixtures.js";
import {
	BALANCE_VERSION,
	BatchSchema,
	CATALOG_VERSION,
	type Batch,
	type MaterialId,
	RecipeSchema,
} from "../src/schema.js";

function materialBatch(
	material: MaterialId,
	overrides: Partial<Batch> = {},
): Batch {
	return BatchSchema.parse({
		id: "test-batch",
		catalogVersion: CATALOG_VERSION,
		massG: 4000,
		constituents: [{ material, massG: 4000 }],
		form: "scrap",
		inspection: "graded",
		grade: `game-${material}-v1`,
		condition: "sound",
		hazard: "none-detected",
		properties: [],
		...overrides,
	});
}
function requirePlan(result: ReturnType<typeof planProcess>) {
	if (result.status !== "eligible") throw new Error(result.code);
	return result;
}

test("the documented cable fixture conserves each constituent and scales energy correctly", () => {
	const batch = cableFixture();
	const before = structuredClone(batch);
	const result = requirePlan(
		planProcess(batch, "strip-cable", separatorFixture()),
	);
	assert.deepEqual(
		result.outputs.map((o) => [o.id, o.massG]),
		[
			["conductor", 5700],
			["insulation", 3000],
		],
	);
	assert.deepEqual(result.residue, {
		massG: 1300,
		constituents: [
			{ material: "copper", massG: 300 },
			{ material: "hdpe", massG: 500 },
			{ material: "dirt", massG: 500 },
		],
	});
	assert.equal(result.durationMs, 20000);
	assert.equal(result.energyJ, 10000);
	assert.deepEqual(
		batch,
		before,
		"calculations must not mutate input inventory",
	);
	assert.deepEqual(
		planProcess(batch, "strip-cable", separatorFixture()),
		result,
	);
	for (const output of result.outputs)
		assert.equal(output.requiresInspection, true);
});

test("uninspected and identified batches reveal no hidden composition through projections or suitability", () => {
	for (const inspection of ["uninspected", "identified"] as const) {
		const a = materialBatch("copper", { inspection, grade: null });
		const b = materialBatch("unknown", {
			inspection,
			grade: null,
			hazard: "suspect-battery",
		});
		assert.deepEqual(projectBatch(a), projectBatch(b));
		assert.deepEqual(
			evaluateUse(a, "copper-conductor"),
			evaluateUse(b, "copper-conductor"),
		);
		assert.deepEqual(
			planProcess(a, "strip-cable", separatorFixture()),
			planProcess(b, "strip-cable", separatorFixture()),
		);
		assert.equal("constituents" in projectBatch(a), false);
	}
});

test("invalid mass, composition, versions, units, property evidence, and non-finite values are rejected", () => {
	const batch = cableFixture();
	const invalid: unknown[] = [
		{ ...batch, massG: -1 },
		{ ...batch, massG: Number.NaN },
		{ ...batch, massG: 9999 },
		{ ...batch, massG: 10_000.5 },
		{ ...batch, catalogVersion: "future" },
		{
			...batch,
			massG: 12000,
			constituents: [
				{ material: "copper", massG: 6000 },
				{ material: "copper", massG: 6000 },
			],
		},
		{ ...batch, extra: true },
		{ ...batch, inspection: "identified", grade: "unverified-grade" },
		{
			...batch,
			properties: [
				{
					kind: "electricalConductivity",
					value: 1,
					unit: "MPa",
					validFromC: 20,
					validToC: 20,
					source: "fixture",
				},
			],
		},
		{
			...batch,
			properties: [
				{
					kind: "density",
					value: Number.POSITIVE_INFINITY,
					unit: "kg/m3",
					validFromC: 20,
					validToC: 20,
					source: "fixture",
				},
			],
		},
	];
	for (const input of invalid)
		assert.equal(BatchSchema.safeParse(input).success, false);
});

test("recipe validation prevents aggregate over-recovery, invalid ratios, duplicate streams, and transmutation", () => {
	const recipe = getRecipe("strip-cable");
	assert.ok(recipe);
	assert.equal(
		RecipeSchema.safeParse({ ...recipe, version: "unreviewed" }).success,
		false,
	);
	assert.equal(
		RecipeSchema.safeParse({
			...recipe,
			outputs: [
				{
					id: "a",
					form: "wire",
					routes: [{ material: "copper", numerator: 1, denominator: 0 }],
				},
			],
		}).success,
		false,
	);
	assert.equal(
		RecipeSchema.safeParse({
			...recipe,
			outputs: [
				{
					id: "a",
					form: "wire",
					routes: [{ material: "copper", numerator: 3, denominator: 4 }],
				},
				{
					id: "b",
					form: "wire",
					routes: [{ material: "copper", numerator: 3, denominator: 4 }],
				},
			],
		}).success,
		false,
	);
	assert.equal(
		RecipeSchema.safeParse({
			...recipe,
			outputs: [recipe.outputs[0], recipe.outputs[0]],
		}).success,
		false,
	);
	const noCopper = materialBatch("aluminum", { form: "cable" });
	assert.equal(
		planProcess(noCopper, "strip-cable", separatorFixture()).status,
		"ineligible",
	);
});

test("every catalog material has an explicit processing path and part requirement", () => {
	const recipes = listRecipes();
	assert.deepEqual([...new Set(recipes.map((r) => r.target))].sort(), [
		"aluminum",
		"copper",
		"glass",
		"hdpe",
		"rubber",
		"steel",
	]);
	for (const recipe of recipes) {
		const batch = materialBatch(recipe.target, {
			form: recipe.inputForms[0] ?? "scrap",
		});
		const result = requirePlan(
			planProcess(batch, recipe.id, {
				kind: recipe.machine,
				enabled: true,
				availablePowerW: recipe.powerW,
				availableEnergyJ: 1_000_000,
				maximumTemperatureC: recipe.minimumTemperatureC,
			}),
		);
		assert.equal(
			result.inputMassG,
			result.outputs.reduce((sum, o) => sum + o.massG, 0) +
				result.residue.massG,
		);
		assert.ok(listParts().some((p) => p.material === recipe.target));
		assert.ok(
			result.outputs.every((o) =>
				o.constituents.every((c) => c.material === recipe.target),
			),
		);
	}
});

test("catalog callers cannot mutate process rules or part requirements", () => {
	const first = getRecipe("strip-cable");
	assert.ok(first);
	first.outputs.length = 0;
	assert.equal(getRecipe("strip-cable")?.outputs.length, 2);
	const parts = listParts();
	parts[0]?.properties.splice(0);
	assert.equal(listParts()[0]?.properties.length, 1);
});

test("machine capability, power, energy, disabled state, unknown recipes, and hazardous components fail explicitly", () => {
	for (const [change, code] of [
		[{ availablePowerW: 499 }, "INSUFFICIENT_POWER"],
		[{ availableEnergyJ: 9999 }, "INSUFFICIENT_ENERGY"],
		[{ enabled: false }, "MACHINE_UNAVAILABLE"],
		[{ kind: "unsupported" }, "MACHINE_UNAVAILABLE"],
	] as const) {
		const result = planProcess(cableFixture(), "strip-cable", {
			...separatorFixture(),
			...change,
		});
		assert.equal("code" in result ? result.code : null, code);
	}
	assert.equal(
		planProcess(cableFixture(), "invent-material", separatorFixture()).status,
		"ineligible",
	);
	const hazard = planProcess(
		{ ...cableFixture(), hazard: "suspect-battery" },
		"strip-cable",
		separatorFixture(),
	);
	assert.equal("code" in hazard ? hazard.code : null, "ISOLATE_COMPONENT");
	const coldMachine = planProcess(materialBatch("hdpe"), "mold-hdpe", {
		...separatorFixture(),
		kind: "polymer-processor",
		maximumTemperatureC: 100,
	});
	assert.equal(
		"code" in coldMachine ? coldMachine.code : null,
		"MACHINE_TEMPERATURE_LIMIT",
	);
});

test("recovery and impurity carryover are separate and each output constituent remains conserved", () => {
	const original = getRecipe("strip-cable");
	assert.ok(original);
	const recipe = structuredClone(original);
	recipe.outputs[0]?.routes.push({
		material: "dirt",
		numerator: 1,
		denominator: 10,
	});
	const plan = requirePlan(
		calculateProcess(cableFixture(), recipe, separatorFixture()),
	);
	assert.equal(plan.outputs[0]?.massG, 5750);
	assert.equal(
		plan.outputs[0]?.constituents.find((c) => c.material === "copper")?.massG,
		5700,
	);
	assert.equal(
		plan.residue.constituents.find((c) => c.material === "dirt")?.massG,
		450,
	);
});

test("fractional gram rounding and small lots cannot create mass or free energy", () => {
	let seed = 7391;
	const random = () => {
		seed = (seed * 48271) % 2147483647;
		return seed;
	};
	const recipe = {
		id: "conservation-fixture",
		version: BALANCE_VERSION,
		target: "copper",
		inputForms: ["mixed"],
		minimumPurityBps: 1,
		machine: "sorter",
		minimumTemperatureC: null,
		powerW: 501,
		millisecondsPerKg: 2111,
		outputs: [
			{
				id: "a",
				form: "wire",
				routes: [
					{ material: "copper", numerator: 1, denominator: 3 },
					{ material: "dirt", numerator: 1, denominator: 7 },
				],
			},
			{
				id: "b",
				form: "scrap",
				routes: [{ material: "copper", numerator: 1, denominator: 3 }],
			},
		],
		basis: "game-balance-fixture",
	};
	for (let sample = 0; sample < 300; sample++) {
		const copper = (random() % 10000) + 1;
		const dirt = (random() % 10000) + 1;
		const batch = materialBatch("copper", {
			massG: copper + dirt,
			form: "mixed",
			constituents: [
				{ material: "copper", massG: copper },
				{ material: "dirt", massG: dirt },
			],
		});
		const plan = requirePlan(
			calculateProcess(batch, recipe, {
				...separatorFixture(),
				kind: "sorter",
				availablePowerW: 501,
				availableEnergyJ: 1_000_000,
			}),
		);
		const all = [
			...plan.outputs.flatMap((o) => o.constituents),
			...plan.residue.constituents,
		];
		for (const input of batch.constituents)
			assert.equal(
				all
					.filter((c) => c.material === input.material)
					.reduce((sum, c) => sum + c.massG, 0),
				input.massG,
			);
		assert.ok(plan.energyJ > 0);
		assert.ok(plan.energyJ >= (501 * plan.durationMs) / 1000);
	}
	assert.equal(energyForDuration(1, 1), 1);
	assert.throws(() =>
		energyForDuration(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
	);
	assert.throws(() => energyForDuration(1, -1));
});

test("repeated recovery is bounded by remaining constituent mass", () => {
	const recipe = {
		id: "recovery-fixture",
		version: BALANCE_VERSION,
		target: "copper",
		inputForms: ["mixed"],
		minimumPurityBps: 1,
		machine: "sorter",
		minimumTemperatureC: null,
		powerW: 500,
		millisecondsPerKg: 2000,
		outputs: [
			{
				id: "usable",
				form: "wire",
				routes: [{ material: "copper", numerator: 1, denominator: 2 }],
			},
		],
		basis: "game-balance-fixture",
	};
	let remaining = 1001;
	let recovered = 0;
	for (let step = 0; step < 20; step++) {
		const batch = materialBatch("copper", {
			massG: remaining,
			form: "mixed",
			constituents: [{ material: "copper", massG: remaining }],
		});
		const result = requirePlan(
			calculateProcess(batch, recipe, {
				...separatorFixture(),
				kind: "sorter",
				availableEnergyJ: 1_000_000,
			}),
		);
		recovered += result.outputs.reduce((sum, output) => sum + output.massG, 0);
		remaining = result.residue.massG;
		assert.equal(recovered + remaining, 1001);
		assert.ok(result.energyJ > 0);
	}
});

test("purity, grade, form, condition, quantity, and measured properties control suitability", () => {
	const conductor = materialBatch("copper", {
		form: "wire",
		properties: [
			{
				kind: "electricalConductivity",
				unit: "S/m",
				value: 50_000_000,
				validFromC: 10,
				validToC: 30,
				source: "synthetic fixture measurement",
				basis: "measurement-fixture",
				uncertainty: { lower: 49000000, upper: 51000000 },
			},
		],
	});
	assert.equal(evaluateUse(conductor, "copper-conductor").status, "eligible");
	assert.equal(
		evaluateUse({ ...conductor, grade: null }, "copper-conductor").status,
		"needs-inspection",
	);
	assert.equal(
		evaluateUse({ ...conductor, form: "scrap" }, "copper-conductor").status,
		"ineligible",
	);
	assert.equal(
		evaluateUse({ ...conductor, condition: "damaged" }, "copper-conductor")
			.status,
		"ineligible",
	);
	assert.equal(
		evaluateUse({ ...conductor, properties: [] }, "copper-conductor").status,
		"needs-inspection",
	);
	assert.equal(
		evaluateUse(conductor, "copper-conductor", 90).status,
		"needs-inspection",
	);
	assert.equal(
		evaluateUse(
			{
				...conductor,
				massG: 10,
				constituents: [{ material: "copper", massG: 10 }],
			},
			"copper-conductor",
		).status,
		"ineligible",
	);
	const mixed = materialBatch("hdpe", {
		form: "stock",
		constituents: [
			{ material: "hdpe", massG: 3000 },
			{ material: "unknown", massG: 1000 },
		],
	});
	assert.equal(evaluateUse(mixed, "hdpe-housing").status, "ineligible");
});

test("service temperature is separate from melt processing and unrelated material properties", () => {
	const polymer = materialBatch("hdpe", {
		form: "stock",
		properties: [
			{
				kind: "maxServiceTemperature",
				unit: "degC",
				value: 70,
				validFromC: 0,
				validToC: 120,
				source: "synthetic fixture rating, not a universal HDPE value",
				basis: "measurement-fixture",
				uncertainty: { lower: 65, upper: 75 },
			},
		],
	});
	assert.equal(evaluateUse(polymer, "hdpe-housing").status, "eligible");
	assert.equal(
		evaluateUse(
			materialBatch("glass", { form: "granulate" }),
			"glass-filler",
			5000,
		).status,
		"needs-inspection",
	);
	const hot = evaluateUse(polymer, "hdpe-housing", 90);
	assert.equal("code" in hot ? hot.code : null, "TEMPERATURE_LIMIT");
	assert.equal(
		evaluateUse(materialBatch("steel", { form: "stock" }), "steel-bracket")
			.status,
		"needs-inspection",
	);
});

test("geometry changes conductor losses; physical calculations reject invalid inputs", () => {
	const wire = {
		conductivitySPerM: 50_000_000,
		lengthM: 10,
		areaM2: 0.000002,
		currentA: 2,
	};
	assert.deepEqual(conductorLoss(wire), { resistanceOhm: 0.1, lossW: 0.4 });
	assert.equal(conductorLoss({ ...wire, areaM2: wire.areaM2 * 2 }).lossW, 0.2);
	assert.throws(() => conductorLoss({ ...wire, areaM2: 0 }));
	assert.throws(() =>
		conductorLoss({ ...wire, conductivitySPerM: Number.NaN }),
	);
});
