import type { SupabaseClient } from '@supabase/supabase-js';
import { digestBytes, finalizeAsset, type Asset, type AssetNode } from './scene';
import type { LibraryEntry } from './library';
import { scrubPortableData } from './portable-data.mjs';

export const CLOUD_BUCKET = 'astra-assets';
export const CLOUD_FILE_LIMIT = 25 * 1024 * 1024;
export type CloudFile = { name: 'asset.json' | 'preview.gif' | 'source.step'; mime: string; size: number; sha256: string };
export type CloudVersion = {
  id: string; owner_id: string; asset_id: string; state: 'pending' | 'ready' | 'deleting';
  fingerprint: string; files: CloudFile[]; created_at: string;
  asset?: { name: string; asset_key: string; source_kind: string };
};

// Keep the existing import name while sharing the policy with local MCP/CLI tools.
export const scrubCloudData = scrubPortableData;

export function parseCloudBundle(text: string): LibraryEntry {
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error('Cloud geometry is not valid JSON. Re-upload the original asset.'); }
  bundle = scrubPortableData(bundle) as typeof bundle;
  const asset = bundle?.asset as Asset;
  if (bundle?.schemaVersion !== 1 || asset?.schemaVersion !== 1 || asset.units !== 'm' || asset.upAxis !== 'Y'
      || typeof asset.id !== 'string' || typeof asset.name !== 'string' || !['form', 'step', 'generated'].includes(asset.source?.kind)
      || typeof asset.source.filename !== 'string' || typeof asset.source.digest !== 'string'
      || (asset.source.kind === 'generated' && asset.source.generator !== 'form-industries')
      || !Array.isArray(asset.parts) || !Array.isArray(asset.warnings) || !asset.warnings.every(w => typeof w === 'string')
      || !Array.isArray(asset.originOffset) || asset.originOffset.length !== 3 || !asset.originOffset.every(Number.isFinite)) {
    throw new Error('Unsupported or incomplete cloud asset bundle.');
  }
  for (const part of asset.parts) {
    if (typeof part.id !== 'string' || typeof part.name !== 'string' || !Array.isArray(part.vertices) || !Array.isArray(part.indices)
        || !part.metadata || typeof part.metadata !== 'object' || !Object.values(part.metadata).every(v => typeof v === 'string')
        || (part.color && (part.color.length !== 3 || !part.color.every(n => Number.isFinite(n) && n >= 0 && n <= 1)))) {
      throw new Error('Invalid part geometry or metadata in cloud asset.');
    }
  }
  const ids = new Set(asset.parts.map(p => p.id));
  let count = 0;
  const validateNode = (node: AssetNode, depth: number) => {
    if (++count > 10000 || depth > 64 || !node || typeof node.id !== 'string' || typeof node.name !== 'string'
        || !Array.isArray(node.children) || !Array.isArray(node.partIds) || !node.partIds.every(id => ids.has(id))) throw new Error('Invalid cloud asset hierarchy.');
    node.children.forEach(child => validateNode(child, depth + 1));
  };
  validateNode(asset.hierarchy, 0);
  // Validate triangle topology and finite bounds without changing the stored coordinate frame.
  const validated = finalizeAsset({ ...asset, parts: asset.parts.map(part => ({ ...part })) });
  return { id: asset.id, asset: { ...asset, dimensions: validated.dimensions }, updatedAt: Date.now(),
    ...(bundle.previewMetadata && typeof bundle.previewMetadata === 'object' ? { previewMetadata: bundle.previewMetadata } : {}) };
}

function checkBlob(blob: Blob, name: string) {
  if (blob.size === 0 || blob.size > CLOUD_FILE_LIMIT) throw new Error(`${name} must be between 1 byte and 25 MiB.`);
}
function failure(error: { message: string } | null, fallback: string) {
  if (error) throw new Error(`${fallback}: ${error.message}`);
}

