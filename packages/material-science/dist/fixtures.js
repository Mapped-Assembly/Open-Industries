import { BatchSchema, CATALOG_VERSION } from "./schema.js";
/** Deterministic test data, not a claim about measured scrap or production inventory. */
export function cableFixture() {
    return BatchSchema.parse({
        id: "fixture-cable",
        catalogVersion: CATALOG_VERSION,
        massG: 10_000,
        constituents: [
            { material: "copper", massG: 6000 },
            { material: "hdpe", massG: 3500 },
            { material: "dirt", massG: 500 },
        ],
        form: "cable",
        inspection: "graded",
        grade: null,
        condition: "sound",
        hazard: "none-detected",
        properties: [],
    });
}
export function separatorFixture() {
    return {
        kind: "cable-separator",
        enabled: true,
        availablePowerW: 500,
        availableEnergyJ: 10_000,
        maximumTemperatureC: null,
    };
}
