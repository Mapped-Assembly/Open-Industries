import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CloudStorage, parseCloudBundle, type CloudVersion } from './cloud-storage';
import { digestBytes, type Asset } from './scene';
import { hydrateManifest, readManifest } from './workspace';
import { sceneURLs, type SceneLink } from './scene-links';
import type { SavedScene } from './scene-repository';

/** Every pinned instance resolves through its exact immutable file-version ID. */
export async function loadSceneSnapshot(client: SupabaseClient, data: { scene: SavedScene; versions: CloudVersion[] }, options: {
  localAssets?: Asset[]; sharedGeometry?: (version: CloudVersion) => Promise<Blob>; baseURL?: string;
} = {}) {
  const scene = data.scene;
  const manifest = readManifest(scene.document);
  const available = new Map<string, Asset>();
  const storage = new CloudStorage(client, scene.owner_id);
  for (const versionId of new Set(manifest.instances.map(item => item.cloudVersionId).filter((id): id is string => Boolean(id)))) {
    const items = manifest.instances.filter(item => item.cloudVersionId === versionId);
    const version = data.versions.find(value => value.id === versionId && value.state === 'ready');
    if (!version || items.some(item => item.assetId !== version.asset?.asset_key)) continue;
    try {
      const blob = options.sharedGeometry ? await options.sharedGeometry(version) : await storage.downloadFile(version, 'asset.json');
      const file = version.files.find(file => file.name === 'asset.json');
      if (!file || blob.size !== file.size || await digestBytes(await blob.arrayBuffer()) !== file.sha256) throw new Error('Geometry integrity check failed.');
      const asset = parseCloudBundle(await blob.text()).asset;
      if (asset.id !== version.asset?.asset_key) throw new Error('Geometry source mismatch.');
      available.set(versionId, asset);
    } catch { /* Missing/inaccessible pinned bytes stay missing; never use a local ID hit. */ }
  }
  const workspace = hydrateManifest(manifest, options.localAssets ?? [], available);
  const missing = [...new Set(workspace.items.filter(item => item.missing).map(item => item.name))];
  return { scene: { ...scene, ...sceneURLs(scene.id, scene.revision, options.baseURL) }, workspace,
    notice: missing.length ? `Unavailable assets: ${missing.join(', ')}. Retrieve the exact cloud version or provide matching geometry for unversioned assets.` : '' };
}

export async function openSceneLink(client: SupabaseClient, link: SceneLink, sharedGeometry: (version: CloudVersion) => Promise<Blob>) {
  const { data, error } = await client.rpc('get_workspace_scene', { p_id: link.id, p_revision: link.revision ?? null, p_share_token: link.token ?? null });
  if (error) throw new Error(error.message);
  return loadSceneSnapshot(client, data, { ...(link.token ? { sharedGeometry } : {}), baseURL: window.location.origin });
}

export function publicSceneClient() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('Cloud scene links are not configured on this workbench.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', signal: AbortSignal.timeout(30000) }) } });
}
export async function downloadSharedGeometry(link: SceneLink, version: CloudVersion) {
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/scene-asset`, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(30000),
    headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sceneId: link.id, revision: link.revision, token: link.token, versionId: version.id }) });
  if (!response.ok) throw new Error('Shared geometry unavailable.');
  return response.blob();
}
