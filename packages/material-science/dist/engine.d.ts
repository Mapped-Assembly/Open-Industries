import { type Batch, type Constituent, type MaterialId } from "./schema.js";
export type Rejection = {
    status: "ineligible" | "needs-inspection";
    code: string;
    message: string;
    nextActions: string[];
};
export declare function constituentMass(batch: Batch, material: MaterialId): number;
/** Pure suitability calculation on trusted service data; no inventory or authentication. */
export declare function evaluateUse(input: unknown, partId: string, operatingTemperatureC?: number): Rejection | {
    status: "eligible";
    partId: string;
    catalogVersion: string;
    operatingTemperatureC: number;
    nextActions: string[];
};
/** Project established batch knowledge only; hidden composition never appears before grading. */
export declare function projectBatch(input: unknown): {
    id: string;
    massG: number;
    form: "residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread";
    inspection: "uninspected" | "identified" | "graded";
} | {
    constituents: {
        material: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
        massG: number;
    }[];
    grade: string | null;
    condition: "unknown" | "sound" | "damaged";
    hazard: "unknown" | "none-detected" | "suspect-battery";
    properties: {
        kind: "density" | "electricalConductivity" | "thermalConductivity" | "yieldStrength" | "maxServiceTemperature";
        value: number;
        unit: "kg/m3" | "S/m" | "W/(m*K)" | "MPa" | "degC";
        validFromC: number;
        validToC: number;
        source: string;
        basis: "reference" | "measurement-fixture";
        uncertainty: {
            lower: number;
            upper: number;
        } | null;
    }[];
    id: string;
    massG: number;
    form: "residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread";
    inspection: "uninspected" | "identified" | "graded";
};
export declare function energyForDuration(powerW: number, durationMs: number): number;
export type ProcessStream = {
    id: string;
    form: Batch["form"];
    massG: number;
    constituents: Constituent[];
    requiresInspection: true;
};
/**
 * Calculates a plan, never a mutation. The authoritative service must reserve inputs,
 * debit energy, persist progress, and create each output exactly once.
 * Validated custom recipes support reviewed catalog extensions and conservation tests.
 */
export declare function calculateProcess(input: unknown, recipeInput: unknown, machineInput: unknown): Rejection | {
    status: "eligible";
    kind: "process-plan";
    batchId: string;
    catalogVersion: string;
    recipeId: string;
    recipeVersion: "balance-v2";
    inputMassG: number;
    durationMs: number;
    energyJ: number;
    nextActions: string[];
    outputs: ProcessStream[];
    residue: {
        massG: number;
        constituents: {
            material: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
            massG: number;
        }[];
    };
};
export declare function planProcess(input: unknown, recipeId: string, machine: unknown): Rejection | {
    status: "eligible";
    kind: "process-plan";
    batchId: string;
    catalogVersion: string;
    recipeId: string;
    recipeVersion: "balance-v2";
    inputMassG: number;
    durationMs: number;
    energyJ: number;
    nextActions: string[];
    outputs: ProcessStream[];
    residue: {
        massG: number;
        constituents: {
            material: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
            massG: number;
        }[];
    };
};
/** Dimensional calculations require explicit measurements, never guessed defaults. */
export declare function conductorLoss(input: {
    conductivitySPerM: number;
    lengthM: number;
    areaM2: number;
    currentA: number;
}): {
    resistanceOhm: number;
    lossW: number;
};
/** Only catalog-approved geometry substitutions; never a universal metal swap. */
export declare function evaluateSubstitution(input: unknown, designId: string, operatingTemperatureC?: number): Rejection | {
    requiredConnector: string;
    operatingTemperatureC: number;
    nextActions: string[];
    basis: string;
    resistanceOhm: number;
    lossW: number;
    status: "eligible";
    kind: "substitution-plan";
    designId: string;
    catalogVersion: string;
    areaMm2: number;
    areaMultiplier: number;
    requiredMassG: number;
};
export declare function evaluateComponent(input: unknown, assembly: string): Rejection | {
    status: "eligible";
    componentId: string;
    assembly: string;
    nextActions: string[];
};