/** Uses a session-bound client: changing accounts cannot redirect an in-flight transfer. */
export class CloudStorage {
  constructor(readonly client: SupabaseClient, readonly ownerId: string) {}
  path(version: CloudVersion, file: CloudFile) {
    if (version.owner_id !== this.ownerId) throw new Error('This cloud copy belongs to another account.');
    return `${this.ownerId}/${version.id}/${file.name}`;
  }
  async list(): Promise<CloudVersion[]> {
    const rows: CloudVersion[] = [];
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await this.client.from('asset_file_versions')
        .select('*,asset:assets(name,asset_key,source_kind)').eq('owner_id', this.ownerId)
        .order('created_at', { ascending: false }).order('id').range(offset, offset + 99);
      failure(error, 'Could not list cloud assets');
      rows.push(...(data as CloudVersion[]));
      if (!data || data.length < 100) return rows;
    }
  }
  private async rpc(name: string, args: Record<string, unknown>): Promise<CloudVersion> {
    const { data, error } = await this.client.rpc(name, args);
    failure(error, 'Cloud storage operation failed');
    return (Array.isArray(data) ? data[0] : data) as CloudVersion;
  }
  async upload(entry: LibraryEntry, progress: (text: string) => void, source?: File): Promise<CloudVersion> {
    const asset = scrubCloudData(entry.asset) as Asset;
    if (asset.id.length > 256 || !asset.name.trim() || asset.name.length > 200) throw new Error('Asset ID/name exceeds cloud metadata limits.');
    const bundle = new Blob([JSON.stringify({ schemaVersion: 1, asset, previewMetadata: scrubCloudData(entry.previewMetadata) })], { type: 'application/json' });
    const binaries: { name: CloudFile['name']; blob: Blob }[] = [{ name: 'asset.json', blob: bundle }];
    checkBlob(bundle, 'Geometry bundle');
    if (entry.preview) {
      checkBlob(entry.preview, 'GIF preview');
      if (!/^GIF8[79]a/.test(await entry.preview.slice(0, 6).text())) throw new Error('Preview is not a GIF file.');
      binaries.push({ name: 'preview.gif', blob: new Blob([entry.preview], { type: 'image/gif' }) });
    }
    if (source) {
      checkBlob(source, 'STEP source');
      if (asset.source.kind !== 'step' || !/\.(step|stp)$/i.test(source.name)) throw new Error('An original source attachment must be the standalone STEP file used to import this asset.');
      if (await digestBytes(await source.arrayBuffer()) !== asset.source.digest) throw new Error('Selected STEP source does not match this asset’s source SHA-256.');
      binaries.push({ name: 'source.step', blob: new Blob([source], { type: 'application/octet-stream' }) });
    }
    if (binaries.reduce((total, item) => total + item.blob.size, 0) > 50 * 1024 * 1024) throw new Error('Combined upload exceeds 50 MiB. Remove the source attachment or GIF.');
    // Validate before any cloud mutations so malformed local records create no upload intent.
    parseCloudBundle(await bundle.text());
    const files: CloudFile[] = await Promise.all(binaries.map(async ({ name, blob }) => ({ name, mime: blob.type, size: blob.size, sha256: await digestBytes(await blob.arrayBuffer()) })));
    progress('Preparing cloud copy…');
    const version = await this.rpc('prepare_asset_upload', { p_asset_key: asset.id, p_name: asset.name, p_source_kind: asset.source.kind,
      p_metadata: { dimensions: asset.dimensions, source: asset.source }, p_files: files });
    if (version.state === 'ready') { progress('Identical cloud copy already exists.'); return version; }
    for (const item of binaries) {
      const file = files.find(f => f.name === item.name)!;
      progress(`Uploading ${item.name}…`);
      const { error } = await this.client.storage.from(CLOUD_BUCKET).upload(this.path(version, file), item.blob, { contentType: file.mime, upsert: false, cacheControl: '0' });
      if (error) {
        // A prior attempt may already have completed this immutable object. Verify
        // it rather than overwriting; all other failures remain tracked as pending.
        if (!['409', '400'].includes(String((error as { statusCode?: string }).statusCode)) || !/exist|duplicate/i.test(error.message)) failure(error, 'Upload interrupted; retry or remove the pending cloud copy');
        await this.downloadFile(version, file.name);
      }
    }
    progress('Finalizing cloud copy…');
    return this.rpc('finish_asset_upload', { p_id: version.id });
  }
  async downloadFile(version: CloudVersion, name: CloudFile['name']): Promise<Blob> {
    const file = version.files.find(item => item.name === name);
    if (!file) throw new Error(`${name} is not attached to this cloud copy.`);
    const { data, error } = await this.client.storage.from(CLOUD_BUCKET).download(this.path(version, file));
    failure(error, 'File unavailable or access expired; refresh the cloud list and retry');
    if (!data || data.size !== file.size || await digestBytes(await data.arrayBuffer()) !== file.sha256) throw new Error('Cloud file integrity check failed. Remove the damaged cloud copy and re-upload the original.');
    return new Blob([data], { type: file.mime });
  }
  async load(version: CloudVersion): Promise<LibraryEntry> {
    if (version.state !== 'ready') throw new Error('This upload is not ready. Retry it or remove its pending cloud copy.');
    const entry = parseCloudBundle(await (await this.downloadFile(version, 'asset.json')).text());
    if (version.asset?.asset_key && entry.asset.id !== version.asset.asset_key) throw new Error('Cloud asset identity does not match its metadata.');
    if (version.files.some(file => file.name === 'preview.gif')) entry.preview = await this.downloadFile(version, 'preview.gif');
    return entry;
  }
  async remove(version: CloudVersion): Promise<void> {
    const deleting = await this.rpc('begin_asset_file_delete', { p_id: version.id });
    const { error } = await this.client.storage.from(CLOUD_BUCKET).remove(deleting.files.map(file => this.path(deleting, file)));
    failure(error, 'Deletion interrupted; use Retry removal to finish cleanup');
    const result = await this.client.rpc('finish_asset_file_delete', { p_id: deleting.id });
    failure(result.error, 'Deletion interrupted; use Retry removal to finish cleanup');
  }
}
