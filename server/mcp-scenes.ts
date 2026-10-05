import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CloudStorage, parseCloudBundle, type CloudVersion } from '../src/lib/cloud-storage.ts';
import { canonicalJSON, hydrateManifest, makeManifest, readManifest, type Animation, type Workspace } from '../src/lib/workspace.ts';
import type { Asset, Vec3 } from '../src/lib/scene.ts';
import { sceneURLs } from '../src/lib/scene-links.ts';
import { sessionClient, loadEnv } from '../cli/session.mjs';
import { SceneToolError, validateSceneRequest, validateSceneResult } from './mcp-scene-contract.mjs';

type AssetRef = { kind: 'cloud'; version_id: string } | { kind: 'example'; id: string };
type Draft = { name: string; room: { width: number; depth: number; height: number }; instances: { id: string; name: string; asset: AssetRef; position: Vec3; rotation: Vec3; visible: boolean }[];
  animation: { duration: number; loop: boolean; tracks: { instance_id: string; part_id?: string; keys: { time: number; position: Vec3; rotation: Vec3; visible?: boolean }[] }[] } };
type Request = { version: 1; request_id: string; agent: string; scene: Draft; scene_id?: string; base_revision?: number; revision_id?: number; asset?: AssetRef; offset?: number };
export type SceneContext = { client: SupabaseClient; owner: string; origin: string; signal: AbortSignal };
const examples = [
  { id: 'cleanroom-architecture', index: 0 }, { id: 'cleanroom-robot', index: 1 }, { id: 'cleanroom-desk', index: 2 },
];
const limits = { totalGeometry: 50 * 1024 * 1024, manifest: 1024 * 1024 };
const fail = (code: string, message: string, details = {}) => { throw new SceneToolError(code, message, details); };
const active = (ctx: SceneContext) => { if (ctx.signal.aborted) fail('TIMEOUT', 'Scene operation timed out. Read the scene before retrying the identical request_id.'); };
export function workbenchOrigin(value = 'http://127.0.0.1:5173') {
  let url: URL; try { url = new URL(value); } catch { return fail('CONFIGURATION', 'ASTRA_WORKBENCH_ORIGIN must be an HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') return fail('CONFIGURATION', 'ASTRA_WORKBENCH_ORIGIN must contain only an HTTP(S) origin, without credentials or a path.');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return fail('CONFIGURATION', 'Use HTTPS for non-loopback workbench origins.');
  return url.origin;
}
async function bundledAssets(): Promise<Asset[]> {
  const text = await readFile(new URL('../public/examples/cleanroom/cleanroom-suite.json', import.meta.url), 'utf8');
  return JSON.parse(text).bundledAssets;
}
function summary(asset: Asset, ref: AssetRef) { return { asset: ref, asset_id: asset.id, name: asset.name, source_kind: asset.source.kind }; }
function description(asset: Asset, ref: AssetRef) {
  return { ...summary(asset, ref), dimensions: asset.dimensions,
    parts: asset.parts.map(part => ({ id: part.id, name: part.name, representation: part.metadata.representation ?? 'Imported geometry' })), warnings: asset.warnings,
    provenance: { filename: asset.source.filename, digest: asset.source.digest,
      ...(asset.source.projectId ? { project_id: asset.source.projectId } : {}),
      ...(asset.formProject?.revision ? { project_revision: asset.formProject.revision } : {}),
      ...(asset.source.kind === 'generated' ? { generator: asset.source.generator } : {}) } };
}
function animation(draft: Draft): Animation {
  return { duration: draft.animation.duration, loop: draft.animation.loop, tracks: draft.animation.tracks.map(track => ({
    id: `${track.instance_id}:${track.part_id ?? 'instance'}`, instanceId: track.instance_id, ...(track.part_id ? { partId: track.part_id } : {}),
    keys: track.keys.map((key, i) => ({ ...key, id: `key-${i}` })),
  })) };
}
function result(scene: { id: string; revision: number }, origin: string) {
  return { version: 1, scene_id: scene.id, revision_id: scene.revision, ...sceneURLs(scene.id, scene.revision, origin), access: 'owner' };
}
async function ownedHead(ctx: SceneContext, id: string) {
  const { data, error } = await ctx.client.from('scenes').select('id,revision,last_write_id,document').eq('id', id).eq('owner_id', ctx.owner).maybeSingle();
  active(ctx);
  if (error) fail('SCENE_UNAVAILABLE', 'Could not read this account’s scene. Check authentication and database setup.');
  return data;
}
export async function executeSceneTool(name: string, raw: unknown, ctx: SceneContext) {
  const args = validateSceneRequest(name, raw) as Request;
  active(ctx);
  const storage = new CloudStorage(ctx.client, ctx.owner);
  let geometryBytes = 0;
  const loaded = new Map<string, { asset: Asset; version?: string }>();
  async function load(ref: AssetRef) {
    const key = canonicalJSON(ref); const cached = loaded.get(key); if (cached) return cached;
    active(ctx);
    let text: string; let version: CloudVersion | undefined;
    if (ref.kind === 'example') {
      const item = examples.find(example => example.id === ref.id);
      if (!item) return fail('ASSET_UNAVAILABLE', 'Unknown example asset. Use list_scene_assets.');
      const asset = (await bundledAssets())[item.index];
      text = JSON.stringify({ schemaVersion: 1, asset });
    } else {
      const selected = await ctx.client.from('asset_file_versions').select('*,asset:assets(name,asset_key,source_kind)').eq('id', ref.version_id).eq('owner_id', ctx.owner).eq('state', 'ready').maybeSingle();
      active(ctx);
      if (selected.error || !selected.data) return fail('ASSET_UNAVAILABLE', 'Asset version is missing, not ready, or unavailable to this account.');
      version = selected.data as CloudVersion;
      const file = version.files.find(file => file.name === 'asset.json');
      if (!file || file.size > 25 * 1024 * 1024 || file.size + geometryBytes > limits.totalGeometry) return fail('PAYLOAD_TOO_LARGE', 'Referenced geometry exceeds the 25 MiB/file or 50 MiB/request limit.');
      try { text = await (await storage.downloadFile(version, 'asset.json')).text(); }
      catch { active(ctx); return fail('ASSET_UNAVAILABLE', 'Asset geometry failed download or integrity verification. Re-upload it or select another ready version.'); }
    }
    geometryBytes += Buffer.byteLength(text);
    if (geometryBytes > limits.totalGeometry) return fail('PAYLOAD_TOO_LARGE', 'Referenced geometry exceeds 50 MiB.');
    let asset: Asset;
    try { asset = parseCloudBundle(text).asset; }
    catch { return fail('INVALID_ASSET', 'Asset geometry is not a valid renderable Mergence bundle.'); }
    if (version && (asset.id !== version.asset?.asset_key || asset.source.kind !== version.asset?.source_kind)) return fail('INVALID_ASSET', 'Geometry does not match its immutable asset identity.');
    const value = { asset, version: version?.id }; loaded.set(key, value); return value;
  }
  if (name === 'astra.list_scene_assets') {
    const offset = args.offset ?? 0;
    const { data, error } = await ctx.client.from('asset_file_versions').select('id,asset:assets(name,asset_key,source_kind)').eq('owner_id', ctx.owner).eq('state', 'ready').order('id').range(offset, offset + 24);
    active(ctx);
    if (error) return fail('ASSET_UNAVAILABLE', 'Could not list assets. Check authentication and storage migrations.');
    const rows = (data ?? []) as unknown as { id: string; asset: { name: string; asset_key: string; source_kind: string } }[];
    const bundled = offset === 0 ? await bundledAssets() : [];
    return { version: 1, assets: [...bundled.map((asset, index) => summary(asset, { kind: 'example', id: examples[index].id })),
      ...rows.map(row => ({ asset: { kind: 'cloud', version_id: row.id }, asset_id: row.asset.asset_key, name: row.asset.name, source_kind: row.asset.source_kind }))], next_offset: rows.length === 25 ? offset + 25 : null };
  }
  if (name === 'astra.inspect_scene_asset') return { version: 1, asset: description((await load(args.asset!)).asset, args.asset!) };
  if (name === 'astra.read_scene') {
    const { data, error } = await ctx.client.rpc('get_workspace_scene', { p_id: args.scene_id, p_revision: args.revision_id ?? null, p_share_token: null });
    active(ctx);
    if (error) return fail('SCENE_UNAVAILABLE', 'Scene/revision not found or unavailable to the signed-in account.');
    let manifest; try { manifest = readManifest(data.scene.document); } catch { return fail('INVALID_SCENE', 'Stored scene does not match the supported manifest.'); }
    if (manifest.instances.some(item => !item.cloudVersionId)) return fail('MISSING_ASSETS', 'Scene contains local-only geometry. Save it with cloud geometry before authoring it through MCP.');
    // Allowlisted response: no raw project/source documents, RPC rows, or credentials.
    return { ...result(data.scene, ctx.origin), agent: typeof data.scene.document.authoring?.agent === 'string' ? data.scene.document.authoring.agent : null,
      scene: { name: data.scene.name, room: { width: manifest.room[0], depth: manifest.room[1], height: manifest.room[2] },
        instances: manifest.instances.map(item => ({ id: item.id, name: item.name, asset: { kind: 'cloud', version_id: item.cloudVersionId }, position: item.position, rotation: item.rotation, visible: item.visible })),
        animation: { duration: manifest.animation.duration, loop: manifest.animation.loop, tracks: manifest.animation.tracks.map(track => ({ instance_id: track.instanceId, ...(track.partId ? { part_id: track.partId } : {}), keys: track.keys.map(key => ({ time: key.time, position: key.position, rotation: key.rotation, ...(key.visible !== undefined ? { visible: key.visible } : {}) })) })) } } };
  }
  const creating = name === 'astra.create_scene';
  const sceneId = creating ? args.request_id : args.scene_id!;
  const base = creating ? 0 : args.base_revision!;
  const fingerprint = createHash('sha256').update(canonicalJSON(args)).digest('hex');
  const head = await ownedHead(ctx, sceneId);
  if (head?.last_write_id === args.request_id) {
    if (head.document?.authoring?.request_digest !== fingerprint) return fail('REQUEST_ID_REUSED', 'This request_id already names another payload. Use a new request_id for a new edit.');
    return result(head, ctx.origin);
  }
  if ((!creating && !head) || (head && head.revision !== base)) return fail(head ? 'CONFLICT' : 'SCENE_UNAVAILABLE', head ? 'Scene has changed. Read the current revision, reconcile the edit, and retry with a new request_id.' : 'Scene not found or unavailable to this account.', head ? { current_revision: head.revision } : {});
  const draft = { ...args.scene, animation: args.scene.animation ?? { duration: 3, loop: false, tracks: [] } };
  const workspace: Workspace = { room: [draft.room.width, draft.room.depth, draft.room.height], items: [], animation: animation(draft) };
  const identities = new Map<string, string>();
  for (const instance of draft.instances) {
    const { asset, version } = await load(instance.asset);
    const previous = identities.get(asset.id), refKey = canonicalJSON(instance.asset);
    if (previous && previous !== refKey) return fail('INVALID_SCENE', 'One asset ID cannot refer to multiple versions in a scene. Use one immutable version for each asset ID.');
    identities.set(asset.id, refKey);
    workspace.items.push({ id: instance.id, name: instance.name, asset, position: instance.position, rotation: instance.rotation, visible: instance.visible, cloudVersionId: version });
  }
  // Validate the complete scene before any uploads or scene writes.
  try { hydrateManifest(readManifest(makeManifest(workspace)), workspace.items.map(item => item.asset), new Map(workspace.items.filter(item => item.cloudVersionId).map(item => [item.cloudVersionId!, item.asset]))); }
  catch { return fail('INVALID_SCENE', 'Invalid instance IDs, animation targets, or keyframes. Targets must exist; key times must be unique and within the duration. Visibility keys must be booleans on whole-instance tracks. Inspect the asset for valid part IDs.'); }
  function documentFor(value: Workspace) {
    const manifest = makeManifest(value);
    // Source identity only; provider configuration and retained IR never enter this request document.
    manifest.assets = manifest.assets.map(asset => ({ ...asset, source: { kind: asset.source.kind, filename: asset.source.filename, digest: asset.source.digest,
      ...(asset.source.projectId ? { projectId: asset.source.projectId } : {}), ...(asset.source.version ? { version: asset.source.version } : {}),
      ...(asset.source.kind === 'generated' ? { generator: asset.source.generator } : {}) } as Asset['source'] }));
    const document = { ...manifest, authoring: { via: 'mcp', agent: args.agent, parent_revision: base || null, request_id: args.request_id, request_digest: fingerprint } };
    if (Buffer.byteLength(JSON.stringify(document)) > limits.manifest) return fail('PAYLOAD_TOO_LARGE', 'Scene metadata exceeds 1 MiB. Reduce the instance or animation count.');
    return document;
  }
  // Reserve UUID space so an oversized manifest creates no upload intents.
  documentFor({ ...workspace, items: workspace.items.map(item => ({ ...item, cloudVersionId: item.cloudVersionId ?? "00000000-0000-4000-8000-000000000000" })) });
  active(ctx);
  for (const entry of loaded.values()) {
    if (!entry.version) {
      try { entry.version = (await storage.upload({ id: entry.asset.id, asset: entry.asset, updatedAt: Date.now() }, () => {})).id; }
      catch { active(ctx); return fail('ASSET_UPLOAD_FAILED', 'Could not upload example geometry. Apply the generated-assets migration and check Storage; identical retries can resume pending uploads.'); }
      workspace.items.filter(item => item.asset.id === entry.asset.id).forEach(item => { item.cloudVersionId = entry.version; });
    }
  }
  const document = documentFor(workspace);
  active(ctx);
  const { data, error } = await ctx.client.rpc('save_workspace_scene', { p_id: sceneId, p_name: draft.name.trim(), p_document: document, p_expected_revision: base, p_write_id: args.request_id });
  if (error) {
    active(ctx);
    if (/changed on another device/i.test(error.message)) {
      const current = await ownedHead(ctx, sceneId);
      return fail('CONFLICT', 'Scene has changed. Read it, reconcile the edit, and retry with a new request_id.', current ? { current_revision: current.revision } : {});
    }
    return fail('SAVE_FAILED', 'Scene save was rejected. Check scene ownership, asset readiness, and revision/migration setup. Read the scene before retrying the identical request_id.');
  }
  const saved = Array.isArray(data) ? data[0] : data;
  if (saved.document?.authoring?.request_digest !== fingerprint) return fail('REQUEST_ID_REUSED', 'This request_id was used for another payload. Read the saved scene before retrying.');
  return result(saved, ctx.origin);
}

export async function callSceneTool(root: string, name: string, args: unknown) {
  validateSceneRequest(name, args);
  loadEnv(root);
  if (process.env.ASTRA_SCENE_TOOLS_ENABLED !== 'true') return fail('DISABLED', 'Set ASTRA_SCENE_TOOLS_ENABLED=true explicitly, configure the workbench/Supabase, and run astra auth login. Local file tools remain available.');
  const origin = workbenchOrigin(process.env.ASTRA_WORKBENCH_ORIGIN);
  const signal = AbortSignal.timeout(60000);
  let auth: Awaited<ReturnType<typeof sessionClient>>;
  try { auth = await sessionClient({ root, signal }); }
  catch { if (signal.aborted) return fail('TIMEOUT', 'Account verification timed out. Retry after checking the connection.'); return fail('AUTH_REQUIRED', 'A verified user session and public Supabase configuration are required. Run astra auth login; never supply credentials in tool arguments.'); }
  try { return validateSceneResult(name, await executeSceneTool(name, args, { client: auth.supabase, owner: auth.owner, origin, signal })); }
  catch (error) { if (error instanceof SceneToolError) throw error; if (signal.aborted) return fail('TIMEOUT', 'Operation timed out. Read the scene before retrying the identical request_id.'); return fail('OPERATION_FAILED', 'Scene operation failed. Check local configuration and asset availability; no provider call was made.'); }
}
