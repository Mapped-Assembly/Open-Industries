import type { AnySchemaObject } from 'ajv';

/** Reusable strict-object schema helper; unknown envelope fields are rejected. */
export function objectSchema(properties: Record<string, unknown>): AnySchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}
export const identifier = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
};
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const revision = { ...integer, minimum: 1 };
const list = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems });
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
export const pinSchema = objectSchema({
  module_id: identifier,
  module_version: identifier,
  schema_version: revision,
});
export const referenceSchema = objectSchema({ instance_id: identifier, entity_id: identifier });
const units = { enum: ['m', 'mm', 'cell'] };
const coordinate = { type: 'number', minimum: -1e9, maximum: 1e9 };
const location = objectSchema({
  frame_id: identifier,
  unit: units,
  x: coordinate,
  y: coordinate,
  z: coordinate,
});
const jsonObject = { type: 'object' };
export const instanceSchema = objectSchema({
  contract_version: { const: 1 },
  id: identifier,
  pin: pinSchema,
  revision,
  simulation_time_ms: integer,
  members: list(
    objectSchema({ principal_id: identifier, role: { enum: ['owner', 'operator', 'viewer'] } }),
    1024,
  ),
  frames: list(
    objectSchema({ id: identifier, unit: units, axes: { enum: ['xyz', 'xy-grid'] } }),
    64,
  ),
  entities: list(
    objectSchema({
      id: identifier,
      instance_id: identifier,
      kind: identifier,
      revision,
      owner_id: nullable(identifier),
      access: objectSchema({
        read: { enum: ['members', 'owner'] },
        write: { enum: ['operators', 'owner'] },
      }),
      location: nullable(location),
      references: list(referenceSchema, 128),
      data: jsonObject,
    }),
    4096,
  ),
  observations: list(
    objectSchema({
      id: identifier,
      target: referenceSchema,
      owner_id: identifier,
      source_id: identifier,
      source_revision: identifier,
      recorded_at_ms: integer,
      origin: { enum: ['simulated', 'external'] },
      validity: { enum: ['unknown', 'modeled', 'observed'] },
      value: {},
    }),
    4096,
  ),
  state: jsonObject,
});
export const commandSchema = objectSchema({
  command_id: identifier,
  instance_id: identifier,
  expected_revision: revision,
  action: identifier,
  payload: jsonObject,
});
