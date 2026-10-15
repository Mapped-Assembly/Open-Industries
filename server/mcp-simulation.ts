import Ajv, { type AnySchemaObject } from 'ajv';
import { simulationTools } from './mcp-simulation-contract.mjs';
import { copyJson } from './simulation/json.mjs';
import { workCellPin, workCellModule } from './domains/work-cell.js';
import { objectSchema, identifier, pinSchema } from './simulation/schema.js';
import type { JsonObject } from './simulation/contracts.js';

/** Sanitized transport errors contain no credentials, private state or remote diagnostics. */
export class SimulationToolError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'SimulationToolError';
  }
}
const validators = new Map(
  simulationTools.map((tool) => [tool.name, new Ajv({ strict: true }).compile(tool.inputSchema)]),
);
const projection = workCellModule.projectionSchema;
const maybeProjection = { anyOf: [{ type: 'null' }, projection] };
const resultDefinitions: [string, AnySchemaObject][] = [
  [
    'astra.simulation_create_work_cell',
    objectSchema({ command_id: identifier, snapshot: projection }),
  ],
  ['astra.simulation_read', objectSchema({ snapshot: projection })],
  ['astra.simulation_command', objectSchema({ command_id: identifier, snapshot: projection })],
  [
    'astra.simulation_history',
    objectSchema({
      version: { const: 1 },
      snapshot: maybeProjection,
      checkpoint: maybeProjection,
      events: {
        type: 'array',
        maxItems: 100,
        items: objectSchema({
          id: identifier,
          instance_id: identifier,
          command_id: { anyOf: [identifier, { type: 'null' }] },
          kind: { enum: ['command', 'worker', 'system'] },
          action: identifier,
          simulation_time_ms: { type: 'integer', minimum: 0 },
          rule: pinSchema,
          snapshot: projection,
        }),
      },
      next_cursor: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 1024 }] },
    }),
  ],
];
const resultSchemas = new Map(
  resultDefinitions.map(([name, schema]) => [name, new Ajv({ strict: true }).compile(schema)]),
);
const routes: Record<string, string> = {
  'astra.simulation_create_work_cell': '/simulation/instances',
  'astra.simulation_read': '/simulation/read',
  'astra.simulation_command': '/simulation/command',
  'astra.simulation_history': '/simulation/history',
};

/** Thin MCP transport to the independently running SQLite service; never mutates local copies. */
export async function callSimulationTool(name: string, raw: unknown): Promise<JsonObject> {
  const args = copyJson(raw, () => {
    throw new SimulationToolError('INVALID_REQUEST');
  });
  if (!validators.get(name)?.(args)) throw new SimulationToolError('INVALID_REQUEST');
  if (name === 'astra.simulation_describe')
    return {
      version: 1,
      rule: JSON.parse(JSON.stringify(workCellPin)),
      modeled_fixture: true,
      requires_service: true,
    };
  if (process.env.ASTRA_SIMULATION_TOOLS_ENABLED !== 'true')
    throw new SimulationToolError('DISABLED');
  const token = process.env.ASTRA_SIMULATION_SESSION;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new SimulationToolError('AUTH_REQUIRED');
  let url: URL;
  try {
    url = new URL(process.env.ASTRA_SIMULATION_SERVICE_URL ?? 'http://127.0.0.1:8791');
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw Error();
  } catch {
    throw new SimulationToolError('UNAVAILABLE');
  }
  try {
    const response = await fetch(new URL(routes[name]!, url), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(args),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new SimulationToolError('OUTCOME_UNKNOWN');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new SimulationToolError('INVALID_RESULT');
      }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString());
    if (!response.ok) {
      const allowed = new Set([
        'AUTH_REQUIRED',
        'NOT_AVAILABLE',
        'INVALID_REQUEST',
        'CONFLICT',
        'COMMAND_ID_REUSED',
        'INVALID_TRANSITION',
        'CATCHUP_REQUIRED',
        'LIMIT_REACHED',
        'CURSOR_EXPIRED',
      ]);
      throw new SimulationToolError(
        allowed.has(result?.error?.code) ? result.error.code : 'UNAVAILABLE',
      );
    }
    if (!resultSchemas.get(name)?.(result)) throw new SimulationToolError('INVALID_RESULT');
    return copyJson(result, () => {
      throw new SimulationToolError('INVALID_RESULT');
    }) as JsonObject;
  } catch (error) {
    if (error instanceof SimulationToolError) throw error;
    throw new SimulationToolError('OUTCOME_UNKNOWN');
  }
}
