import { z } from "zod";
export declare const ResultSchema: z.ZodUnion<readonly [z.ZodObject<{
    status: z.ZodEnum<{
        ineligible: "ineligible";
        "needs-inspection": "needs-inspection";
    }>;
    code: z.ZodString;
    message: z.ZodString;
    nextActions: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"eligible">;
    partId: z.ZodString;
    catalogVersion: z.ZodLiteral<"materials-v2">;
    operatingTemperatureC: z.ZodNumber;
    nextActions: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"eligible">;
    componentId: z.ZodString;
    assembly: z.ZodString;
    nextActions: z.ZodArray<z.ZodString>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"eligible">;
    kind: z.ZodLiteral<"process-plan">;
    batchId: z.ZodString;
    catalogVersion: z.ZodLiteral<"materials-v2">;
    recipeId: z.ZodString;
    recipeVersion: z.ZodLiteral<"balance-v2">;
    inputMassG: z.ZodNumber;
    durationMs: z.ZodNumber;
    energyJ: z.ZodNumber;
    nextActions: z.ZodArray<z.ZodString>;
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
        requiresInspection: z.ZodLiteral<true>;
    }, z.core.$strict>>;
    residue: z.ZodObject<{
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
    }, z.core.$strict>;
}, z.core.$strict>, z.ZodObject<{
    status: z.ZodLiteral<"eligible">;
    kind: z.ZodLiteral<"substitution-plan">;
    designId: z.ZodString;
    catalogVersion: z.ZodLiteral<"materials-v2">;
    areaMm2: z.ZodNumber;
    areaMultiplier: z.ZodNumber;
    requiredMassG: z.ZodNumber;
    resistanceOhm: z.ZodNumber;
    lossW: z.ZodNumber;
    requiredConnector: z.ZodString;
    operatingTemperatureC: z.ZodNumber;
    nextActions: z.ZodArray<z.ZodString>;
    basis: z.ZodLiteral<"game-balance-fixture">;
}, z.core.$strict>]>;
export declare const jsonSchemas: {
    [k: string]: {
        [k: string]: unknown;
        "~standard": z.core.ZodStandardSchemaWithJSON<z.ZodObject<{
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
        }, z.core.$strict> | z.ZodObject<{
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
        }, z.core.$strict> | z.ZodUnion<readonly [z.ZodObject<{
            status: z.ZodEnum<{
                ineligible: "ineligible";
                "needs-inspection": "needs-inspection";
            }>;
            code: z.ZodString;
            message: z.ZodString;
            nextActions: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"eligible">;
            partId: z.ZodString;
            catalogVersion: z.ZodLiteral<"materials-v2">;
            operatingTemperatureC: z.ZodNumber;
            nextActions: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"eligible">;
            componentId: z.ZodString;
            assembly: z.ZodString;
            nextActions: z.ZodArray<z.ZodString>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"eligible">;
            kind: z.ZodLiteral<"process-plan">;
            batchId: z.ZodString;
            catalogVersion: z.ZodLiteral<"materials-v2">;
            recipeId: z.ZodString;
            recipeVersion: z.ZodLiteral<"balance-v2">;
            inputMassG: z.ZodNumber;
            durationMs: z.ZodNumber;
            energyJ: z.ZodNumber;
            nextActions: z.ZodArray<z.ZodString>;
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
                requiresInspection: z.ZodLiteral<true>;
            }, z.core.$strict>>;
            residue: z.ZodObject<{
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
            }, z.core.$strict>;
        }, z.core.$strict>, z.ZodObject<{
            status: z.ZodLiteral<"eligible">;
            kind: z.ZodLiteral<"substitution-plan">;
            designId: z.ZodString;
            catalogVersion: z.ZodLiteral<"materials-v2">;
            areaMm2: z.ZodNumber;
            areaMultiplier: z.ZodNumber;
            requiredMassG: z.ZodNumber;
            resistanceOhm: z.ZodNumber;
            lossW: z.ZodNumber;
            requiredConnector: z.ZodString;
            operatingTemperatureC: z.ZodNumber;
            nextActions: z.ZodArray<z.ZodString>;
            basis: z.ZodLiteral<"game-balance-fixture">;
        }, z.core.$strict>]> | z.ZodUnion<readonly [z.ZodObject<{
            massG: z.ZodNumber;
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
        }, z.core.$strict>, z.ZodObject<{
            id: z.ZodString;
            massG: z.ZodNumber;
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
            }>;
        }, z.core.$strict>]>>;
        $id?: string;
        $anchor?: string;
        $ref?: string;
        $dynamicRef?: string;
        $dynamicAnchor?: string;
        $vocabulary?: Record<string, boolean>;
        $comment?: string;
        $defs?: Record<string, z.core.JSONSchema.JSONSchema>;
        type?: z.core.JSONSchema.SchemaType | z.core.JSONSchema.SchemaType[];
        additionalItems?: z.core.JSONSchema._JSONSchema;
        unevaluatedItems?: z.core.JSONSchema._JSONSchema;
        prefixItems?: z.core.JSONSchema._JSONSchema[];
        items?: z.core.JSONSchema._JSONSchema | z.core.JSONSchema._JSONSchema[];
        contains?: z.core.JSONSchema._JSONSchema;
        additionalProperties?: z.core.JSONSchema._JSONSchema;
        unevaluatedProperties?: z.core.JSONSchema._JSONSchema;
        properties?: Record<string, z.core.JSONSchema._JSONSchema>;
        patternProperties?: Record<string, z.core.JSONSchema._JSONSchema>;
        dependentSchemas?: Record<string, z.core.JSONSchema._JSONSchema>;
        propertyNames?: z.core.JSONSchema._JSONSchema;
        if?: z.core.JSONSchema._JSONSchema;
        then?: z.core.JSONSchema._JSONSchema;
        else?: z.core.JSONSchema._JSONSchema;
        allOf?: z.core.JSONSchema.JSONSchema[];
        anyOf?: z.core.JSONSchema.JSONSchema[];
        oneOf?: z.core.JSONSchema.JSONSchema[];
        not?: z.core.JSONSchema._JSONSchema;
        multipleOf?: number;
        maximum?: number;
        exclusiveMaximum?: number | boolean;
        minimum?: number;
        exclusiveMinimum?: number | boolean;
        maxLength?: number;
        minLength?: number;
        pattern?: string;
        maxItems?: number;
        minItems?: number;
        uniqueItems?: boolean;
        maxContains?: number;
        minContains?: number;
        maxProperties?: number;
        minProperties?: number;
        required?: string[];
        dependentRequired?: Record<string, string[]>;
        enum?: Array<string | number | boolean | null>;
        const?: string | number | boolean | null;
        id?: string;
        title?: string;
        description?: string;
        default?: unknown;
        deprecated?: boolean;
        readOnly?: boolean;
        writeOnly?: boolean;
        nullable?: boolean;
        examples?: unknown[];
        format?: string;
        contentMediaType?: string;
        contentEncoding?: string;
        contentSchema?: z.core.JSONSchema.JSONSchema;
        _prefault?: unknown;
    };
};
