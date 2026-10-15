import assert from "node:assert/strict";
import { test } from "node:test";
import {
	evaluateUse,
	evaluateSubstitution,
	evaluateComponent,
	projectBatch,
} from "../src/engine.js";
import {
	BatchSchema,
	ComponentSchema,
	ObservationSchema,
	PropertySchema,
	CATALOG_VERSION,
} from "../src/schema.js";
const property = (kind: string, value: number, lower = value, upper = value) =>
	PropertySchema.parse({
		kind,
		value,
		unit: kind === "density" ? "kg/m3" : "S/m",
		validFromC: 20,
		validToC: 20,
		source: "synthetic bounded game fixture",
		basis: "measurement-fixture",
		uncertainty: { lower, upper },
	});
const batch = (material: string, properties: unknown[] = []) =>
	BatchSchema.parse({
		id: "sample",
		catalogVersion: CATALOG_VERSION,
		massG: 1000,
		constituents: [{ material, massG: 1000 }],
		form: "wire",
		inspection: "graded",
		grade: `game-${material}-v1`,
		condition: "sound",
		hazard: "none-detected",
		properties,
	});
test("measurement intervals and explicit grades govern approval; reference values cannot become evidence", () => {
	const b = batch("copper", [
		property("electricalConductivity", 41e6, 39e6, 43e6),
	]);
	const unknown = evaluateUse(b, "copper-conductor");
	assert.equal("code" in unknown && unknown.code, "UNCERTAIN_PROPERTY");
	assert.equal(
		evaluateUse({ ...b, grade: "random-alloy" }, "copper-conductor").status,
		"ineligible",
	);
	assert.equal(
		evaluateUse(
			{
				...b,
				properties: [property("electricalConductivity", 45e6, 40e6, 50e6)],
			},
			"copper-conductor",
		).status,
		"eligible",
	);
	assert.equal(
		evaluateUse(
			{ ...b, properties: [{ ...b.properties[0], uncertainty: null }] },
			"copper-conductor",
		).status,
		"needs-inspection",
	);
	assert.throws(() =>
		BatchSchema.parse({
			...b,
			properties: [{ ...b.properties[0], basis: "reference" }],
		}),
	);
	assert.throws(() => property("electricalConductivity", 10, 11, 12));
	assert.throws(() => property("density", 1, -1, 2));
});
test("a declared aluminum substitution changes geometry, mass and performance conservatively", () => {
	const b = batch("aluminum", [
		property("electricalConductivity", 31e6, 30e6, 32e6),
		property("density", 2700, 2600, 2800),
	]);
	const result = evaluateSubstitution(b, "aluminum-power-link-v1");
	assert.equal(result.status, "eligible");

	assert.equal(result.areaMm2, 2.67);
	assert.equal(result.requiredMassG, 8);
	assert(result.lossW <= 1.25);
	assert(result.areaMultiplier > 1);
	assert.equal(result.requiredConnector, "bimetal-terminal-v1");
	assert.equal(
		evaluateSubstitution(b, "aluminum-power-link-v1", 90).status,
		"ineligible",
	);
	assert.equal(
		evaluateSubstitution(
			{
				...b,
				properties: [
					property("electricalConductivity", 10e6),
					property("density", 2700),
				],
			},
			"aluminum-power-link-v1",
		).status,
		"ineligible",
	);
	assert.equal(
		evaluateSubstitution(b, "universal-metal-swap").status,
		"ineligible",
	);
	assert.equal(
		evaluateSubstitution(
			{ ...b, grade: null, inspection: "identified", properties: [] },
			"aluminum-power-link-v1",
		).status,
		"needs-inspection",
	);
	assert.deepEqual(
		projectBatch({
			...b,
			grade: null,
			inspection: "identified",
			properties: [],
		}),
		projectBatch({
			...batch("unknown"),
			grade: null,
			inspection: "identified",
		}),
	);
});
test("component fitness requires its own test record and compatible assembly", () => {
	const c = ComponentSchema.parse({
		id: "c",
		owner: "a",
		location: "store",
		kind: "fastener",
		quantity: 20,
		unitMassG: 10,
		condition: "unknown",
		tested: false,
		compatibleAssemblies: [],
		allocation: "component-only",
		revision: 1,
	});
	assert.equal(evaluateComponent(c, "fixture").status, "needs-inspection");
	assert.equal(
		evaluateComponent(
			{
				...c,
				tested: true,
				condition: "sound",
				compatibleAssemblies: ["fixture"],
			},
			"fixture",
		).status,
		"eligible",
	);
	assert.equal(
		evaluateComponent(
			{
				...c,
				tested: true,
				condition: "damaged",
				compatibleAssemblies: ["fixture"],
			},
			"fixture",
		).status,
		"ineligible",
	);
	assert.throws(() =>
		ComponentSchema.parse({ ...c, compatibleAssemblies: ["fixture"] }),
	);
	assert.throws(() =>
		ComponentSchema.parse({ ...c, allocation: "bulk-and-component" }),
	);
	assert.throws(() =>
		ObservationSchema.parse({ owner: "a", sensorVersion: "unknown-sensor" }),
	);
});
