import { BALANCE_VERSION, PartSchema, MaterialSchema, RecipeSchema, SubstitutionSchema, } from "./schema.js";
/** Reference values describe pure elements, NOT arbitrary scrap or alloy grades. */
const materials = Object.freeze({
    steel: { name: "Steel", uses: ["graded structural stock"], reference: null },
    aluminum: {
        name: "Aluminum",
        uses: ["compatible housings", "light frames"],
        reference: {
            scope: "pure element",
            densityKgPerM3: 2700,
            meltingPointC: 660.323,
            source: "https://periodic-table.rsc.org/element/13/aluminium",
        },
    },
    copper: {
        name: "Copper",
        uses: ["conductors", "windings"],
        reference: {
            scope: "pure element",
            densityKgPerM3: 8960,
            meltingPointC: 1084.62,
            source: "https://periodic-table.rsc.org/element/29/copper",
        },
    },
    hdpe: {
        name: "HDPE",
        uses: ["compatible low-temperature housings"],
        reference: null,
    },
    glass: { name: "Compatible glass", uses: ["filler"], reference: null },
    rubber: {
        name: "Recovered tire rubber",
        uses: ["reused tread"],
        reference: null,
    },
});
export const listMaterials = () => Object.fromEntries(Object.entries(materials).map(([id, value]) => [
    id,
    MaterialSchema.parse(value),
]));
function singleRecipe(id, target, form, machine, numerator, denominator, minimumTemperatureC = null) {
    return RecipeSchema.parse({
        id,
        version: BALANCE_VERSION,
        target,
        inputForms: ["scrap", "mixed"],
        minimumPurityBps: 9000,
        machine,
        minimumTemperatureC,
        powerW: 500,
        millisecondsPerKg: 2000,
        outputs: [
            {
                id: "usable",
                form,
                routes: [{ material: target, numerator, denominator }],
            },
        ],
        basis: "game-balance-fixture",
    });
}
// Recipe timings, thresholds, and recovery fractions are explicit balance fixtures.
const recipes = [
    RecipeSchema.parse({
        id: "strip-cable",
        version: BALANCE_VERSION,
        target: "copper",
        inputForms: ["cable"],
        minimumPurityBps: 5000,
        machine: "cable-separator",
        minimumTemperatureC: null,
        powerW: 500,
        millisecondsPerKg: 2000,
        outputs: [
            {
                id: "conductor",
                form: "wire",
                routes: [{ material: "copper", numerator: 19, denominator: 20 }],
            },
            {
                id: "insulation",
                form: "flakes",
                routes: [{ material: "hdpe", numerator: 6, denominator: 7 }],
            },
        ],
        basis: "game-balance-fixture",
    }),
    RecipeSchema.parse({
        id: "recover-cable-residue",
        version: BALANCE_VERSION,
        target: "copper",
        inputForms: ["residue"],
        minimumPurityBps: 1,
        machine: "cable-separator",
        minimumTemperatureC: null,
        powerW: 500,
        millisecondsPerKg: 2000,
        outputs: [
            {
                id: "conductor",
                form: "wire",
                routes: [{ material: "copper", numerator: 1, denominator: 2 }],
            },
        ],
        basis: "game-balance-fixture",
    }),
    singleRecipe("press-steel", "steel", "stock", "metal-press", 49, 50),
    singleRecipe("form-aluminum", "aluminum", "stock", "metal-press", 49, 50),
    singleRecipe("mold-hdpe", "hdpe", "stock", "polymer-processor", 9, 10, 180),
    singleRecipe("sort-glass", "glass", "granulate", "sorter", 19, 20),
    singleRecipe("cut-tread", "rubber", "tread", "cutter", 9, 10),
];
// Add flakes as a supported polymer feedstock for the cable-insulation chain.
const hdpeRecipe = recipes.find((recipe) => recipe.id === "mold-hdpe");
if (hdpeRecipe)
    hdpeRecipe.inputForms.push("flakes");
const parts = [
    {
        id: "copper-conductor",
        material: "copper",
        form: "wire",
        minimumMassG: 100,
        minimumPurityBps: 9900,
        requiresGrade: true,
        operatingTemperatureC: 20,
        properties: [{ kind: "electricalConductivity", minimum: 40_000_000 }],
    },
    {
        id: "steel-bracket",
        material: "steel",
        form: "stock",
        minimumMassG: 1000,
        minimumPurityBps: 9800,
        requiresGrade: true,
        operatingTemperatureC: 20,
        properties: [{ kind: "yieldStrength", minimum: 200 }],
    },
    {
        id: "aluminum-housing",
        material: "aluminum",
        form: "stock",
        minimumMassG: 300,
        minimumPurityBps: 9800,
        requiresGrade: true,
        operatingTemperatureC: 20,
        properties: [{ kind: "yieldStrength", minimum: 80 }],
    },
    {
        id: "hdpe-housing",
        material: "hdpe",
        form: "stock",
        minimumMassG: 200,
        minimumPurityBps: 9900,
        requiresGrade: true,
        operatingTemperatureC: 60,
        properties: [{ kind: "maxServiceTemperature", minimum: 60 }],
    },
    {
        id: "glass-filler",
        material: "glass",
        form: "granulate",
        minimumMassG: 500,
        minimumPurityBps: 9800,
        requiresGrade: true,
        operatingTemperatureC: 20,
        properties: [],
    },
    {
        id: "traction-tread",
        material: "rubber",
        form: "tread",
        minimumMassG: 500,
        minimumPurityBps: 9800,
        requiresGrade: true,
        operatingTemperatureC: 20,
        properties: [],
    },
].map((part) => PartSchema.parse({
    ...part,
    allowedGrades: [`game-${part.material}-v1`],
    basis: "game-balance-fixture",
}));
// Return validated copies so callers cannot change the versioned catalog in place.
export const listRecipes = () => recipes.map((recipe) => RecipeSchema.parse(recipe));
export const listParts = () => parts.map((part) => PartSchema.parse(part));
export const getRecipe = (id) => {
    const recipe = recipes.find((candidate) => candidate.id === id);
    return recipe ? RecipeSchema.parse(recipe) : undefined;
};
export const getPart = (id) => {
    const part = parts.find((candidate) => candidate.id === id);
    return part ? PartSchema.parse(part) : undefined;
};
export const listSubstitutions = () => [
    SubstitutionSchema.parse({
        id: "aluminum-power-link-v1",
        material: "aluminum",
        grade: "game-aluminum-v1",
        form: "wire",
        baselineConductivitySPerM: 40000000,
        baselineAreaMm2: 2,
        lengthM: 1,
        currentA: 10,
        areaStepMm2: 0.01,
        maximumAreaMm2: 4,
        temperatureC: 20,
        requiredConnector: "bimetal-terminal-v1",
        basis: "game-balance-fixture",
    }),
];
