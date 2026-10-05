import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { readManifest, hydrateManifest } from '../src/lib/workspace';

const root = mkdtempSync(join(tmpdir(), 'astra-mcp-rooms-'));
const child = spawn(process.execPath, [resolve('server/astra-mcp.mjs')], { env: { ...process.env, ASTRA_ROOT: root }, stdio: ['pipe', 'pipe', 'inherit'] });
let sequence = 0;
const pending = new Map<number, (value: any) => void>();
const lines = createInterface({ input: child.stdout });
lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message.result); pending.delete(message.id); });
function rpc(method: string, params = {}): Promise<any> {
  const id = ++sequence;
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 5000);
    pending.set(id, value => { clearTimeout(timeout); resolvePromise(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const call = (name: string, args = {}) => rpc('tools/call', { name, arguments: args });
try {
  assert.equal((await rpc('initialize')).serverInfo.name, 'mergence');
  const names = (await rpc('tools/list')).tools.map((tool: any) => tool.name);
  for (const name of ['astra.create_room', 'astra.list_rooms', 'astra.read_room', 'astra.write_space_brief']) assert.ok(names.includes(name));
  assert.deepEqual((await call('astra.list_rooms')).structuredContent.rooms, []);
  const args = { name: ' Maker lab ', width: 9, depth: 7, height: 3.2 };
  const created = (await call('astra.create_room', args)).structuredContent;
  assert.equal(created.saved, true);
  assert.equal(created.name, 'Maker lab');
  const disk = JSON.parse(readFileSync(join(root, created.path), 'utf8'));
  assert.deepEqual(disk, created.document);
  const workspace = hydrateManifest(readManifest(disk), []);
  assert.deepEqual(workspace.room, [9, 7, 3.2]);
  assert.deepEqual(workspace.items, []);
  assert.deepEqual((await call('astra.read_room', { id: created.id })).structuredContent.document, disk);
  const bundledRoom = { ...disk, bundledAssets: [{ payload: 'x'.repeat(1024 * 1024 + 1) }] };
  writeFileSync(join(root, created.path), JSON.stringify(bundledRoom));
  const reopened = (await call('astra.read_room', { id: created.id })).structuredContent.document;
  assert.equal(reopened.bundledAssets[0].payload.length, 1024 * 1024 + 1);
  const second = (await call('astra.create_room', args)).structuredContent;
  assert.notEqual(second.id, created.id);
  assert.equal((await call('astra.list_rooms')).structuredContent.rooms.length, 2);
  for (const bad of [{ ...args, name: ' ' }, { ...args, name: 'x'.repeat(121) }, { ...args, width: 0 }, { ...args, height: 101 }, { ...args, depth: '7' }, { ...args, width: null }, { name: 'Missing sizes' }, { ...args, path: '../escape.json' }]) {
    assert.equal((await call('astra.create_room', bad)).isError, true);
  }
  assert.equal((await call('astra.read_room', { id: '../escape' })).isError, true);
  assert.equal((await call('astra.read_room', { id: '00000000-0000-4000-8000-000000000000' })).isError, true);
  assert.equal((await call('astra.list_rooms')).structuredContent.rooms.length, 2);
  rmSync(join(root, created.path));
  let symlinkSupported = true;
  try { symlinkSync(join(root, second.path), join(root, created.path)); }
  catch (error: any) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    symlinkSupported = false;
    console.log('SKIP symlink path checks: Windows symbolic-link privilege is unavailable.');
  }
  if (symlinkSupported) {
    assert.equal((await call('astra.read_room', { id: created.id })).isError, true);
    rmSync(join(root, '.astra', 'rooms'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    try { symlinkSync(join(root, 'elsewhere'), join(root, '.astra', 'rooms'), 'dir'); }
    catch (error: any) {
      if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      symlinkSupported = false;
      console.log('SKIP symlink directory check: Windows symbolic-link privilege is unavailable.');
    }
    if (symlinkSupported) assert.equal((await call('astra.create_room', args)).isError, true);
  }
  console.log(`MCP room creation, persistence, large bundle reads, validation, and ${symlinkSupported ? 'symlink path protection' : 'available path protection checks'} passed.`);
} finally {
  lines.close();
  child.kill();
  rmSync(root, { recursive: true, force: true });
}
