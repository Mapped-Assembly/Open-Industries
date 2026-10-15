import { z } from "zod";
export declare const CATALOG_VERSION = "materials-v2";
export declare const BALANCE_VERSION = "balance-v2";
export declare const MAX_MASS_G = 1000000000;
export declare const materialIds: readonly ["steel", "aluminum", "copper", "hdpe", "glass", "rubber", "dirt", "unknown"];
export declare const MaterialIdSchema: z.ZodEnum<{
    steel: "steel";
    aluminum: "aluminum";
    copper: "copper";
    hdpe: "hdpe";
    glass: "glass";
    rubber: "rubber";
    dirt: "dirt";
    unknown: "unknown";
}>;
export type MaterialId = z.infer<typeof MaterialIdSchema>;
export declare const FormSchema: z.ZodEnum<{
    residue: "residue";
    mixed: "mixed";
    cable: "cable";
    scrap: "scrap";
    stock: "stock";
    wire: "wire";
    flakes: "flakes";
    granulate: "granulate";
    tread: "tread";
}>;
export declare const ConstituentSchema: z.ZodObject<{
    material: z.ZodEnum<{
        steel: "steel";
        aluminum: "aluminum";
        copper: "copper";
        hdpe: "hdpe";
        glass: "glass";
        rubber: "rubber";
        dirt: "dirt";
        unknown: "unknown";
    }>;
    massG: z.ZodNumber;
}, z.core.$strict>;
export declare const PropertySchema: z.ZodObject<{
    kind: z.ZodEnum<{
        density: "density";
        electricalConductivity: "electricalConductivity";
        thermalConductivity: "thermalConductivity";
        yieldStrength: "yieldStrength";
        maxServiceTemperature: "maxServiceTemperature";
    }>;
    value: z.ZodNumber;
    unit: z.ZodEnum<{
        "kg/m3": "kg/m3";
        "S/m": "S/m";
        "W/(m*K)": "W/(m*K)";
        MPa: "MPa";
        degC: "degC";
    }>;
    validFromC: z.ZodNumber;
    validToC: z.ZodNumber;
    source: z.ZodString;
    basis: z.ZodDefault<z.ZodEnum<{
        reference: "reference";
        "measurement-fixture": "measurement-fixture";
    }>>;
    uncertainty: z.ZodDefault<z.ZodNullable<z.ZodObject<{
        lower: z.ZodNumber;
        upper: z.ZodNumber;
    }, z.core.$strict>>>;
}, z.core.$strict>;
export declare const BatchSchema: z.ZodObject<{
    id: z.ZodString;
    catalogVersion: z.ZodLiteral<"materials-v2">;
    massG: z.ZodNumber;
    constituents: z.ZodArray<z.ZodObject<{
        material: z.ZodEnum<{
            steel: "steel";
            aluminum: "aluminum";
            copper: "copper";
            hdpe: "hdpe";
            glass: "glass";
            rubber: "rubber";
            dirt: "dirt";
            unknown: "unknown";
        }>;
        massG: z.ZodNumber;
    }, z.core.$strict>>;
    form: z.ZodEnum<{
        residue: "residue";
        mixed: "mixed";
        cable: "cable";
        scrap: "scrap";
        stock: "stock";
        wire: "wire";
        flakes: "flakes";
        granulate: "granulate";
        tread: "tread";
    }>;
    inspection: z.ZodEnum<{
        uninspected: "uninspected";
        identified: "identified";
        graded: "graded";
    }>;
    grade: z.ZodNullable<z.ZodString>;
    condition: z.ZodEnum<{
        unknown: "unknown";
        sound: "sound";
        damaged: "damaged";
    }>;
    hazard: z.ZodEnum<{
        unknown: "unknown";
        "none-detected": "none-detected";
        "suspect-battery": "suspect-battery";
    }>;
    properties: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            density: "density";
            electricalConductivity: "electricalConductivity";
            thermalConductivity: "thermalConductivity";
            yieldStrength: "yieldStrength";
            maxServiceTemperature: "maxServiceTemperature";
        }>;
        value: z.ZodNumber;
        unit: z.ZodEnum<{
            "kg/m3": "kg/m3";
            "S/m": "S/m";
            "W/(m*K)": "W/(m*K)";
            MPa: "MPa";
            degC: "degC";
        }>;
        validFromC: z.ZodNumber;
        validToC: z.ZodNumber;
        source: z.ZodString;
        basis: z.ZodDefault<z.ZodEnum<{
            reference: "reference";
            "measurement-fixture": "measurement-fixture";
        }>>;
        uncertainty: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            lower: z.ZodNumber;
            upper: z.ZodNumber;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Batch = z.infer<typeof BatchSchema>;
