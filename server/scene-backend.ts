import type { SupabaseClient } from '@supabase/supabase-js';
import { CloudStorage, type CloudVersion } from '../src/lib/cloud-storage.ts';
import type { Asset } from '../src/lib/scene.ts';
import type { SceneManifest } from '../src/lib/workspace.ts';
import { SceneToolError } from './mcp-scene-contract.mjs';

export type SceneDocument = SceneManifest & { authoring: { via: string; agent: string; parent_revision: number | null; request_id: string; request_digest: string } };
export type SavedScene = { id: string; name: string; revision: number; last_write_id: string; document: SceneDocument };
export type AssetSummary = { id: string; asset: { name: string; asset_key: string; source_kind: string } };
/** Storage boundary shared by authenticated cloud and single-user local scene tools. */
export interface SceneBackend {
  readonly kind: 'cloud' | 'local';
  head(id: string): Promise<SavedScene | null>;
  read(id: string, revision?: number): Promise<SavedScene>;
  save(id: string, name: string, document: SceneDocument, base: number, writeId: string): Promise<SavedScene>;
  list(offset: number): Promise<AssetSummary[]>;
  asset(id: string): Promise<CloudVersion | null>;
  geometry(version: CloudVersion): Promise<string>;
  persistAsset(asset: Asset): Promise<string>;
  urls?(id: string, revision: number): { head_url: string; revision_url: string };
}
/** Retains the existing owner-scoped Supabase RPC and immutable asset lifecycle. */
export class SupabaseSceneBackend implements SceneBackend {
  readonly kind = 'cloud';
  private storage: CloudStorage;
  constructor(private client: SupabaseClient, private owner: string) { this.storage = new CloudStorage(client, owner); }
  async head(id: string): Promise<SavedScene | null> {
    const { data, error } = await this.client.from('scenes').select('id,name,revision,last_write_id,document').eq('id', id).eq('owner_id', this.owner).maybeSingle();
    if (error) throw new SceneToolError('SCENE_UNAVAILABLE', 'Could not read this account’s scene.');
    return data;
  }
  async read(id: string, revision?: number): Promise<SavedScene> {
    const { data, error } = await this.client.rpc('get_workspace_scene', { p_id: id, p_revision: revision ?? null, p_share_token: null });
    if (error || !data?.scene) throw new SceneToolError('SCENE_UNAVAILABLE', 'Scene/revision not found or unavailable to this account.');
    return data.scene;
  }
  async save(id: string, name: string, document: SceneDocument, base: number, writeId: string): Promise<SavedScene> {
    const { data, error } = await this.client.rpc('save_workspace_scene', { p_id: id, p_name: name, p_document: document, p_expected_revision: base, p_write_id: writeId });
    if (error) {
      if (/changed on another device/i.test(error.message)) {
        const current = await this.head(id);
        throw new SceneToolError('CONFLICT', 'Scene has changed. Read it before retrying.', current ? { current_revision: current.revision } : {});
      }
      throw new SceneToolError('SAVE_FAILED', 'Scene save was rejected. Check ownership, asset readiness, and database setup.');
    }
    return Array.isArray(data) ? data[0] : data;
  }
  async list(offset: number): Promise<AssetSummary[]> {
    const { data, error } = await this.client.from('asset_file_versions').select('id,asset:assets(name,asset_key,source_kind)').eq('owner_id', this.owner).eq('state', 'ready').order('id').range(offset, offset + 24);
    if (error) throw new SceneToolError('ASSET_UNAVAILABLE', 'Could not list account assets.');
    return (data ?? []) as unknown as AssetSummary[];
  }
  async asset(id: string): Promise<CloudVersion | null> {
    const { data, error } = await this.client.from('asset_file_versions').select('*,asset:assets(name,asset_key,source_kind)').eq('id', id).eq('owner_id', this.owner).eq('state', 'ready').maybeSingle();
    return error ? null : data;
  }
  async geometry(version: CloudVersion): Promise<string> { return (await this.storage.downloadFile(version, 'asset.json')).text(); }
  async persistAsset(asset: Asset): Promise<string> { return (await this.storage.upload({ id: asset.id, asset, updatedAt: Date.now() }, () => {})).id; }
}
