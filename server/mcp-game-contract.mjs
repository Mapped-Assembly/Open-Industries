import Ajv from 'ajv';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const uuid = { type: 'string', pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' };
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const integer = maximum => ({ type: 'integer', minimum: 0, maximum });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const version = { const: 1 };
const mass = { copper_g: integer(10000), hdpe_g: integer(10000), dirt_g: integer(10000) };
const observation = object({ id: uuid, sensor: { const: 'cable-assay-v1' }, ...mass });
const machine = object({ id: uuid, kind: { const: 'cable-separator' }, status: { enum: ['ready', 'destroyed'] },
  power_w: { const: 500 }, energy_mj: integer(20000000), dissipated_mj: integer(20000000) });
const batch = object({ id: uuid, form: { enum: ['cable', 'wire', 'flakes', 'residue'] },
  state: { enum: ['available', 'reserved', 'consumed'] }, ...mass, observation_id: nullable(uuid),
  source_job_id: nullable(uuid), output_role: nullable({ enum: ['conductor', 'insulation', 'residue'] }),
  grade: { enum: ['assayed-feedstock', 'recovered-ungraded'] } });
const job = object({ id: uuid, machine_id: uuid, input_batch_id: uuid, recipe: { const: 'strip-cable' },
  recipe_version: { const: 'dump-v1' }, state: { enum: ['running', 'paused', 'completed', 'cancelled'] },
  pause_reason: nullable({ enum: ['requested', 'power'] }),
  cancellation_reason: nullable({ enum: ['requested', 'machine_destroyed', 'match_abandoned'] }),
  duration_ms: integer(20000), work_ms: integer(20000), energy_mj: integer(10000000) });
export const gameSnapshotSchema = object({
  match_id: uuid, revision: { type: 'integer', minimum: 1 }, status: { enum: ['waiting', 'active', 'abandoned'] },
  server_time_ms: integer(Number.MAX_SAFE_INTEGER), scheduler_healthy: { type: 'boolean' },
  players: array(object({ slot: { enum: [1, 2] }, you: { type: 'boolean' } }), 2),
  deposits: array(object({ id: uuid, collected: { type: 'boolean' }, observation: nullable(observation) }), 1),
  machines: array(machine, 1), batches: array(batch, 4), jobs: array(job, 256),
});
const snapshotResult = { version, balance_version: { const: 'dump-v1' }, snapshot: gameSnapshotSchema };
const commandResult = object({ ...snapshotResult, command_id: uuid });
const common = { version, command_id: uuid, match_id: uuid, expected_revision: { type: 'integer', minimum: 1, maximum: 999999999 } };
const actions = {
  inspect_deposit: { deposit_id: uuid },
  collect_deposit: { deposit_id: uuid },
  start_processing: { batch_id: uuid, machine_id: uuid },
  pause_job: { job_id: uuid },
  resume_job: { job_id: uuid },
  cancel_job: { job_id: uuid },
  dismantle_machine: { machine_id: uuid },
  abandon_match: {},
};
export const gameContract = {
  version: 1, contract: 'city-dump-runtime-v1', balance_version: 'dump-v1',
  transport: 'stdio', authentication: 'verified-supabase-user-session', persistence: 'postgres',
  scheduler: 'pg_cron', snapshot_scope: 'participant-public-state-and-own-private-state',
  retry_policy: 'same-command-id-and-identical-payload-returns-original-receipt',
  polling: 'full-snapshot-replaces-local-state', ready_for_full_game: false,
  supported: ['two-player-invite', 'private-deposit-assay', 'finite-collection', 'durable-cable-processing',
    'pause-resume-cancel', 'owner-dismantling', 'abandon-match', 'restart-catch-up'],
  unsupported: ['moving-robots', 'combat', 'capture', 'victory', 'property-certification', 'recharging', 'events'],
};
export const gameTools = [
  { name: 'astra.game_describe', description: 'Discover city-dump runtime v1 scope and authority requirements. This static contract does not assert deployment readiness or full-game support.',
    inputSchema: object({ version }), outputSchema: object(Object.fromEntries(Object.entries(gameContract).map(([key, value]) => [key, { const: value }]))) },
  { name: 'astra.game_create_match', description: 'Create a waiting two-player city-dump match. Requires ASTRA_GAME_TOOLS_ENABLED=true, verified CLI login, migrated Postgres and a healthy independent scheduler. Returns a one-use invite code for deliberate sharing.',
    inputSchema: object({ version, command_id: uuid }), outputSchema: object({ ...snapshotResult, command_id: uuid, invite_code: uuid }) },
  { name: 'astra.game_join_match', description: 'Consume the host’s invite code as the second distinct authenticated participant. No caller-supplied player identity. An identical command retry returns the original receipt.',
    inputSchema: object({ version, command_id: uuid, match_id: uuid, invite_code: uuid }), outputSchema: commandResult },
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
  AUTH_REQUIRED: 'A verified user session and public Supabase configuration are required. Run astra auth login.',
  INVALID_REQUEST: 'Arguments do not match the published game contract.',
  DISABLED: 'Set ASTRA_GAME_TOOLS_ENABLED=true after configuring authentication, migrations and the database scheduler.',
  NOT_AVAILABLE: 'Match, invitation or object is unavailable to this account.',
  CONFLICT: 'Match revision changed. Read a fresh snapshot, reconcile, then use a new command_id.',
  COMMAND_ID_REUSED: 'This command_id already names another payload. Use a new ID for a different command.',
  LIMIT_REACHED: 'The account or match reached the documented runtime limit.',
  SCHEDULER_UNAVAILABLE: 'The database scheduler is not healthy. Have the deployment owner configure or repair it.',
  MATCH_INACTIVE: 'This operation requires an active two-player match.',
  DEPOSIT_EMPTY: 'This deposit has already been collected.',
  INSPECTION_REQUIRED: 'A server-issued inspection is required before collection or processing.',
  INVALID_FEEDSTOCK: 'The inspected input does not satisfy the cable recipe.',
  NOT_READY: 'The batch, machine or job is not ready for this operation. Read the current snapshot.',
  INVARIANT_FAILED: 'The operation was rolled back because stored game state was inconsistent.',
  OUTCOME_UNKNOWN: 'The operation may have committed. Retry the identical command_id and payload, then read the match.',
  UNAVAILABLE: 'Game runtime is unavailable. Check database migrations, authentication and configuration.',
  INVALID_RESULT: 'The runtime returned an unsupported result. Retry the identical command before issuing new work.',
};
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
