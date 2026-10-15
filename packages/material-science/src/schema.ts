import { z } from "zod";

export const CATALOG_VERSION = "materials-v2";
export const BALANCE_VERSION = "balance-v2";
export const MAX_MASS_G = 1_000_000_000;
export const materialIds = [
	"steel",
	"aluminum",
	"copper",
	"hdpe",
	"glass",
	"rubber",
	"dirt",
	"unknown",
] as const;
export const MaterialIdSchema = z.enum(materialIds);
export type MaterialId = z.infer<typeof MaterialIdSchema>;
export const FormSchema = z.enum([
	"residue",
	"mixed",
	"cable",
	"scrap",
	"stock",
	"wire",
	"flakes",
	"granulate",
	"tread",
]);
const id = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-zA-Z0-9_.-]+$/);
const mass = z.number().int().min(1).max(MAX_MASS_G);
const temperature = z.number().finite().min(-273.15).max(5000);
export const ConstituentSchema = z
	.object({ material: MaterialIdSchema, massG: mass })
	.strict();
const propertyKinds = [
	"density",
	"electricalConductivity",
	"thermalConductivity",
	"yieldStrength",
	"maxServiceTemperature",
] as const;
const units = {
	density: "kg/m3",
	electricalConductivity: "S/m",
	thermalConductivity: "W/(m*K)",
	yieldStrength: "MPa",
	maxServiceTemperature: "degC",
} as const;
export const PropertySchema = z
	.object({
		kind: z.enum(propertyKinds),
		value: z.number().finite(),
		unit: z.enum(["kg/m3", "S/m", "W/(m*K)", "MPa", "degC"]),
		validFromC: temperature,
		validToC: temperature,
		source: z.string().min(1).max(500),
		basis: z
			.enum(["reference", "measurement-fixture"])
			.default("measurement-fixture"),
		uncertainty: z
			.object({ lower: z.number().finite(), upper: z.number().finite() })
			.strict()
			.nullable()
			.default(null),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.uncertainty &&
			(value.uncertainty.lower > value.value ||
				value.uncertainty.upper < value.value ||
				(value.kind !== "maxServiceTemperature" &&
					value.uncertainty.lower <= 0))
		)
			ctx.addIssue({ code: "custom", message: "Invalid uncertainty interval" });
		if (
			value.kind === "maxServiceTemperature" &&
			value.uncertainty &&
			(value.uncertainty.lower < -273.15 || value.uncertainty.upper > 5000)
		)
			ctx.addIssue({
				code: "custom",
				message: "Temperature uncertainty outside supported domain",
			});
		if (value.unit !== units[value.kind])
			ctx.addIssue({ code: "custom", message: "Property unit mismatch" });
		if (value.validFromC > value.validToC)
			ctx.addIssue({
				code: "custom",
				message: "Invalid property temperature range",
			});
		if (
			value.kind === "maxServiceTemperature"
				? value.value < -273.15 || value.value > 5000
				: value.value <= 0
		) {
			ctx.addIssue({
				code: "custom",
				message: "Property outside its physical domain",
			});
		}
	});
export const BatchSchema = z
	.object({
		id,
		catalogVersion: z.literal(CATALOG_VERSION),
		massG: mass,
		constituents: z.array(ConstituentSchema).min(1).max(materialIds.length),
		form: FormSchema,
		inspection: z.enum(["uninspected", "identified", "graded"]),
		grade: z.string().min(1).max(100).nullable(),
		condition: z.enum(["sound", "damaged", "unknown"]),
		hazard: z.enum(["none-detected", "suspect-battery", "unknown"]),
		properties: z.array(PropertySchema).max(propertyKinds.length),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			value.constituents.reduce((sum, row) => sum + row.massG, 0) !==
			value.massG
		)
			ctx.addIssue({
				code: "custom",
				message: "Constituents must equal batch mass",
			});
		if (
			new Set(value.constituents.map((row) => row.material)).size !==
			value.constituents.length
		)
			ctx.addIssue({ code: "custom", message: "Duplicate constituent" });
		if (
			new Set(value.properties.map((row) => row.kind)).size !==
			value.properties.length
		)
			ctx.addIssue({ code: "custom", message: "Duplicate property" });
		if (value.properties.some((p) => p.basis === "reference"))
			ctx.addIssue({
				code: "custom",
				message: "Reference science is not batch evidence",
			});
		if (
			value.inspection !== "graded" &&
			(value.grade !== null || value.properties.length)
		)
			ctx.addIssue({
				code: "custom",
				message: "Properties and grade require inspection evidence",
			});
	});
export type Batch = z.infer<typeof BatchSchema>;
export type Property = z.infer<typeof PropertySchema>;
export type Constituent = z.infer<typeof ConstituentSchema>;

const route = z
	.object({
		material: MaterialIdSchema,
		numerator: z.number().int().min(0).max(1_000_000),
		denominator: z.number().int().min(1).max(1_000_000),
	})
	.strict();
