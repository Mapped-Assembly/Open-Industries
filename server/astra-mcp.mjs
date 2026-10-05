#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { callRoomTool, roomTools } from './mcp-rooms.mjs';
import { sceneTools } from './mcp-scene-contract.mjs';
import { gameTools } from './mcp-game-contract.mjs';
import { scrubPortableData as scrub } from '../src/lib/portable-data.mjs';

let sceneRuntime;
let gameRuntime;
async function sceneModule() {
  sceneRuntime ??= import('tsx/esm/api').then(({ tsImport }) => tsImport('./mcp-scenes.ts', import.meta.url));
  return sceneRuntime;
}
async function gameModule() {
  gameRuntime ??= import('tsx/esm/api').then(({ tsImport }) => tsImport('./mcp-game.ts', import.meta.url));
  return gameRuntime;
}

const root = resolve(process.env.ASTRA_ROOT || process.cwd());
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const localPath = value => {
  const candidate = resolve(root, value || '.astra/feedback/latest.json');
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || rel.includes(':')) throw new Error('Mergence MCP paths must stay inside the checkout.');
  return candidate;
};
const textResult = value => { const clean = scrub(value); return { content: [{ type: 'text', text: JSON.stringify(clean, null, 2) }], structuredContent: clean }; };

const tools = [
  ...roomTools,
  ...sceneTools,
  ...gameTools,
  { name: 'astra.read_animation_feedback', description: 'Read the latest scrubbed Mergence authored-animation review for Form iteration.', inputSchema: { type: 'object', properties: {} } },
  { name: 'astra.read_form_project', description: 'Read a local compiled Form project manifest from the Mergence checkout.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Checkout-relative path, usually demo/form-project.json.' } } } },
  { name: 'astra.save_form_project', description: 'Save a Form MCP project_ir back into an existing compiled project manifest.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, project_ir: { type: 'object' } }, required: ['path', 'project_ir'] } },
  { name: 'astra.list_feedback', description: 'List available Mergence animation feedback packages.', inputSchema: { type: 'object', properties: {} } },
  { name: 'astra.write_space_brief', description: 'Record a space requirement for the Mergence local demo planner.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['biofab', 'manufacturing', 'maker'] }, requirements: { type: 'string' } }, required: ['kind', 'requirements'] } },
];

async function callTool(name, args = {}) {
  if (gameTools.some(tool => tool.name === name)) return (await gameModule()).callGameTool(root, name, args);
  if (sceneTools.some(tool => tool.name === name)) return (await sceneModule()).callSceneTool(root, name, args);
  if (roomTools.some(tool => tool.name === name)) return callRoomTool(root, name, args);
  if (name === 'astra.read_animation_feedback') {
    const path = localPath('.astra/feedback/latest.json');
    if (!existsSync(path)) throw new Error('No Mergence animation feedback exists yet. Render an authored timeline animation and send feedback from GIF studio.');
    return scrub(json(path));
  }
  if (name === 'astra.read_form_project') {
    const path = localPath(args.path || 'demo/form-project.json');
    if (!existsSync(path)) throw new Error(`Form project was not found: ${args.path || 'demo/form-project.json'}`);
    return scrub(json(path));
  }
  if (name === 'astra.save_form_project') {
    if (!args.project_ir || typeof args.project_ir !== 'object' || Array.isArray(args.project_ir)) throw new Error('project_ir must be an object.');
    const path = localPath(args.path); if (!existsSync(path)) throw new Error(`Form project was not found: ${args.path}`);
    const current = json(path); const next = scrub({ ...current, project_ir: args.project_ir, agent: current.agent || 'opencode' });
    const serialized = JSON.stringify(next, null, 2); if (Buffer.byteLength(serialized, 'utf8') > 10 * 1024 * 1024) throw new Error('Form project exceeds the 10 MiB local MCP limit.');
    writeFileSync(path, serialized + '\n', 'utf8');
    return { saved: true, path: relative(root, path).replaceAll('\\', '/'), project_id: next.project_id || next.project_ir?.assembly_metadata?.project_id };
  }
  if (name === 'astra.list_feedback') {
    const directory = localPath('.astra/feedback');
    if (!existsSync(directory)) return { files: [] };
    return { files: readdirSync(directory).filter(file => file.endsWith('.json')).sort().reverse() };
  }
  if (name === 'astra.write_space_brief') {
    if (!['biofab', 'manufacturing', 'maker'].includes(args.kind) || typeof args.requirements !== 'string' || !args.requirements.trim() || args.requirements.length > 2000) throw new Error('Provide a supported space kind and requirements up to 2,000 characters.');
    const path = localPath('.astra/space-brief.json'); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ format: 'astra.space-brief', version: 1, kind: args.kind, requirements: args.requirements.trim(), createdAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    return { saved: true, path: '.astra/space-brief.json', message: 'Open Mergence and choose Build space layout to materialize the brief.' };
  }
  throw new Error(`Unknown Mergence MCP tool: ${name}`);
}

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function errorResponse(id, message) { return { jsonrpc: '2.0', id, error: { code: -32000, message } }; }
async function handle(request) {
  if (!Object.hasOwn(request, 'id')) return null;
  if (request.method === 'initialize') return response(request.id, { protocolVersion: '2025-06-18', serverInfo: { name: 'mergence', version: '0.1.0' }, capabilities: { tools: {} } });
  if (request.method === 'ping') return response(request.id, {});
  if (request.method === 'tools/list') return response(request.id, { tools });
  if (request.method === 'tools/call') {
    try { return response(request.id, textResult(await callTool(request.params?.name, request.params?.arguments))); }
    catch (error) {
      if (gameTools.some(tool => tool.name === request.params?.name)) {
        const known = error?.name === 'GameToolError';
        return response(request.id, { ...textResult({ error: { code: known ? error.code : 'UNAVAILABLE',
          message: known ? error.message : 'Game runtime could not start. Check installation and configuration.' } }), isError: true });
      }
      if (sceneTools.some(tool => tool.name === request.params?.name)) {
        const known = error?.name === 'SceneToolError';
        return response(request.id, { ...textResult({ error: { code: known ? error.code : 'OPERATION_FAILED', message: known ? error.message : 'Scene tool could not start. Check local installation and configuration.', ...(known ? error.details : {}) } }), isError: true });
      }
      return response(request.id, { content: [{ type: 'text', text: error.message }], isError: true });
    }
  }
  return errorResponse(request.id, `Unsupported MCP method: ${request.method}`);
}

// Bound memory before parsing and serialize account refreshes and writes. Local
// project handoffs keep their existing 10 MiB limit; scene arguments cap at 1 MiB.
const LINE_LIMIT = 11 * 1024 * 1024;
let buffer = '', dropping = false, pending = 0, queue = Promise.resolve();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
function line(value) {
  let request;
  try { request = JSON.parse(value); if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error(); }
  catch { send(errorResponse(null, 'Invalid JSON-RPC request.')); return; }
  if (pending >= 8) { if (Object.hasOwn(request, 'id')) send(errorResponse(request.id, 'Server busy. Retry after outstanding requests finish.')); return; }
  pending++;
  queue = queue.then(() => handle(request)).then(result => { if (result) send(result); }, () => send(errorResponse(request.id ?? null, 'MCP request failed.'))).finally(() => { pending--; });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  for (const [i, part] of chunk.split('\n').entries()) {
    if (i) {
      if (!dropping && buffer.trim()) line(buffer);
      buffer = ''; dropping = false;
    }
    if (dropping) continue;
    if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > LINE_LIMIT) {
      buffer = ''; dropping = true; send(errorResponse(null, 'MCP request exceeds 11 MiB.'));
    } else buffer += part;
  }
});
process.stdin.on('end', () => { if (!dropping && buffer.trim()) line(buffer); });
