const id = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$',
};
const object = (properties) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const read = object({ instance_id: id });
/** Installed tool contract only; describe does not assert service availability or physical validity. */
export const simulationTools = [
  {
    name: 'astra.simulation_describe',
    description:
      'Describe installed neutral work-cell tools. Results are modeled fixture data, not physical assay evidence.',
    inputSchema: object({}),
  },
  {
    name: 'astra.simulation_create_work_cell',
    description:
      'Create a bounded one-operator work cell with finite stock. Retry an uncertain response with the identical command_id.',
    inputSchema: object({ command_id: id }),
  },
  {
    name: 'astra.simulation_read',
    description:
      'Read an authorized snapshot. Server workers own time, resource accounting and job progress.',
    inputSchema: read,
  },
  {
    name: 'astra.simulation_command',
    description:
      'Start, pause, resume or cancel a modeled job, or transfer 1000 mJ from the finite battery. Use fresh revisions after conflict and identical payloads for lost-response retries.',
    inputSchema: object({
      command_id: id,
      instance_id: id,
      expected_revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      action: { enum: ['start', 'deliver-energy', 'pause', 'resume', 'cancel'] },
      payload: { type: 'object', additionalProperties: false, properties: { job_id: id } },
    }),
  },
  {
    name: 'astra.simulation_history',
    description:
      'Read authorized persisted history. Cursors bind principal and fixed head; refresh a snapshot after CURSOR_EXPIRED.',
    inputSchema: object({
      instance_id: id,
      cursor: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 1024, minLength: 1 }] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }),
  },
];
