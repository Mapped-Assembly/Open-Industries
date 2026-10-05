/**
 * Lossless import contracts for the supported Hardware IR 0.1/0.2 fields.
 * Models follow Form OSS's projects/models.py; fields unused by the spatial
 * viewer may be absent. Unknown extension keys are retained, never coerced.
 * Validation checks structure, not electrical/manufacturing correctness.
 */
// Infer exported TypeScript models from the same field declarations used at runtime.
type Check<T> = { read: (value: unknown, path: string) => T };
type Fields = Record<string, Check<unknown>>;
type Value<C> = C extends Check<infer T> ? T : never;
type OptionalKeys<S extends Fields> = { [K in keyof S]: undefined extends Value<S[K]> ? K : never }[keyof S];
type Model<S extends Fields> = { [K in Exclude<keyof S, OptionalKeys<S>>]: Value<S[K]> }
  & { [K in OptionalKeys<S>]?: Exclude<Value<S[K]>, undefined> };

function invalid(path: string, expected: string): never {
  throw new Error(`Invalid Form ${path}: expected ${expected}.`);
}
export function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'an object');
  return value as Record<string, unknown>;
}
const string: Check<string> = { read: (v, p) => typeof v === 'string' ? v : invalid(p, 'a string') };
const nonempty: Check<string> = { read: (v, p) => typeof v === 'string' && v.trim() ? v : invalid(p, 'a non-empty string') };
const number: Check<number> = { read: (v, p) => typeof v === 'number' && Number.isFinite(v) ? v : invalid(p, 'a finite number') };
const boolean: Check<boolean> = { read: (v, p) => typeof v === 'boolean' ? v : invalid(p, 'a boolean') };
const opaque: Check<unknown> = { read: v => v };
const dictionary: Check<Record<string, unknown>> = { read: objectRecord };
const nonnegative: Check<number> = { read: (v, p) => number.read(v, p) >= 0 ? v as number : invalid(p, 'a non-negative number') };
const positive: Check<number> = { read: (v, p) => number.read(v, p) > 0 ? v as number : invalid(p, 'a positive number') };
const count: Check<number> = { read: (v, p) => Number.isSafeInteger(positive.read(v, p)) ? v as number : invalid(p, 'a positive integer') };
const revision: Check<string | number> = { read: (v, p) => typeof v === 'string' ? nonempty.read(v, p)
  : Number.isSafeInteger(nonnegative.read(v, p)) ? v as number : invalid(p, 'a non-negative integer or revision string') };
function optional<T>(check: Check<T>): Check<T | undefined> {
  return { read: (v, p) => v === undefined ? undefined : check.read(v, p) };
}
function nullable<T>(check: Check<T>): Check<T | null> {
  return { read: (v, p) => v === null ? null : check.read(v, p) };
}
function array<T>(check: Check<T>): Check<T[]> {
  return { read(v, p) {
    if (!Array.isArray(v)) invalid(p, 'an array');
    v.forEach((item, i) => check.read(item, `${p}[${i}]`));
    return v as T[];
  } };
}
function object<S extends Fields>(fields: S): Check<Model<S>> {
  return { read(v, p) {
    const input = objectRecord(v, p);
    for (const [key, check] of Object.entries(fields)) check.read(input[key], `${p}.${key}`);
    return input as Model<S>;
  } };
}
const text = optional(string);
const nullableText = optional(nullable(string));
const numeric = optional(number);
const strings = array(string);
const optionalStrings = optional(strings);
const version: Check<'0.1' | '0.2'> = { read: (v, p) => v === '0.1' || v === '0.2' ? v : invalid(p, 'Hardware IR version 0.1 or 0.2') };

const overview = object({ title: text, description: text, difficulty: text, category: text, estimated_cost: numeric });
const pin = object({ pin_id: nonempty, name: text, pin_type: text, voltage: optional(nullable(number)),
  description: nullableText, direction: nullableText, power_role: nullableText, interface: nullableText });
const dimensions: Check<Record<string, number>> = { read(v, p) {
  const input = objectRecord(v, p);
  for (const [key, value] of Object.entries(input)) number.read(value, `${p}.${key}`);
  return input as Record<string, number>;
} };
const partFields = { name: text, part_number: text, category: text, description: text, manufacturer: nullableText,
  unit_price: optional(nonnegative), sourcing_url: nullableText, datasheet_url: nullableText,
  pins: optional(array(pin)), dimensions_mm: optional(dimensions), electrical_specs: optional(dictionary),
  sourcing_offers: optional(array(dictionary)) };
