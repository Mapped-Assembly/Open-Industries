export declare const listMaterials: () => {
    [k: string]: {
        name: string;
        uses: string[];
        reference: {
            scope: "pure element";
            densityKgPerM3: number;
            meltingPointC: number;
            source: string;
        } | null;
    };
};
export declare const listRecipes: () => {
    id: string;
    version: "balance-v2";
    target: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
    inputForms: ("residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread")[];
    minimumPurityBps: number;
    machine: string;
    minimumTemperatureC: number | null;
    powerW: number;
    millisecondsPerKg: number;
    outputs: {
        id: string;
        form: "residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread";
        routes: {
            material: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
            numerator: number;
            denominator: number;
        }[];
    }[];
    basis: "game-balance-fixture";
}[];
export declare const listParts: () => {
    id: string;
    material: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
    form: "residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread";
    minimumMassG: number;
    minimumPurityBps: number;
    requiresGrade: boolean;
    allowedGrades: string[];
    operatingTemperatureC: number;
    properties: {
        kind: "density" | "electricalConductivity" | "thermalConductivity" | "yieldStrength" | "maxServiceTemperature";
        minimum: number;
    }[];
    basis: "game-balance-fixture";
}[];
export declare const getRecipe: (id: string) => {
    id: string;
    version: "balance-v2";
    target: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
    inputForms: ("residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread")[];
    minimumPurityBps: number;
    machine: string;
    minimumTemperatureC: number | null;
    powerW: number;
    millisecondsPerKg: number;
    outputs: {
        id: string;
        form: "residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread";
        routes: {
            material: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
            numerator: number;
            denominator: number;
        }[];
    }[];
    basis: "game-balance-fixture";
} | undefined;
export declare const getPart: (id: string) => {
    id: string;
    material: "steel" | "aluminum" | "copper" | "hdpe" | "glass" | "rubber" | "dirt" | "unknown";
    form: "residue" | "mixed" | "cable" | "scrap" | "stock" | "wire" | "flakes" | "granulate" | "tread";
    minimumMassG: number;
    minimumPurityBps: number;
    requiresGrade: boolean;
    allowedGrades: string[];
    operatingTemperatureC: number;
    properties: {
        kind: "density" | "electricalConductivity" | "thermalConductivity" | "yieldStrength" | "maxServiceTemperature";
        minimum: number;
    }[];
    basis: "game-balance-fixture";
} | undefined;
export declare const listSubstitutions: () => {
    id: string;
    material: "aluminum";
    grade: string;
    form: "wire";
    baselineConductivitySPerM: number;
    baselineAreaMm2: number;
    lengthM: number;
    currentA: number;
    areaStepMm2: number;
    maximumAreaMm2: number;
    temperatureC: number;
    requiredConnector: string;
    basis: "game-balance-fixture";
}[];
