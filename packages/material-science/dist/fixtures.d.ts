import { type Machine } from "./schema.js";
/** Deterministic test data, not a claim about measured scrap or production inventory. */
export declare function cableFixture(): {
    id: string;
    catalogVersion: "materials-v2";
    massG: number;
    constituents: {
        material: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
        massG: number;
    }[];
    form: "residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread";
    inspection: "uninspected" | "identified" | "graded";
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
};
export declare function separatorFixture(): Machine;