const component = object({ ...partFields, ref_des: nonempty, part_definition_id: nullableText, rationale: text,
  configuration: optional(dictionary), quantity: optional(count) });
const partDefinition = object({ ...partFields, part_definition_id: nonempty });
const bomRow = object({ ...partFields, line_id: text, part_definition_id: text, instance_refs: optionalStrings,
  quantity: optional(count), extended_price: optional(nonnegative), rationale: text });
const pinReference = object({ ref_des: nonempty, pin_id: nonempty });
const net = object({ net_id: nonempty, name: text, net_type: text, voltage: optional(nullable(number)), pins: optional(array(pinReference)) });
const finding = object({ severity: text, category: text, description: text, message: text, troubleshooting: text });
const findingOrText: Check<Value<typeof finding> | string> = { read: (v, p) => typeof v === 'string' ? v : finding.read(v, p) };
const findings = optional(array(findingOrText));
const validation = object({ critical: findings, error: findings, warning: findings, info: findings,
  is_valid: optional(boolean), issues: findings });
const vector = object({ x_mm: number, y_mm: number, z_mm: number });
const size = object({ x_mm: positive, y_mm: positive, z_mm: positive });
const rotation = object({ x_deg: numeric, y_deg: numeric, z_deg: numeric });
const placement = object({ ref_des: nonempty, label: nullableText, category: nullableText, layer: text,
  position: vector, size, orientation_deg: optional(rotation), mounting_face: nullableText, notes: nullableText });
const spatialRelationship = object({ source_ref_des: nonempty, target_ref_des: nonempty, relation: text,
  axis: nullableText, offset_mm: optional(nullable(number)), notes: nullableText });
const cadSource = object({ name: text, source_type: text, url: text, file_formats: optionalStrings,
  license: nullableText, estimated_unit_price_usd: numeric, notes: nullableText });
function oneOf<const T extends readonly string[]>(values: T): Check<T[number]> {
  return { read: (v, p) => typeof v === 'string' && values.includes(v) ? v : invalid(p, values.join(' or ')) };
}
const pivot: Check<[number, number, number]> = { read(v, p) {
  const result = array(number).read(v, p);
  if (result.length !== 3) invalid(p, 'exactly three finite coordinates');
  return result as [number, number, number];
} };
const motion = object({ motion_id: nullableText, label: nullableText, type: oneOf(['revolute', 'prismatic', 'compliant']), target_ref: nonempty,
  parent_ref: nullableText, axis: optional(oneOf(['X', 'Y', 'Z'])), pivot_mm: optional(pivot), min_deg: optional(nullable(number)),
  max_deg: optional(nullable(number)), min_mm: optional(nullable(number)), max_mm: optional(nullable(number)), notes: nullableText });
const mechanical = object({ physical_form: text, enclosure_type: text, mounting_guidance: text,
  fabrication_details: optionalStrings, fabrication_cost_estimate_usd: numeric, manufacturability_rating: text,
  render_dimensions: optional(nullable(size)), component_placements: optional(array(placement)),
  spatial_relationships: optional(array(spatialRelationship)), cad_sources: optional(array(cadSource)),
  motion_intents: optional(array(motion)), cad_operations: optional(array(dictionary)), mechanism_benchmark: optional(nullable(dictionary)) });
const provenance = object({ project_id: text, revision: optional(revision), source_agent: text, agent: text, authoring_agent: text, compile_revision: optional(revision),
  created_at: text, updated_at: text, generated_at: text, generation_timestamp: text });
const sha256: Check<string> = { read: (v, p) => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v)
  ? v : invalid(p, 'a SHA-256 digest of exactly 64 hexadecimal characters') };
const artifact = object({ path: nonempty, sha256: optional(sha256), kind: text, mime_type: text, size_bytes: optional(nonnegative) });
const assemblyStep = object({ step_num: optional(count), title: text, description: text, danger_flag: optional(boolean),
  danger_message: nullableText, affected_components: optionalStrings });
