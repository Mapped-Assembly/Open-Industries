import { z } from "zod";
import { getPart, getRecipe, listSubstitutions } from "./catalog.js";
import { BatchSchema, CATALOG_VERSION, MachineSchema, RecipeSchema, ComponentSchema, } from "./schema.js";
function reject(status, code, message) {
    return {
        status,
        code,
        message,
        nextActions: [
            status === "needs-inspection"
                ? "inspect-at-bench"
                : "choose-compatible-input-or-process",
        ],
    };
}
function inspectFirst(batch) {
    if (batch.inspection !== "graded")
        return reject("needs-inspection", "NEEDS_INSPECTION", "Inspect and grade this batch before evaluating its composition or properties.");
    if (batch.hazard === "suspect-battery")
        return reject("ineligible", "ISOLATE_COMPONENT", "Isolate this component for a supported inspection; ordinary processing is unavailable.");
    if (batch.hazard === "unknown" || batch.condition === "unknown")
        return reject("needs-inspection", "NEEDS_INSPECTION", "Establish batch condition and hazard status before using it.");
    return undefined;
}
export function constituentMass(batch, material) {
    return (batch.constituents.find((entry) => entry.material === material)?.massG ?? 0);
}
function enoughPurity(batch, material, minimumBps) {
    return (BigInt(constituentMass(batch, material)) * 10000n >=
        BigInt(batch.massG) * BigInt(minimumBps));
}
/** Pure suitability calculation on trusted service data; no inventory or authentication. */
export function evaluateUse(input, partId, operatingTemperatureC) {
    const batch = BatchSchema.parse(input);
    const part = getPart(partId);
    if (!part)
        return reject("ineligible", "UNSUPPORTED_PART", "Choose a supported part design.");
    const early = inspectFirst(batch);
    if (early)
        return early;
    const temperature = z
        .number()
        .finite()
        .min(-273.15)
        .max(5000)
        .parse(operatingTemperatureC ?? part.operatingTemperatureC);
    if (!enoughPurity(batch, part.material, part.minimumPurityBps))
        return reject("ineligible", part.material === "hdpe" ? "MIXED_POLYMERS" : "UNSUITABLE_COMPOSITION", "Sort this batch or select a compatible material with sufficient purity.");
    if (batch.form !== part.form)
        return reject("ineligible", "WRONG_FORM", `Use a supported process to produce ${part.form} first.`);
    if (batch.massG < part.minimumMassG)
        return reject("ineligible", "INSUFFICIENT_INPUT", "Recover more compatible material for this part.");
    if (batch.condition !== "sound")
        return reject("ineligible", "DAMAGED_MATERIAL", "Inspect or reprocess damaged stock before making this part.");
    if (part.requiresGrade && !batch.grade)
        return reject("needs-inspection", "UNSUPPORTED_GRADE", "Establish a compatible material grade; processing does not certify it.");
    if (part.requiresGrade &&
        batch.grade &&
        !part.allowedGrades.includes(batch.grade))
        return reject("ineligible", "UNSUPPORTED_GRADE", "This grade is not approved for the selected part design.");
    const serviceRating = batch.properties.find((property) => property.kind === "maxServiceTemperature");
    if (serviceRating?.uncertainty &&
        temperature > serviceRating.uncertainty.upper) {
        return reject("ineligible", "TEMPERATURE_LIMIT", "The requested temperature exceeds this batch's established service limit.");
    }
    if (serviceRating &&
        (!serviceRating.uncertainty ||
            temperature > serviceRating.uncertainty.lower))
        return reject("needs-inspection", "UNCERTAIN_PROPERTY", "The established service-temperature interval does not cover this operating point.");
    if (temperature !== part.operatingTemperatureC &&
        (!serviceRating ||
            temperature < serviceRating.validFromC ||
            temperature > serviceRating.validToC)) {
        return reject("needs-inspection", "PROPERTY_NOT_ESTABLISHED", "This part has no service rating for the requested temperature.");
    }
    for (const requirement of part.properties) {
        const evidence = batch.properties.find((property) => property.kind === requirement.kind);
        if (!evidence ||
            temperature < evidence.validFromC ||
            temperature > evidence.validToC) {
            return reject("needs-inspection", "PROPERTY_NOT_ESTABLISHED", "Obtain the required property evidence for these operating conditions.");
        }
        const minimum = requirement.kind === "maxServiceTemperature"
            ? Math.max(requirement.minimum, temperature)
            : requirement.minimum;
        if (!evidence.uncertainty)
            return reject("needs-inspection", "UNCERTAINTY_UNKNOWN", "Establish a bounded measurement interval before approval.");
        if (evidence.uncertainty.lower < minimum &&
            evidence.uncertainty.upper >= minimum)
            return reject("needs-inspection", "UNCERTAIN_PROPERTY", "The measurement interval crosses the required limit.");
        if (evidence.uncertainty.upper < minimum)
            return reject("ineligible", requirement.kind === "maxServiceTemperature"
                ? "TEMPERATURE_LIMIT"
                : "PROPERTY_LIMIT", "This material does not meet the part requirement under the requested operating conditions.");
    }
    return {
        status: "eligible",
        partId,
        catalogVersion: CATALOG_VERSION,
        operatingTemperatureC: temperature,
        nextActions: ["use-in-supported-manufacturing-recipe"],
    };
}
/** Project established batch knowledge only; hidden composition never appears before grading. */
export function projectBatch(input) {
    const batch = BatchSchema.parse(input);
    const visible = {
        id: batch.id,
        massG: batch.massG,
        form: batch.form,
        inspection: batch.inspection,
    };
    if (batch.inspection !== "graded")
        return visible;
    return {
        ...visible,
        constituents: batch.constituents,
        grade: batch.grade,
        condition: batch.condition,
        hazard: batch.hazard,
        properties: batch.properties,
    };
}
function asSafeInteger(value) {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("ACCOUNTING_OVERFLOW");
    return Number(value);
}
function ceilDivide(value, denominator) {
    return (value + denominator - 1n) / denominator;
}
export function energyForDuration(powerW, durationMs) {
    const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
    integer.parse(powerW);
    integer.parse(durationMs);
    return asSafeInteger(ceilDivide(BigInt(powerW) * BigInt(durationMs), 1000n));
}
/**
 * Calculates a plan, never a mutation. The authoritative service must reserve inputs,
 * debit energy, persist progress, and create each output exactly once.
 * Validated custom recipes support reviewed catalog extensions and conservation tests.
 */
