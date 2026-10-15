import { z } from "zod";
import {
	BatchSchema,
	ComponentSchema,
	ObservationSchema,
	ConstituentSchema,
	FormSchema,
	CATALOG_VERSION,
	BALANCE_VERSION,
} from "./schema.js";
const id = z.string().min(1).max(100);
const nonnegative = z.number().finite().nonnegative();
const integer = nonnegative.int().max(Number.MAX_SAFE_INTEGER);
const nextActions = z.array(id).min(1).max(8);
const stream = z
	.object({
		id,
		form: FormSchema,
		massG: integer,
		constituents: z.array(ConstituentSchema),
		requiresInspection: z.literal(true),
	})
	.strict();
export const ResultSchema = z.union([
	z
		.object({
			status: z.enum(["ineligible", "needs-inspection"]),
			code: id,
			message: z.string().max(500),
			nextActions,
		})
		.strict(),
	z
		.object({
			status: z.literal("eligible"),
			partId: id,
			catalogVersion: z.literal(CATALOG_VERSION),
			operatingTemperatureC: z.number().finite(),
			nextActions,
		})
		.strict(),
	z
		.object({
			status: z.literal("eligible"),
			componentId: id,
			assembly: id,
			nextActions,
		})
		.strict(),
	z
		.object({
			status: z.literal("eligible"),
			kind: z.literal("process-plan"),
			batchId: id,
			catalogVersion: z.literal(CATALOG_VERSION),
			recipeId: id,
			recipeVersion: z.literal(BALANCE_VERSION),
			inputMassG: integer,
			durationMs: integer,
			energyJ: integer,
			nextActions,
			outputs: z.array(stream).max(8),
			residue: z
				.object({ massG: integer, constituents: z.array(ConstituentSchema) })
				.strict(),
		})
		.strict(),
	z
		.object({
			status: z.literal("eligible"),
			kind: z.literal("substitution-plan"),
			designId: id,
			catalogVersion: z.literal(CATALOG_VERSION),
			areaMm2: nonnegative,
			areaMultiplier: nonnegative,
			requiredMassG: integer,
			resistanceOhm: nonnegative,
			lossW: nonnegative,
			requiredConnector: id,
			operatingTemperatureC: z.number().finite(),
			nextActions,
			basis: z.literal("game-balance-fixture"),
		})
		.strict(),
]);
const projected = z.union([
	z.object(BatchSchema.shape).omit({ catalogVersion: true }).strict(),
	z
		.object({
			id,
			massG: integer,
			form: FormSchema,
			inspection: z.enum(["uninspected", "identified"]),
		})
		.strict(),
]);
// Refinements run in the authority; JSON Schema additionally bounds the transport.
export const jsonSchemas = Object.fromEntries(
	Object.entries({
		result: ResultSchema,
		component: ComponentSchema,
		observation: ObservationSchema,
		batch: projected,
	}).map(([k, v]) => {
		const { $schema, ...schema } = z.toJSONSchema(v, { target: "draft-7" });
		return [k, schema];
	}),
);
