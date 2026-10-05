import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dimension = { type: 'number', minimum: 1, maximum: 100 };
const maxRoomFileBytes = 25 * 1024 * 1024;
export const roomTools = [
  { name: 'astra.create_room', description: 'Create an empty room as a local Mergence scene JSON, ready to import into the workbench and arrange equipment. Dimensions are meters. Does not modify the open browser room or save to cloud.', inputSchema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 120 }, width: dimension, depth: dimension, height: dimension }, required: ['name', 'width', 'depth', 'height'] } },
  { name: 'astra.list_rooms', description: 'List rooms created through this local MCP checkout.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'astra.read_room', description: 'Read a room created through this local MCP checkout, including its portable scene document.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Room ID returned by create_room or list_rooms.' } }, required: ['id'], additionalProperties: false } },
];

function directory(root) {
  // Never follow a redirected output directory outside the checkout.
  for (const path of [join(root, '.astra'), join(root, '.astra', 'rooms')]) {
    try { const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('MCP room directories must be ordinary directories inside the checkout.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return join(root, '.astra', 'rooms');
}
const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
const summary = doc => ({ id: doc.id, name: doc.name, room: doc.room, createdAt: doc.createdAt, path: `.astra/rooms/${doc.id}.json` });
function readRoom(dir, id) {
  if (!validId(id)) throw new Error('Provide a room ID returned by create_room or list_rooms.');
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) throw new Error('Local MCP room not found.');
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxRoomFileBytes) throw new Error('Invalid local MCP room file.');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.id !== id || doc.format !== 'astra.scene' || doc.version !== 1) throw new Error('Invalid local MCP room document.');
  return doc;
}

export function callRoomTool(root, name, args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Room arguments must be an object.');
  const allowed = name === 'astra.create_room' ? ['name', 'width', 'depth', 'height'] : name === 'astra.read_room' ? ['id'] : [];
  if (Object.keys(args).some(key => !allowed.includes(key))) throw new Error('Unknown room argument.');
  const dir = directory(root);
  if (name === 'astra.create_room') {
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 120) throw new Error('Room name must contain 1–120 characters.');
    const room = ['width', 'depth', 'height'].map(key => {
      if (typeof args[key] !== 'number' || !Number.isFinite(args[key]) || args[key] < 1 || args[key] > 100) throw new Error(`${key} must be between 1 and 100 meters.`);
      return args[key];
    });
    const document = { format: 'astra.scene', version: 1, units: 'm', upAxis: 'Y', id: randomUUID(), name: args.name.trim(), createdAt: new Date().toISOString(), room, assets: [], instances: [], animation: { duration: 3, loop: true, tracks: [] } };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${document.id}.json`), JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { saved: true, ...summary(document), document, message: 'Import this scene JSON using Drop files or browse in the workbench. Sign in there to save it to cloud.' };
  }
  if (name === 'astra.read_room') { const document = readRoom(dir, args.id); return { ...summary(document), document }; }
  if (name === 'astra.list_rooms') return { rooms: existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.json') && validId(file.slice(0, -5))).sort().map(file => summary(readRoom(dir, file.slice(0, -5)))) : [] };
  throw new Error(`Unknown room tool: ${name}`);
}