export type Property = z.infer<typeof PropertySchema>;
export type Constituent = z.infer<typeof ConstituentSchema>;
export declare const RecipeSchema: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodLiteral<"balance-v2">;
    target: z.ZodEnum<{
        steel: "steel";
        aluminum: "aluminum";
        copper: "copper";
        hdpe: "hdpe";
        glass: "glass";
        rubber: "rubber";
        dirt: "dirt";
        unknown: "unknown";
    }>;
    inputForms: z.ZodArray<z.ZodEnum<{
        residue: "residue";
        mixed: "mixed";
        cable: "cable";
        scrap: "scrap";
        stock: "stock";
        wire: "wire";
        flakes: "flakes";
        granulate: "granulate";
        tread: "tread";
    }>>;
    minimumPurityBps: z.ZodNumber;
    machine: z.ZodString;
    minimumTemperatureC: z.ZodNullable<z.ZodNumber>;
    powerW: z.ZodNumber;
    millisecondsPerKg: z.ZodNumber;
    outputs: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        form: z.ZodEnum<{
            residue: "residue";
            mixed: "mixed";
            cable: "cable";
            scrap: "scrap";
            stock: "stock";
            wire: "wire";
            flakes: "flakes";
            granulate: "granulate";
            tread: "tread";
        }>;
        routes: z.ZodArray<z.ZodObject<{
            material: z.ZodEnum<{
                steel: "steel";
                aluminum: "aluminum";
                copper: "copper";
                hdpe: "hdpe";
                glass: "glass";
                rubber: "rubber";
                dirt: "dirt";
                unknown: "unknown";
            }>;
            numerator: z.ZodNumber;
            denominator: z.ZodNumber;
        }, z.core.$strict>>;
    }, z.core.$strict>>;
    basis: z.ZodLiteral<"game-balance-fixture">;
}, z.core.$strict>;
export type Recipe = z.infer<typeof RecipeSchema>;
export declare const MachineSchema: z.ZodObject<{
    kind: z.ZodString;
    enabled: z.ZodBoolean;
    availablePowerW: z.ZodNumber;
    availableEnergyJ: z.ZodNumber;
    maximumTemperatureC: z.ZodNullable<z.ZodNumber>;
}, z.core.$strict>;
export type Machine = z.infer<typeof MachineSchema>;
export declare const PartSchema: z.ZodObject<{
    id: z.ZodString;
    material: z.ZodEnum<{
        steel: "steel";
        aluminum: "aluminum";
        copper: "copper";
        hdpe: "hdpe";
        glass: "glass";
        rubber: "rubber";
        dirt: "dirt";
        unknown: "unknown";
    }>;
    form: z.ZodEnum<{
        residue: "residue";
        mixed: "mixed";
        cable: "cable";
        scrap: "scrap";
        stock: "stock";
        wire: "wire";
        flakes: "flakes";
        granulate: "granulate";
        tread: "tread";
    }>;
    minimumMassG: z.ZodNumber;
    minimumPurityBps: z.ZodNumber;
    requiresGrade: z.ZodBoolean;
    allowedGrades: z.ZodArray<z.ZodString>;
    operatingTemperatureC: z.ZodNumber;
    properties: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            density: "density";
            electricalConductivity: "electricalConductivity";
            thermalConductivity: "thermalConductivity";
            yieldStrength: "yieldStrength";
            maxServiceTemperature: "maxServiceTemperature";
        }>;
        minimum: z.ZodNumber;
    }, z.core.$strict>>;
    basis: z.ZodLiteral<"game-balance-fixture">;
}, z.core.$strict>;
export type Part = z.infer<typeof PartSchema>;
export declare const ObservationSchema: z.ZodObject<{
    id: z.ZodString;
    owner: z.ZodString;
    targetId: z.ZodString;
    targetRevision: z.ZodNumber;
    targetKind: z.ZodEnum<{
        batch: "batch";
        component: "component";
    }>;
    sensorVersion: z.ZodLiteral<"bench-v1">;
    timestampMs: z.ZodNumber;
    position: z.ZodObject<{
        x: z.ZodNumber;
        y: z.ZodNumber;
    }, z.core.$strict>;
    evidence: z.ZodEnum<{
        "composition-condition": "composition-condition";
        "component-function": "component-function";
    }>;
    uncertaintyMeaning: z.ZodLiteral<"bounded-game-fixture-not-hardware-accuracy">;
    properties: z.ZodArray<z.ZodObject<{
        kind: z.ZodEnum<{
            density: "density";
            electricalConductivity: "electricalConductivity";
            thermalConductivity: "thermalConductivity";
            yieldStrength: "yieldStrength";
            maxServiceTemperature: "maxServiceTemperature";
        }>;
        value: z.ZodNumber;
        unit: z.ZodEnum<{
            "kg/m3": "kg/m3";
            "S/m": "S/m";
            "W/(m*K)": "W/(m*K)";
            MPa: "MPa";
            degC: "degC";
        }>;
        validFromC: z.ZodNumber;
        validToC: z.ZodNumber;
        source: z.ZodString;
        basis: z.ZodDefault<z.ZodEnum<{
            reference: "reference";
            "measurement-fixture": "measurement-fixture";
        }>>;
        uncertainty: z.ZodDefault<z.ZodNullable<z.ZodObject<{
            lower: z.ZodNumber;
            upper: z.ZodNumber;
        }, z.core.$strict>>>;
    }, z.core.$strict>>;
}, z.core.$strict>;
export declare const ComponentSchema: z.ZodObject<{
    id: z.ZodString;
    owner: z.ZodString;
    location: z.ZodString;
    kind: z.ZodString;
    quantity: z.ZodNumber;
    unitMassG: z.ZodNumber;
    condition: z.ZodEnum<{
        unknown: "unknown";
        sound: "sound";
        damaged: "damaged";
    }>;
    tested: z.ZodBoolean;
    compatibleAssemblies: z.ZodArray<z.ZodString>;
    allocation: z.ZodLiteral<"component-only">;
    revision: z.ZodNumber;
}, z.core.$strict>;
export declare const MaterialSchema: z.ZodObject<{
    name: z.ZodString;
    uses: z.ZodArray<z.ZodString>;
    reference: z.ZodNullable<z.ZodObject<{
        scope: z.ZodLiteral<"pure element">;
        densityKgPerM3: z.ZodNumber;
        meltingPointC: z.ZodNumber;
        source: z.ZodURL;
    }, z.core.$strict>>;
}, z.core.$strict>;
export type Observation = z.infer<typeof ObservationSchema>;
export type Component = z.infer<typeof ComponentSchema>;
export declare const SubstitutionSchema: z.ZodObject<{
    id: z.ZodString;
    material: z.ZodLiteral<"aluminum">;
    grade: z.ZodString;
    form: z.ZodLiteral<"wire">;
    baselineConductivitySPerM: z.ZodNumber;
    baselineAreaMm2: z.ZodNumber;
    lengthM: z.ZodNumber;
    currentA: z.ZodNumber;
    areaStepMm2: z.ZodNumber;
    maximumAreaMm2: z.ZodNumber;
    temperatureC: z.ZodNumber;
    requiredConnector: z.ZodString;
    basis: z.ZodLiteral<"game-balance-fixture">;
}, z.core.$strict>;
