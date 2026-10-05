import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import Ajv from 'ajv';

export const checkout = fileURLToPath(new URL('../../', import.meta.url));
export const clients = ['grok', 'chatgpt', 'codex'];

/** Descriptive client labels and transport variations, not captured vendor sessions. */
export async function loadWorkflow(name) {
  if (!clients.includes(name)) throw new Error(`Choose a fixture client: ${clients.join(', ')}.`);
  const profile = JSON.parse(await readFile(new URL(`../fixtures/agent-workflows/${name}.json`, import.meta.url), 'utf8'));
  const shared = JSON.parse(await readFile(new URL('../fixtures/cleanroom-scene-request.json', import.meta.url), 'utf8'));
  return { ...profile, createRequest: { ...shared, ...profile.create } };
}

export function updateRequest(profile, saved, requestId = profile.update.request_id) {
  const scene = structuredClone(saved.scene);
  const instance = scene.instances.find(item => item.id === profile.update.instance_id);
  if (!instance) throw new Error('This scene is not the cleanroom workflow fixture. No update was sent.');
  scene.room.width = profile.update.room_width;
  instance.position = [...profile.update.position];
  return { version: 1, request_id: requestId, scene_id: saved.scene_id, base_revision: saved.revision_id, agent: profile.update.agent, scene };
}

/** Minimal bounded stdio host shared by the replay command and interoperability tests. */
export function startClient(profile, { root = process.env.ASTRA_ROOT || checkout, env = {}, timeoutMs = 70000 } = {}) {
  const child = spawn(process.execPath, [resolve(checkout, 'server/astra-mcp.mjs')], {
    cwd: checkout, env: { ...process.env, ASTRA_ROOT: root, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0, closed = false;
  const pending = new Map();
  const transcript = [];
  // Do not copy child stderr (which may contain local configuration) into transcripts.
  child.stderr.resume();
  function fail(message) {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(message)); }
    pending.clear();
  }
  child.on('error', () => fail('MCP server could not start. Check Node and npm ci.'));
  child.on('exit', () => fail('MCP server exited before completing the request.'));
  child.stdin.on('error', () => fail('MCP stdin closed.'));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let response;
    try { response = JSON.parse(line); } catch { fail('MCP stdout contained invalid JSON.'); child.kill(); return; }
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id); clearTimeout(entry.timer);
    transcript.push({ direction: 'response', message: response });
    if (response.error) entry.reject(new Error('MCP returned a protocol error.'));
    else entry.resolve(response.result);
  });
  function send(message) {
    transcript.push({ direction: 'request', message });
    child.stdin.write(JSON.stringify(message) + '\n');
  }
  function rpc(method, params = {}) {
    return new Promise((resolveResult, reject) => {
      if (closed) { reject(new Error('MCP connection is closed.')); return; }
      const id = profile.request_ids === 'string' ? `${profile.client}-${++sequence}` : ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timed out during ${method}. Read the scene before retrying a write.`)); }, timeoutMs);
      pending.set(id, { resolve: resolveResult, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  const exited = new Promise(resolveExit => child.once('close', resolveExit));
  return {
    rpc, transcript,
    notify: (method, params = {}) => send({ jsonrpc: '2.0', method, params }),
    call: (name, args) => rpc('tools/call', { name: `astra.${name}`, arguments: args }),
    close: async () => {
      fail('MCP connection closed.'); child.stdin.end(); child.kill();
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(force); lines.close(); }
    },
  };
}

export async function connectWorkflow(client, profile) {
  const initialized = await client.rpc('initialize', profile.initialize);
  if (initialized.protocolVersion !== profile.initialize.protocolVersion || !initialized.capabilities?.tools) throw new Error('Unsupported MCP initialization response.');
  client.notify('notifications/initialized');
  const { tools } = await client.rpc('tools/list');
  const ajv = new Ajv({ strict: false });
  const schemas = new Map(tools.filter(tool => tool.name.startsWith('astra.') && tool.name.includes('scene')).map(tool => [tool.name, {
    input: ajv.compile(tool.inputSchema), output: ajv.compile(tool.outputSchema),
  }]));
  for (const name of ['list_scene_assets', 'inspect_scene_asset', 'create_scene', 'read_scene', 'update_scene']) {
    if (!schemas.has(`astra.${name}`)) throw new Error(`Missing tool: astra.${name}`);
  }
  async function call(name, args) {
    const schema = schemas.get(`astra.${name}`);
    if (!schema?.input(args)) throw new Error(`Arguments do not match the discovered schema for ${name}.`);
    const result = await client.call(name, args);
    // Exercise both standard MCP result representations; no provider-specific parser.
    const text = JSON.parse(result.content.find(item => item.type === 'text').text);
    const data = profile.response_mode === 'text' ? text : result.structuredContent;
    if (profile.response_mode === 'both' && JSON.stringify(text) !== JSON.stringify(data)) throw new Error('MCP result representations disagree.');
    if (result.isError) {
      const error = new Error(data.error.message); error.code = data.error.code;
      error.currentRevision = data.error.current_revision; throw error;
    }
    if (!schema.output(data)) throw new Error(`Result does not match the discovered schema for ${name}.`);
    return data;
  }
  return { call, tools };
}