export function calculateProcess(input, recipeInput, machineInput) {
    const batch = BatchSchema.parse(input);
    const recipe = RecipeSchema.parse(recipeInput);
    const machine = MachineSchema.parse(machineInput);
    const early = inspectFirst(batch);
    if (early)
        return early;
    if (!recipe.inputForms.includes(batch.form))
        return reject("ineligible", "WRONG_FORM", "This recipe cannot accept the batch's current form.");
    if (!enoughPurity(batch, recipe.target, recipe.minimumPurityBps))
        return reject("ineligible", recipe.target === "hdpe" ? "MIXED_POLYMERS" : "UNSUITABLE_COMPOSITION", "Sort or inspect the feedstock before using this recipe.");
    if (machine.kind !== recipe.machine || !machine.enabled)
        return reject("ineligible", "MACHINE_UNAVAILABLE", "Use an enabled compatible machine.");
    if (recipe.minimumTemperatureC !== null &&
        (machine.maximumTemperatureC === null ||
            machine.maximumTemperatureC < recipe.minimumTemperatureC))
        return reject("ineligible", "MACHINE_TEMPERATURE_LIMIT", "The machine cannot meet the recipe's operating envelope.");
    if (machine.availablePowerW < recipe.powerW)
        return reject("ineligible", "INSUFFICIENT_POWER", "Allocate enough power to run this recipe.");
    const durationMs = asSafeInteger(ceilDivide(BigInt(batch.massG) * BigInt(recipe.millisecondsPerKg), 1000n));
    const energyJ = energyForDuration(recipe.powerW, durationMs);
    if (machine.availableEnergyJ < energyJ)
        return reject("ineligible", "INSUFFICIENT_ENERGY", "Store or generate enough energy for this batch.");
    const remaining = new Map(batch.constituents.map((entry) => [entry.material, entry.massG]));
    const outputs = [];
    for (const output of recipe.outputs) {
        const constituents = [];
        for (const route of output.routes) {
            const massG = asSafeInteger((BigInt(constituentMass(batch, route.material)) *
                BigInt(route.numerator)) /
                BigInt(route.denominator));
            if (massG === 0)
                continue;
            remaining.set(route.material, (remaining.get(route.material) ?? 0) - massG);
            constituents.push({ material: route.material, massG });
        }
        if (constituents.length)
            outputs.push({
                id: output.id,
                form: output.form,
                massG: constituents.reduce((sum, entry) => sum + entry.massG, 0),
                constituents,
                requiresInspection: true,
            });
    }
    const residue = [...remaining]
        .filter(([, massG]) => massG > 0)
        .map(([material, massG]) => ({ material, massG }));
    if ([...remaining.values()].some((value) => value < 0))
        throw new Error("CONSERVATION_VIOLATION");
    return {
        status: "eligible",
        kind: "process-plan",
        batchId: batch.id,
        catalogVersion: CATALOG_VERSION,
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        inputMassG: batch.massG,
        durationMs,
        energyJ,
        nextActions: ["start-authoritative-processing"],
        outputs,
        residue: {
            massG: residue.reduce((sum, entry) => sum + entry.massG, 0),
            constituents: residue,
        },
    };
}
export function planProcess(input, recipeId, machine) {
    const recipe = getRecipe(recipeId);
    return recipe
        ? calculateProcess(input, recipe, machine)
        : reject("ineligible", "UNSUPPORTED_RECIPE", "Choose a supported process; unknown recipes cannot create material.");
}
/** Dimensional calculations require explicit measurements, never guessed defaults. */
export function conductorLoss(input) {
    const positive = z.number().finite().positive();
    const values = z
        .object({
        conductivitySPerM: positive,
        lengthM: positive,
        areaM2: positive,
        currentA: z.number().finite().min(0),
    })
        .strict()
        .parse(input);
    const resistanceOhm = values.lengthM / (values.conductivitySPerM * values.areaM2);
    const lossW = values.currentA ** 2 * resistanceOhm;
    if (!Number.isFinite(resistanceOhm) ||
        resistanceOhm <= 0 ||
        !Number.isFinite(lossW))
        throw new Error("PROPERTY_CALCULATION_OVERFLOW");
    return { resistanceOhm, lossW };
}
/** Only catalog-approved geometry substitutions; never a universal metal swap. */
export function evaluateSubstitution(input, designId, operatingTemperatureC = 20) {
    const batch = BatchSchema.parse(input);
    const design = listSubstitutions().find((d) => d.id === designId);
    if (!design)
        return reject("ineligible", "UNSUPPORTED_SUBSTITUTION", "Select an approved part-specific substitution.");
    const early = inspectFirst(batch);
    if (early)
        return early;
    if (!enoughPurity(batch, "aluminum", 9900) ||
        batch.grade !== design.grade ||
        batch.form !== design.form ||
        batch.condition !== "sound")
        return reject("ineligible", "UNSUPPORTED_GRADE", "This design needs graded aluminum wire and its specified connector.");
    if (operatingTemperatureC !== design.temperatureC)
        return reject("ineligible", "TEMPERATURE_LIMIT", "This bounded design is approved only at its declared temperature.");
    const conductivity = batch.properties.find((p) => p.kind === "electricalConductivity");
    const density = batch.properties.find((p) => p.kind === "density");
    if (!conductivity?.uncertainty ||
        !density?.uncertainty ||
        [conductivity, density].some((p) => operatingTemperatureC < p.validFromC ||
            operatingTemperatureC > p.validToC))
        return reject("needs-inspection", "PROPERTY_NOT_ESTABLISHED", "Measure conductivity and density, including uncertainty, at the design temperature.");
    const minimumAreaMm2 = (design.baselineAreaMm2 * design.baselineConductivitySPerM) /
        conductivity.uncertainty.lower;
    const areaMm2 = Math.ceil(minimumAreaMm2 / design.areaStepMm2) * design.areaStepMm2;
    if (areaMm2 > design.maximumAreaMm2)
        return reject("ineligible", "GEOMETRY_LIMIT", "Required conductor area exceeds this design's connector envelope.");
    const areaM2 = areaMm2 / 1e6;
    const massG = Math.ceil(density.uncertainty.upper * design.lengthM * areaM2 * 1000);
    if (massG > batch.massG)
        return reject("ineligible", "INSUFFICIENT_INPUT", "Recover enough inspected material for the revised geometry.");
    const performance = conductorLoss({
        conductivitySPerM: conductivity.uncertainty.lower,
        lengthM: design.lengthM,
        areaM2,
        currentA: design.currentA,
    });
    return {
        status: "eligible",
        kind: "substitution-plan",
        designId,
        catalogVersion: CATALOG_VERSION,
        areaMm2,
        areaMultiplier: areaMm2 / design.baselineAreaMm2,
        requiredMassG: massG,
        ...performance,
        requiredConnector: design.requiredConnector,
        operatingTemperatureC,
        nextActions: [
            "obtain-tested-compatible-connector",
            "use-supported-assembly-recipe",
        ],
        basis: "game-balance-fixture",
    };
}
export function evaluateComponent(input, assembly) {
    const c = ComponentSchema.parse(input);
    if (!c.tested)
        return reject("needs-inspection", "NEEDS_COMPONENT_TEST", "Test this component at the inspection bench.");
    if (c.condition !== "sound")
        return reject("ineligible", "DAMAGED_COMPONENT", "This component failed its condition test.");
    if (!c.compatibleAssemblies.includes(assembly))
        return reject("ineligible", "INCOMPATIBLE_COMPONENT", "Choose an assembly covered by this component's recorded test.");
    return {
        status: "eligible",
        componentId: c.id,
        assembly,
        nextActions: ["reserve-in-supported-assembly-recipe"],
    };
}