const requirements = object({ requirements: optionalStrings, power_needs: text, operating_voltage: numeric,
  physical_constraints: optionalStrings, safety_notes: optionalStrings, missing_info: optionalStrings });
const bus = object({ bus_id: nonempty, bus_type: text, clock_frequency_hz: optional(nullable(number)), nets: optionalStrings });
const mapping = object({ mcu_pin: nonempty, connected_to: text, net_name: text });
const rail = object({ rail_id: nonempty, voltage: numeric, max_current_capacity_ma: numeric, source_component: text });
export type FormSystemNode = {
  system_id: string; name?: string; domain?: string; purpose?: string;
  responsibilities?: string[]; constraints?: string[]; expected_component_roles?: string[];
  interfaces?: { name?: string; connects_to: string; purpose?: string }[];
  detail_owner?: string; children?: FormSystemNode[];
};
const systemNode: Check<FormSystemNode> = { read(v, p): FormSystemNode {
  return object({ system_id: nonempty, name: text, domain: text, purpose: text,
    responsibilities: optionalStrings, constraints: optionalStrings, expected_component_roles: optionalStrings,
    interfaces: optional(array(object({ name: text, connects_to: nonempty, purpose: text }))),
    detail_owner: text, children: optional(array(systemNode)) }).read(v, p);
} };
const architecture = object({ summary: text, root: systemNode });
const ir = object({ hardware_ir_version: optional(version), overview: optional(nullable(overview)),
  components: optional(array(component)), part_definitions: optional(array(partDefinition)), bom: optional(array(bomRow)),
  nets: optional(array(net)), validation: optional(nullable(validation)), mechanical: optional(nullable(mechanical)),
  system_architecture: optional(nullable(architecture)),
  assembly_metadata: optional(nullable(provenance)), assembly: optional(array(assemblyStep)), requirements: optional(nullable(requirements)),
  buses: optional(array(bus)), pin_mappings: optional(array(mapping)), power_rails: optional(array(rail)),
  constraints: optionalStrings, fabrication_notes: optionalStrings, estimated_current_draw_ma: numeric,
  is_valid: optional(boolean), project_version_history: optional(array(dictionary)),
  agent: text, artifacts: optional(array(artifact)), cad_model: optional(opaque) });

export type FormSystemArchitecture = Value<typeof architecture>;
export type FormOverview = Value<typeof overview>;
export type FormComponent = Value<typeof component>;
export type FormPartDefinition = Value<typeof partDefinition>;
export type FormBOMRow = Value<typeof bomRow>;
export type FormNet = Value<typeof net>;
export type FormValidation = Value<typeof validation>;
export type FormMechanical = Value<typeof mechanical>;
export type FormProvenance = Value<typeof provenance>;
export type FormArtifact = Value<typeof artifact>;
export type FormIR = Value<typeof ir>;
export type HardwareIRVersion = Value<typeof version>;

export function readHardwareVersion(value: unknown, fallback: HardwareIRVersion, path: string): HardwareIRVersion {
  return value === undefined ? fallback : version.read(value, path);
}
export function readArtifacts(value: unknown, path: string): FormArtifact[] {
  return value === undefined ? [] : array(artifact).read(value, path);
}
export function readProvenance(value: unknown, path: string): FormProvenance {
  return provenance.read(value, path);
}
export function readBOM(value: unknown, path: string): FormBOMRow[] {
  return array(bomRow).read(value, path);
}
export function readHardwareIR(value: unknown, path: string): FormIR {
  const result = ir.read(value, path);
  const refs = new Set<string>();
  for (const [i, item] of (result.components ?? []).entries()) {
    if (refs.has(item.ref_des)) throw new Error(`Duplicate Form component ref_des at ${path}.components[${i}]: ${item.ref_des}`);
    refs.add(item.ref_des);
  }
  const placements = new Set<string>();
  for (const [i, item] of (result.mechanical?.component_placements ?? []).entries()) {
    if (placements.has(item.ref_des)) throw new Error(`Duplicate mechanical ref_des at ${path}.mechanical.component_placements[${i}]: ${item.ref_des}`);
    if (refs.size && !refs.has(item.ref_des)) throw new Error(`Unknown component ref_des at ${path}.mechanical.component_placements[${i}]: ${item.ref_des}`);
    placements.add(item.ref_des);
  }
  return result;
}
