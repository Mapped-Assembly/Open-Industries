#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { configPath, client, sessionClient, writeAuth } from './session.mjs';
import { scrubPortableData } from '../src/lib/portable-data.mjs';

const REDIRECT_URL = process.env.ASTRA_CLI_REDIRECT_URL || 'http://127.0.0.1:54331/callback';
function openBrowser(url) {
  if (platform() === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(platform() === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}
async function login() {
  const supabase = client();
  const callback = createServer(async (request, response) => {
    const url = new URL(request.url, REDIRECT_URL);
    if (url.pathname !== new URL(REDIRECT_URL).pathname || !url.searchParams.get('code')) { response.writeHead(400); response.end('Mergence login was not completed.'); return; }
    const { data, error } = await supabase.auth.exchangeCodeForSession(url.searchParams.get('code'));
    response.writeHead(error ? 500 : 200, { 'content-type': 'text/html' });
    response.end(error ? 'Mergence login failed. You can close this window.' : 'Mergence login completed. You can close this window.');
    callback.close();
    if (error) { console.error(error.message); process.exitCode = 1; return; }
    writeAuth(data.session);
    console.log(`Signed in as ${data.user?.email || data.user?.user_metadata?.user_name || data.user?.id}.`);
  });
  await new Promise((resolvePromise, reject) => callback.once('error', reject).listen(new URL(REDIRECT_URL).port, '127.0.0.1', resolvePromise));
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: REDIRECT_URL, skipBrowserRedirect: true, scopes: 'read:user user:email' } });
  if (error || !data.url) { callback.close(); throw new Error(error?.message || 'GitHub did not provide an Mergence login URL.'); }
  console.log(`Opening GitHub login. If it does not open, visit:\n${data.url}`);
  openBrowser(data.url);
  await new Promise(resolvePromise => callback.once('close', resolvePromise));
}
async function currentUser(supabase) {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new Error('Mergence account could not be read. Sign in again.');
  return data.user;
}
function parseFlag(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}
function requiredArg(value, label) { if (!value) throw new Error(`Missing ${label}.`); return value; }
function readJson(path) {
  try { return JSON.parse(readFileSync(resolve(path), 'utf8')); } catch (error) { throw new Error(`Could not read JSON room ${path}: ${error.message}`); }
}
function validateRoom(document) {
  if (!document || document.format !== 'astra.scene' || document.version !== 1 || document.units !== 'm' || document.upAxis !== 'Y' || !Array.isArray(document.assets) || !Array.isArray(document.instances) || !document.animation) throw new Error('Expected an Mergence scene manifest (astra.scene v1).');
  if (document.instances.length > 1000 || document.animation.tracks?.length > 1000) throw new Error('Room exceeds the Mergence scene limits.');
  return document;
}
function cloudDocument(document) {
  const copy = scrubPortableData(validateRoom(document));
  delete copy.bundledAssets;
  delete copy.bundledVersions;
  copy.authoring = { via: 'cli' };
  copy.instances = copy.instances.map(({ cloudVersionId, ...instance }) => instance);
  return copy;
}
async function listRooms() {
  const { supabase } = await sessionClient(); const user = await currentUser(supabase);
  const { data, error } = await supabase.from('scenes').select('id,name,revision,updated_at').eq('owner_id', user.id).order('updated_at', { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  for (const room of data || []) console.log(`${room.id}\t${room.name}\tr${room.revision}\t${room.updated_at}`);
}
async function exportRoom(id, path) {
  const { supabase } = await sessionClient(); const user = await currentUser(supabase);
  const { data, error } = await supabase.from('scenes').select('id,name,revision,updated_at,document').eq('id', id).eq('owner_id', user.id).single();
  if (error || !data) throw new Error('Cloud room not found for the signed-in Mergence account.');
  validateRoom(data.document); mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(resolve(path), JSON.stringify(scrubPortableData(data.document), null, 2) + '\n', 'utf8');
  console.log(`Exported ${data.name} to ${path}.`);
}
async function importRoom(path, name) {
  const { supabase } = await sessionClient(); const document = cloudDocument(readJson(path));
  const { data: userData, error: userError } = await supabase.auth.getUser(); if (userError || !userData.user) throw new Error('Mergence account could not be read.');
  const assets = (document.assets || []).map(asset => ({ owner_id: userData.user.id, asset_key: asset.id, name: asset.name, source_kind: asset.source.kind, metadata: { dimensions: asset.dimensions, source: asset.source } }));
  if (assets.length) { const result = await supabase.from('assets').upsert(assets, { onConflict: 'owner_id,asset_key' }); if (result.error) throw new Error(result.error.message); }
  const { data, error } = await supabase.rpc('save_workspace_scene', { p_id: randomUUID(), p_name: name || `Imported ${new Date().toLocaleDateString()}`, p_document: document, p_expected_revision: 0, p_write_id: randomUUID() });
  if (error) throw new Error(error.message);
  console.log(`Imported room ${Array.isArray(data) ? data[0]?.id : data?.id || 'successfully'}. Binary geometry was not uploaded; enable cloud storage and save it from Mergence for cross-device geometry.`);
}
function localValidate(path) { const document = validateRoom(readJson(path)); console.log(`Valid Mergence room: ${document.instances.length} instances, ${document.animation.tracks.length} animation tracks.`); }
function help() {
  console.log(`Mergence CLI\n\nAuthentication:\n  astra auth login                         Sign in with GitHub\n  astra auth logout                        Remove the local CLI session\n\nRooms:\n  astra rooms list                         List cloud rooms\n  astra rooms export <id> <file>           Export a cloud room manifest\n  astra rooms import <file> [--name NAME]  Import a local manifest to cloud\n  astra rooms validate <file>              Validate a local Mergence room file\n\nLocal room files are exported/imported by Mergence's browser workbench. Use the CLI to validate them or transfer them to/from cloud storage.`);
}
async function main() {
  const [group, command, ...args] = process.argv.slice(2);
  if (!group || group === '--help' || group === '-h') return help();
  if (group === 'auth' && command === 'login') return login();
  if (group === 'auth' && command === 'logout') { try { writeFileSync(configPath, '', 'utf8'); } catch {} console.log('Mergence CLI session removed.'); return; }
  if (group === 'rooms' && command === 'list') return listRooms();
  if (group === 'rooms' && command === 'export') return exportRoom(requiredArg(args[0], 'cloud room ID'), requiredArg(args[1], 'output file'));
  if (group === 'rooms' && command === 'import') return importRoom(requiredArg(args[0], 'room file'), parseFlag(args, '--name'));
  if (group === 'rooms' && command === 'validate') return localValidate(requiredArg(args[0], 'room file'));
  throw new Error('Unknown Mergence CLI command. Run "astra --help".');
}
main().catch(error => { console.error(`astra: ${error.message}`); process.exitCode = 1; });