export const RecipeSchema = z
	.object({
		id,
		version: z.literal(BALANCE_VERSION),
		target: MaterialIdSchema,
		inputForms: z.array(FormSchema).min(1),
		minimumPurityBps: z.number().int().min(1).max(10_000),
		machine: id,
		minimumTemperatureC: temperature.nullable(),
		powerW: z.number().int().min(1).max(1_000_000),
		millisecondsPerKg: z.number().int().min(1).max(3_600_000),
		outputs: z
			.array(
				z
					.object({
						id,
						form: FormSchema,
						routes: z.array(route).min(1).max(materialIds.length),
					})
					.strict(),
			)
			.min(1)
			.max(8),
		basis: z.literal("game-balance-fixture"),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (
			new Set(value.outputs.map((output) => output.id)).size !==
			value.outputs.length
		)
			ctx.addIssue({ code: "custom", message: "Duplicate output stream" });
		for (const material of materialIds) {
			let numerator = 0n;
			let denominator = 1n;
			for (const output of value.outputs) {
				if (
					new Set(output.routes.map((r) => r.material)).size !==
					output.routes.length
				) {
					ctx.addIssue({
						code: "custom",
						message: "Duplicate material route in stream",
					});
				}
				for (const entry of output.routes.filter(
					(r) => r.material === material,
				)) {
					numerator =
						numerator * BigInt(entry.denominator) +
						BigInt(entry.numerator) * denominator;
					denominator *= BigInt(entry.denominator);
				}
			}
			if (numerator > denominator)
				ctx.addIssue({
					code: "custom",
					message: "Routes recover more than the available constituent",
				});
		}
	});
export type Recipe = z.infer<typeof RecipeSchema>;
export const MachineSchema = z
	.object({
		kind: id,
		enabled: z.boolean(),
		availablePowerW: z.number().int().min(0).max(1_000_000),
		availableEnergyJ: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		maximumTemperatureC: temperature.nullable(),
	})
	.strict();
export type Machine = z.infer<typeof MachineSchema>;

export const PartSchema = z
	.object({
		id,
		material: MaterialIdSchema,
		form: FormSchema,
		minimumMassG: mass,
		minimumPurityBps: z.number().int().min(1).max(10_000),
		requiresGrade: z.boolean(),
		allowedGrades: z.array(id).min(1),
		operatingTemperatureC: temperature,
		properties: z.array(
			z
				.object({ kind: z.enum(propertyKinds), minimum: z.number().finite() })
				.strict(),
		),
		basis: z.literal("game-balance-fixture"),
	})
	.strict();
export type Part = z.infer<typeof PartSchema>;

export const ObservationSchema = z
	.object({
		id,
		owner: id,
		targetId: id,
		targetRevision: z.number().int().positive(),
		targetKind: z.enum(["batch", "component"]),
		sensorVersion: z.literal("bench-v1"),
		timestampMs: z.number().int().nonnegative(),
		position: z
			.object({ x: z.number().finite(), y: z.number().finite() })
			.strict(),
		evidence: z.enum(["composition-condition", "component-function"]),
		uncertaintyMeaning: z.literal("bounded-game-fixture-not-hardware-accuracy"),
		properties: z.array(PropertySchema).max(5),
	})
	.strict();
export const ComponentSchema = z
	.object({
		id,
		owner: id,
		location: id,
		kind: id,
		quantity: z.number().int().positive().max(100),
		unitMassG: mass,
		condition: z.enum(["sound", "damaged", "unknown"]),
		tested: z.boolean(),
		compatibleAssemblies: z.array(id).max(8),
		allocation: z.literal("component-only"),
		revision: z.number().int().positive(),
	})
	.strict()
	.superRefine((v, ctx) => {
		if (
			!v.tested &&
			(v.compatibleAssemblies.length || v.condition !== "unknown")
		)
			ctx.addIssue({
				code: "custom",
				message: "Untested component cannot claim fitness",
			});
	});
export const MaterialSchema = z
	.object({
		name: z.string().min(1),
		uses: z.array(z.string().min(1)).min(1),
		reference: z
			.object({
				scope: z.literal("pure element"),
				densityKgPerM3: z.number().finite().positive(),
				meltingPointC: temperature,
				source: z.url(),
			})
			.strict()
			.nullable(),
	})
	.strict();
export type Observation = z.infer<typeof ObservationSchema>;
export type Component = z.infer<typeof ComponentSchema>;

export const SubstitutionSchema = z
	.object({
		id,
		material: z.literal("aluminum"),
		grade: id,
		form: z.literal("wire"),
		baselineConductivitySPerM: z.number().finite().positive(),
		baselineAreaMm2: z.number().finite().positive(),
		lengthM: z.number().finite().positive(),
		currentA: z.number().finite().nonnegative(),
		areaStepMm2: z.number().finite().positive(),
		maximumAreaMm2: z.number().finite().positive(),
		temperatureC: temperature,
		requiredConnector: id,
		basis: z.literal("game-balance-fixture"),
	})
	.strict();
