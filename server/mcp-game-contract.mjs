import { unitVersion, unitProfiles } from './game-units.mjs';
import { manufacturingCatalog, manufacturingVersion } from './game-manufacturing.mjs';
import { recoveryRecipes, recoveryVersion } from './game-recovery.mjs';
import Ajv from 'ajv';
import { jsonSchemas } from '@openindustries/material-science/protocol';
import { catalog, scienceVersions } from './game-materials.mjs';
import { depositKinds, worldVersions } from './game-world.mjs';
import { robotVersion, fieldVersion, sensorCatalog, materialClasses } from './game-robots.mjs';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const uuid = { type: 'string', pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const integer = maximum => ({ type: 'integer', minimum: 0, maximum });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const version = { const: 5 };
const mass = { copper_g: integer(10000), hdpe_g: integer(10000), dirt_g: integer(10000) };
const observation = object({ id: uuid, sensor: { const: 'cable-assay-v1' }, ...mass });
const machine = object({ id: uuid, kind: { const: 'cable-separator' }, status: { enum: ['ready', 'destroyed'] },
  power_w: { const: 500 }, energy_mj: integer(20000000), dissipated_mj: integer(Number.MAX_SAFE_INTEGER) });
const batch = object({ id: uuid, form: { enum: ['cable', 'wire', 'flakes', 'residue', 'mixed', 'stock', 'granulate', 'tread'] },
  state: { enum: ['available', 'reserved', 'consumed'] }, mass_g: integer(10000), ...Object.fromEntries(Object.entries(mass).map(([k, v]) => [k, nullable(v)])), observation_id: nullable(uuid),
  source_job_id: nullable(uuid), output_role: nullable({ enum: ['conductor', 'insulation', 'residue', 'usable'] }),
  grade: { enum: ['assayed-feedstock', 'recovered-ungraded'] } });
const job = object({ id: uuid, machine_id: uuid, input_batch_id: uuid, recipe: { enum: ['strip-cable', 'recover-cable-residue', 'form-steel', 'form-aluminum', 'mold-hdpe', 'inspect-batch', 'inspect-component', ...recoveryRecipes().map(r=>r.id)] },
  recipe_version: { enum: ['dump-v1', 'balance-v2', 'bench-v1', recoveryVersion] }, state: { enum: ['running', 'paused', 'completed', 'cancelled'] },
  pause_reason: nullable({ enum: ['requested', 'power', 'machine-disabled'] }),
  cancellation_reason: nullable({ enum: ['requested', 'machine_destroyed', 'match_abandoned'] }),
  duration_ms: integer(20000), work_ms: integer(20000), energy_mj: integer(10000000) });
const position = object({ x: integer(96), y: integer(56) });
const text = maxLength => ({ type: 'string', maxLength });
const fieldJobActions = ['survey_robot', 'collect_robot', 'return_robot', 'recharge_robot', 'interrupt_robot', 'retreat_robot'];
const field = object({ version: { const: robotVersion }, sensor_version: { const: fieldVersion }, sensor_catalog: { const: sensorCatalog }, transferred_mj: integer(Number.MAX_SAFE_INTEGER),
  robots: array(object({ id: uuid, retired:{type:'boolean'}, position, home: position, capacity_mj: { const: 8000000 }, energy_mj: integer(8000000), initial_mj: integer(8000000),
    charged_mj: integer(Number.MAX_SAFE_INTEGER), spent_mj: integer(Number.MAX_SAFE_INTEGER), payload_g: { const: 10000 }, sensors: array({ enum: sensorCatalog.map(s => s.id) }, 4), job_id: nullable(uuid),
    cargo: array(object({ id: uuid, mass_g: integer(10000), form: { enum: ['cable', 'mixed'] }, inspection: { const: 'uninspected' }, destination: { const: 'inspection-bench' } }), 16) }), 8),
  jobs: array(object({ id: uuid, robot_id: uuid, action: { enum: fieldJobActions }, state: { enum: ['running', 'paused', 'completed', 'cancelled'] }, reason: nullable(text(40)),
    started_at_ms: integer(Number.MAX_SAFE_INTEGER), phase: { enum: ['travel', 'survey', 'collect', 'unload', 'charge', 'complete', 'completed', 'cancelled'] }, target_id: nullable(uuid),
    work_ms: integer(Number.MAX_SAFE_INTEGER), energy_mj: integer(Number.MAX_SAFE_INTEGER), charged_mj: integer(Number.MAX_SAFE_INTEGER), route: array(position, 5400) }), 96),
  observations: array(object({ id: uuid, target_id: uuid, target_revision: { type: 'integer', minimum: 1 }, sensor: { enum: sensorCatalog.map(s => s.id) }, sensor_version: { const: fieldVersion }, position,
    timestamp_ms: integer(Number.MAX_SAFE_INTEGER), range: { type: 'number', minimum: 0, maximum: 120 }, quality: { enum: ['clear', 'dirty', 'occluded', 'low-signal'] }, confidence_bps: integer(10000),
    candidate_classes: array({ enum: materialClasses }, 7), cues: array(text(160), 8), next_actions: array(text(100), 8), uncertainty_meaning: { const: 'bounded-game-fixture-not-hardware-accuracy' } }), 128) });
field.properties.robots.items.required = field.properties.robots.items.required.filter(k=>k!=='retired');
const rect = { x: integer(96), y: integer(56), width: integer(96), height: integer(56) };
const component = { kind: { type: 'string', maxLength: 40 }, quantity: integer(100), unit_mass_g: integer(100000) };
const world = object({
  versions: object(Object.fromEntries(Object.entries(worldVersions).map(([k, v]) => [k, { const: v }]))),
  width: { const: 96 }, height: { const: 56 }, roads: array(object(rect), 8),
  obstacles: array(object({ id: uuid, kind: { const: 'scrap-wall' }, ...rect }), 16),
  outposts: array(object({ id: uuid, label: { type: 'string', maxLength: 60 }, position, owner_slot: { type: 'null' } }), 4),
  towers: array(object({ id: uuid, slot: { enum: [1, 2] }, position, occupied: { type: 'boolean' } }), 2),
    deposits: array(object({ id: uuid, kind: { enum: depositKinds }, home_slot: { enum: [1, 2] }, position, depleted: { type: 'boolean' }, revision: { type: 'integer', minimum: 1 } }), 14),
});
const base = object({ id: uuid, ready_to_finish: { type: 'boolean' },
  assets: array(object({ id: uuid, kind: { enum: ['tower', 'robot', 'solar', 'battery', 'bench', 'fabricator', 'separator'] }, label: { type: 'string', maxLength: 60 }, position,
    components: array(object(component), 10), status: { enum: ['ready', 'parked', 'destroyed'] } }), 8),
  inventory: array(object(component), 128),
  starter_ledger: array(object({ ...component, allocation_id: { type: 'string', maxLength: 36 } }), 40),
  power: object({ solar_w: integer(1000), capacity_mj: { const: 20000000 }, initial_mj: { const: 20000000 }, generated_mj: integer(Number.MAX_SAFE_INTEGER), spilled_mj: integer(Number.MAX_SAFE_INTEGER) }),
});
const materialInput = object({ id: uuid, mass_g: integer(10000), material: { enum: ['copper','steel','aluminum','hdpe','glass','rubber'] } });
const componentInput = object({ id: uuid, kind: text(100), quantity: integer(100), unit_mass_g: integer(100000) });
const production = object({ version: { const: manufacturingVersion }, storage_used: integer(128), storage_slots: { const: 16 }, products: array(object({ id: uuid, kind: text(100), category: { enum: ['part','machine','robot','upgrade','defense'] }, state: { enum: ['available','reserved','installed','destroyed','consumed'] }, enabled: { type:'boolean' }, contents: { type:'object',additionalProperties:integer(1000000) }, components:array(componentInput,128),source_job_id:uuid,mass_g:integer(1000000) }),128), jobs:array(object({id:uuid,machine_id:uuid,recipe:text(100),state:{enum:['waiting','running','paused','completed','cancelled','failed']},reason:nullable(text(60)),duration_ms:integer(20000),work_ms:integer(20000),energy_mj:integer(10000000),material_inputs:array(materialInput,1),product_inputs:array(uuid,16),component_inputs:array(componentInput,32)}),64) });
const manufacturingInputs = { recipe_id:text(100),batch_ids:array(uuid,1),product_ids:array(uuid,16),component_ids:array(uuid,32) };
const previewCommon = {status:{enum:['eligible','ineligible']},code:text(60),message:text(2000),next_actions:array(text(100),8),recipe_id:text(100)};
const manufacturingResult = {type:'object',oneOf:[object({...previewCommon,status:{const:'eligible'},station_id:uuid,duration_ms:integer(20000),power_w:integer(1000),energy_j:integer(20000),materials:array(materialInput,1),products:array(uuid,16),components:array(componentInput,32)}),object({...previewCommon,status:{const:'ineligible'}})]};
const unitState = object({id:uuid,kind:{enum:Object.keys(unitProfiles)},state:{enum:['stowed','deployed','destroyed','salvaged']},enabled:{type:'boolean'},position:nullable(position),health:integer(160),ammunition_ids:array(uuid,4),repair_product_ids:array(uuid,4),last_fired_ms:nullable(integer(Number.MAX_SAFE_INTEGER)),ammunition_count:integer(4),ammunition_capacity:integer(4),operational_ready:{type:'boolean'},can_fire:{const:false},blocked_reasons:array(text(100),8),targets:array(object({id:uuid,kind:{const:'tower'},distance_cells:nullable({type:'number',minimum:0,maximum:120}),in_range:{type:'boolean'},eligible:{const:false},reason:text(100)}),1)});
const unitProjectionSchema=object({version:{const:unitVersion},profiles:{const:unitProfiles},combat_available:{const:false},units:array(unitState,16)});
const status = { enum: ['waiting', 'active', 'completed'] };
export const gameSnapshotSchema = object({
  match_id: uuid, revision: { type: 'integer', minimum: 1 }, status, completion: nullable(object({ reason: { enum: ['abandoned', 'invite-expired', 'recovery-complete'] }, winner_slot: { type: 'null' } })),
  world, base, field, units:unitProjectionSchema, manufacturing: production, legacy_recovery: { type: 'boolean' }, science: object({ versions: object(Object.fromEntries(Object.entries(scienceVersions).map(([k, v]) => [k, { const: v }]))),
    batches: array(object({ id: uuid, revision: { type: 'integer', minimum: 1 }, evidence: jsonSchemas.batch }), 512),
    components: array(jsonSchemas.component, 128), observations: array(jsonSchemas.observation, 256) }), invite_expires_at_ms: nullable(integer(Number.MAX_SAFE_INTEGER)),
  server_time_ms: integer(Number.MAX_SAFE_INTEGER), scheduler_healthy: { type: 'boolean' },
  players: array(object({ slot: { enum: [1, 2] }, you: { type: 'boolean' } }), 2),
  deposits: array(object({ id: uuid, collected: { type: 'boolean' }, observation: nullable(observation) }), 1),
  machines: array(machine, 1), batches: array(batch, 512), jobs: array(job, 256),
});
gameSnapshotSchema.required = gameSnapshotSchema.required.filter(k=>!['manufacturing','units'].includes(k));
const snapshotResult = { version, balance_version: { const: 'dump-world-v1' }, snapshot: gameSnapshotSchema };
const commandResult = object({ ...snapshotResult, command_id: uuid, invite_code: nullable(uuid) });
const common = { version, command_id: uuid, match_id: uuid, expected_revision: { type: 'integer', minimum: 1, maximum: 999999999 } };
const actions = {
  deploy_unit:{unit_id:uuid,position}, set_unit_enabled:{unit_id:uuid,enabled:{type:'boolean'}}, load_unit_ammunition:{unit_id:uuid,ammunition_id:uuid},repair_unit:{unit_id:uuid,product_id:uuid},salvage_unit:{unit_id:uuid},
  enqueue_manufacturing: manufacturingInputs, salvage_starter_asset:{asset_id:uuid}, set_production_machine:{machine_id:uuid,enabled:{type:'boolean'}}, destroy_manufactured_product:{product_id:uuid},
  survey_robot: { robot_id: uuid, deposit_id: uuid, sensor: { enum: sensorCatalog.map(s => s.id) } },
  collect_robot: { robot_id: uuid, deposit_id: uuid, observation_id: uuid, material_class: { enum: materialClasses } },
  return_robot: { robot_id: uuid }, recharge_robot: { robot_id: uuid }, interrupt_robot: { robot_id: uuid }, retreat_robot: { robot_id: uuid },
  inspect_deposit: { deposit_id: uuid },
  collect_deposit: { deposit_id: uuid },
  start_processing: { batch_id: uuid, machine_id: uuid },
  inspect_batch: { batch_id: uuid },
  inspect_component: { component_id: uuid },
  start_material_process: { batch_id: uuid, machine_id: uuid, recipe_id: { type: 'string', minLength: 1, maxLength: 100 } },
  pause_job: { job_id: uuid },
  resume_job: { job_id: uuid },
  cancel_job: { job_id: uuid },
  dismantle_machine: { machine_id: uuid },
  abandon_match: {},
  rotate_invite: {},
  finish_recovery: {},
};
export const gameContract = {
  version: 5, contract: 'city-dump-runtime-v5', balance_version: 'dump-world-v1',
  transport: 'stdio', authentication: 'openindustries-sqlite-session', persistence: 'sqlite-wal',
  scheduler: 'independent-runtime-service', snapshot_scope: 'participant-public-state-and-own-private-state',
  retry_policy: 'same-command-id-and-identical-payload-returns-original-receipt',
  polling: 'full-snapshot-replaces-local-state', ready_for_recovery: true, ready_for_full_game: false,
  supported: ['two-player-invite', 'private-deposit-assay', 'finite-collection', 'durable-cable-processing',
    'pause-resume-cancel', 'owner-dismantling', 'abandon-match', 'restart-catch-up', 'finite-dump-map', 'starter-component-ledger', 'solar-recharging', 'match-list', 'invite-rotation', 'mutual-recovery-completion', 'material-catalog', 'bench-inspection', 'material-suitability', 'component-tests', 'residue-recovery', 'match-science-version-pinning', 'robot-routing', 'private-field-sensing', 'finite-reservations', 'cargo-hauling', 'shared-power-charging', 'interrupt-retreat', 'sensor-upgrade-catalog', 'all-initial-waste-recovery', 'cold-hazard-isolation', 'machine-construction', 'manufacturing-queues', 'tested-component-assembly', 'unit-manufacturing', 'unit-deployment', 'unit-ammunition', 'unit-repair-salvage'],
  unsupported: ['sensor-kit-manufacturing', 'combat', 'capture', 'victory', 'property-certification', 'events'],
};
const cursor = nullable(uuid);
export const gameTools = [
  {name:'astra.game_manufacturing_catalog',description:'Read declared bills of materials, machine requirements, storage limits, time and power fixtures.',inputSchema:object({version,match_id:uuid}),outputSchema:object({version,catalog:{const:manufacturingCatalog()}})},
  {name:'astra.game_manufacturing_preview',description:'Preview exact owned material, manufactured-part and tested-component IDs without reservation or hidden truth.',inputSchema:object({version,match_id:uuid,...manufacturingInputs}),outputSchema:object({version,match_id:uuid,revision:{type:'integer',minimum:1},result:manufacturingResult})},
  { name: 'astra.game_science_catalog', description: 'Read the validated material catalog pinned to this participant match. Reference science and bounded game fixtures are distinct.',
    inputSchema: object({ version, match_id: uuid }), outputSchema: object({ version, catalog: { const: catalog() } }) },
  { name: 'astra.game_evaluate', description: 'Evaluate only an owned batch or component using server evidence and installed machines. No client-supplied materials, properties, recipes or grants. This is a preview, never a mutation.',
    inputSchema: object({ version, match_id: uuid, target_id: uuid, query: { enum: ['use', 'process', 'substitution', 'component'] }, design_id: { type: 'string', minLength: 1, maxLength: 100 }, temperature_c: { type: 'number', minimum: -273.15, maximum: 5000 } }),
    outputSchema: object({ version, match_id: uuid, revision: { type: 'integer', minimum: 1 }, result: jsonSchemas.result }) },
  { name: 'astra.game_list_matches', description: 'List only this account’s matches in stable ID order, at most 20 per page. Resume with next_cursor; no private opponent data or invite secrets are returned.',
    inputSchema: object({ version, cursor }), outputSchema: object({ version, matches: array(object({ match_id: uuid, status, slot: { enum: [1, 2] }, created_at_ms: integer(Number.MAX_SAFE_INTEGER) }), 20), next_cursor: cursor }) },
  { name: 'astra.game_describe', description: 'Discover city-dump runtime v5 scope and authority requirements. This static contract does not assert deployment readiness or full-game support.',
    inputSchema: object({ version }), outputSchema: object(Object.fromEntries(Object.entries(gameContract).map(([key, value]) => [key, { const: value }]))) },
  { name: 'astra.game_create_match', description: 'Create a waiting two-player city-dump match. Requires ASTRA_GAME_TOOLS_ENABLED=true, an OpenIndustries game session and the independent SQLite runtime service. Returns a one-use invite code for deliberate sharing.',
    inputSchema: object({ version, command_id: uuid }), outputSchema: object({ ...snapshotResult, command_id: uuid, invite_code: uuid }) },
  { name: 'astra.game_join_match', description: 'Consume the host’s invite code as the second distinct authenticated participant. No caller-supplied player identity. An identical command retry returns the original receipt.',
    inputSchema: object({ version, command_id: uuid, match_id: uuid, invite_code: uuid }), outputSchema: object({ ...snapshotResult, command_id: uuid }) },
  { name: 'astra.game_read_match', description: 'Read a full participant-scoped reconnect snapshot, catching durable jobs up to database time. Replace local state; do not infer opponent inventory from shared revisions.',
    inputSchema: object({ version, match_id: uuid }), outputSchema: object(snapshotResult) },
  { name: 'astra.game_command', description: 'Issue a version-checked authoritative command. Inspect before collection, then process the owned batch. Recipe, time, power and yields are server-owned. Read after CONFLICT and submit a new command ID; retry uncertain outcomes with the identical ID and payload.',
    inputSchema: { type: 'object', oneOf: Object.entries(actions).map(([action, fields]) => object({ ...common, action: { const: action }, ...fields })) },
    outputSchema: commandResult },
];
export class GameToolError extends Error {
  constructor(code, message) { super(message); this.name = 'GameToolError'; this.code = code; }
}
export const gameErrors = {
  AUTH_REQUIRED: 'Sign in to the OpenIndustries game service with your own account.',
  INVALID_REQUEST: 'Arguments do not match the published game contract.',
  DISABLED: 'Set ASTRA_GAME_TOOLS_ENABLED=true after starting the SQLite game service.',
  NOT_AVAILABLE: 'Match, invitation or object is unavailable to this account.',
  CONFLICT: 'Match revision changed. Read a fresh snapshot, reconcile, then use a new command_id.',
  COMMAND_ID_REUSED: 'This command_id already names another payload. Use a new ID for a different command.',
  LIMIT_REACHED: 'The account or match reached the documented runtime limit.',
  SCHEDULER_UNAVAILABLE: 'The game scheduler is not healthy. Restart or repair the independent runtime service.',
  MATCH_INACTIVE: 'This operation requires an active two-player match.',
  DEPOSIT_EMPTY: 'This deposit has already been collected.',
  ROBOT_REQUIRED: 'Survey and recover this site with a robot, then inspect the delivered batch at the bench.',
  LEGACY_DEPOSIT: 'This migrated match keeps its original starter cable workflow. Robots can recover its other sites.',
  ROBOT_BUSY: 'Interrupt the current robot job or wait for it to finish.',
  ROBOT_ENERGY: 'Recharge first. The robot needs enough energy for the job and a safe return route.',
  ROUTE_BLOCKED: 'No reachable route or sensor viewpoint exists. Choose another site.',
  SENSOR_UNAVAILABLE: 'This sensor is not installed. NIR/thermal kits require supported tested detector hardware.',
  STALE_TARGET: 'The site changed after this observation. Survey again before reserving material.',
  CLASS_UNSUPPORTED: 'Select a candidate class supported by your saved observation, or collect unclassified material for inspection.',
  CARGO_FULL: 'Return to unload before collecting more material.',
  INSPECTION_REQUIRED: 'A server-issued inspection is required before collection or processing.',
  MANUFACTURING_REQUIREMENTS: 'Review the owned bill of materials for missing evidence, components or machines before enqueueing.',
  INVALID_FEEDSTOCK: 'The inspected input is unavailable for this recipe. Evaluate the owned batch for its reason and next actions.',
  UNIT_POWER: 'Insufficient shared base power. Recharge the process battery before commissioning or servicing this unit.',
  UNIT_SITE: 'Choose an unoccupied traversable home-side cell reachable from your tower.',
  NOT_READY: 'The batch, machine or job is not ready for this operation. Read the current snapshot.',
  INVARIANT_FAILED: 'The operation was rolled back because stored game state was inconsistent.',
  OUTCOME_UNKNOWN: 'The operation may have committed. Retry the identical command_id and payload, then read the match.',
  UNAVAILABLE: 'Game runtime is unavailable. Check the SQLite service and session configuration.',
  INVALID_RESULT: 'The runtime returned an unsupported result. Retry the identical command before issuing new work.',
};
// Structured errors are part of the published output contract, including for SDKs
// that validate structuredContent on isError responses.
const errorSchema = object({ error: object({ code: { enum: Object.keys(gameErrors) }, message: { type: 'string', maxLength: 256 } }) });
for (const tool of gameTools) tool.outputSchema = { type: 'object', oneOf: [tool.outputSchema, errorSchema] };
const ajv = new Ajv({ strict: false, allErrors: false });
const validators = new Map(gameTools.map(tool => [tool.name, { input: ajv.compile(tool.inputSchema), output: ajv.compile(tool.outputSchema) }]));
export function gameFail(code) { throw new GameToolError(code, gameErrors[code] ?? gameErrors.UNAVAILABLE); }
export function validateGameRequest(name, value) {
  if (!validators.get(name)?.input(value) || Buffer.byteLength(JSON.stringify(value)) > 8192) gameFail('INVALID_REQUEST');
  return value;
}
export function validateGameResult(name, value) {
  if (!validators.get(name)?.output(value) || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) gameFail('INVALID_RESULT');
  return value;
}
