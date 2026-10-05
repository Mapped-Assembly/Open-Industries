import Ajv from 'ajv';

export const SCENE_REQUEST_LIMIT = 1024 * 1024;
const uuid = { type: 'string', pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' };
const id = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[a-zA-Z0-9_.:/-]+$' };
const label = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' };
const vector = { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number', minimum: -1000000, maximum: 1000000 } };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
export const assetReference = { oneOf: [
  object({ kind: { const: 'cloud' }, version_id: uuid }),
  object({ kind: { const: 'example' }, id: { enum: ['cleanroom-architecture', 'cleanroom-robot', 'cleanroom-desk'] } }),
] };
const key = object({ time: { type: 'number', minimum: 0, maximum: 120 }, position: vector, rotation: vector, visible: { type: 'boolean' } }, ['time', 'position', 'rotation']);
const track = object({ instance_id: id, part_id: id, keys: { ...array(key, 10000), minItems: 1 } }, ['instance_id', 'keys']);
const animation = object({ duration: { type: 'number', minimum: 0.5, maximum: 120 }, loop: { type: 'boolean' }, tracks: array(track, 1000) });
const instance = object({ id, name: label, asset: assetReference, position: vector, rotation: vector, visible: { type: 'boolean' } });
const room = object(Object.fromEntries(['width', 'depth', 'height'].map(k => [k, { type: 'number', minimum: 1, maximum: 100 }])));
export const sceneDraft = object({ name: label, room, instances: array(instance, 1000), animation }, ['name', 'room', 'instances']);
const common = { version: { const: 1 }, request_id: uuid, scene: sceneDraft, agent: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-zA-Z0-9_. -]+$' } };
const written = object({ version: { const: 1 }, scene_id: uuid, revision_id: { type: 'integer', minimum: 1 }, head_url: { type: 'string' }, revision_url: { type: 'string' }, access: { const: 'owner' } });
const summaryFields = { asset: assetReference, asset_id: id, name: label, source_kind: { enum: ['form', 'step', 'generated'] } };
const summary = object(summaryFields);
const detail = object({ ...summaryFields, dimensions: vector, parts: array(object({ id, name: { type: 'string' }, representation: { type: 'string' } }), 10000), warnings: array({ type: 'string' }, 1000), provenance: object({ filename: { type: 'string' }, digest: { type: 'string' }, project_id: { type: 'string' }, project_revision: { type: 'string' }, generator: { type: 'string' } }, ['filename', 'digest']) });
export const sceneTools = [
  { name: 'astra.list_scene_assets', description: 'List ready assets owned by the signed-in CLI account and bundled cleanroom examples. Requires explicit ASTRA_SCENE_TOOLS_ENABLED=true setup. Use inspect_scene_asset for dimensions and animation part IDs.', inputSchema: object({ version: { const: 1 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } }, ['version']), outputSchema: object({ version: { const: 1 }, assets: array(summary, 28), next_offset: { type: ['integer', 'null'] } }) },
  { name: 'astra.inspect_scene_asset', description: 'Inspect a selected immutable cloud version or bundled example; returns geometry identity and valid component targets, never raw provider data.', inputSchema: object({ version: { const: 1 }, asset: assetReference }), outputSchema: object({ version: { const: 1 }, asset: detail }) },
  { name: 'astra.create_scene', description: 'Validate and persist a complete scene for the CLI account. request_id is a caller-generated UUID and also the new scene ID; reuse it only for an identical retry. Returns private head and immutable revision URLs.', inputSchema: object(common), outputSchema: written },
  { name: 'astra.update_scene', description: 'Replace an owned scene with a complete validated request using an explicit base_revision. Stale updates return a recoverable conflict. Use a new request_id per edit and reuse it for identical retries.', inputSchema: object({ ...common, scene_id: uuid, base_revision: { type: 'integer', minimum: 1, maximum: 2147483647 } }), outputSchema: written },
  { name: 'astra.read_scene', description: 'Read an owned scene head or immutable revision as an editable typed scene request. Does not modify the local workbench or return credentials/raw project data.', inputSchema: object({ version: { const: 1 }, scene_id: uuid, revision_id: { type: 'integer', minimum: 1, maximum: 2147483647 } }, ['version', 'scene_id']), outputSchema: object({ ...written.properties, scene: sceneDraft, agent: { type: ['string', 'null'] } }) },
];
const ajv = new Ajv({ strict: false, allErrors: false });
const validators = new Map(sceneTools.map(tool => [tool.name, ajv.compile(tool.inputSchema)]));
export class SceneToolError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'SceneToolError'; this.code = code; this.details = details; }
}
export function validateSceneRequest(name, args) {
  if (Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8') > SCENE_REQUEST_LIMIT) throw new SceneToolError('PAYLOAD_TOO_LARGE', 'Scene tool arguments exceed 1 MiB. Reference assets; do not embed geometry.');
  const validate = validators.get(name);
  if (!validate || !validate(args)) {
    const e = validate?.errors?.[0];
    // Do not echo argument values, unknown property names, or raw upstream errors.
    throw new SceneToolError('INVALID_REQUEST', `Invalid scene request${e?.instancePath ? ` at ${e.instancePath}` : ''}. Check the tool input schema (${e?.keyword ?? 'unknown tool'}).`);
  }
  return args;
}

const outputs = new Map(sceneTools.map(tool => [tool.name, ajv.compile(tool.outputSchema)]));
export function validateSceneResult(name, result) {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > SCENE_REQUEST_LIMIT) throw new SceneToolError('PAYLOAD_TOO_LARGE', 'Scene tool response exceeds 1 MiB. Reduce the scene or asset complexity.');
  if (!outputs.get(name)?.(result)) throw new SceneToolError('UNSUPPORTED_DATA', 'Stored data exceeds this version of the tool schema. Inspect or repair it in the workbench.');
  return result;
}
