import type { SupabaseClient } from '@supabase/supabase-js';
import { CloudStorage, scrubCloudData } from './cloud-storage';
import { makeManifest, readManifest, type Workspace } from './workspace';
import type { Asset } from './scene';
import { sceneURLs } from './scene-links';
import { loadSceneSnapshot } from './scene-link-loader';
import { compareSceneRevisions, sceneRPCError, type SceneHistoryPage } from './scene-history';

export type SavedScene = { id: string; owner_id: string; name: string; revision: number; updated_at: string; document?: unknown; head_url?: string; revision_url?: string };
export type AssetRow = { id: string; asset_key: string; name: string; source_kind: string; metadata: { dimensions: Asset['dimensions']; source: Asset['source'] } };
export class SceneRepository {
  constructor(readonly client: SupabaseClient, readonly owner: string, readonly storageEnabled: boolean, readonly baseURL = typeof window === 'undefined' ? undefined : window.location.origin) {}
  async list(): Promise<SavedScene[]> {
    const {data,error}=await this.client.from('scenes').select('id,owner_id,name,revision,updated_at').eq('owner_id',this.owner).order('updated_at',{ascending:false}).limit(200);
    if(error)throw sceneRPCError(error);return data;
  }
  async saveMetadata(assets: Asset[]) {
    if (assets.some(asset => asset.source.kind === 'generated' && asset.source.generator !== 'form-industries')) throw new Error('Unsupported generated asset provenance.');
    const rows=[...new Map(assets.map(asset=>[asset.id,{owner_id:this.owner,asset_key:asset.id,name:asset.name,source_kind:asset.source.kind,metadata:scrubCloudData({dimensions:asset.dimensions,source:asset.source})}])).values()];
    if(!rows.length)return;
    const {error}=await this.client.from('assets').upsert(rows,{onConflict:'owner_id,asset_key'});if(error)throw sceneRPCError(error);
  }
  async catalog(): Promise<AssetRow[]> {
    const {data,error}=await this.client.from('assets').select('id,asset_key,name,source_kind,metadata').eq('owner_id',this.owner).order('updated_at',{ascending:false}).limit(200);
    if(error)throw sceneRPCError(error);return data as AssetRow[];
  }
  async deleteMetadata(assetKey: string): Promise<void> {
    const { error } = await this.client.from('assets').delete().eq('owner_id', this.owner).eq('asset_key', assetKey);
    if (error) throw new Error(error.message);
  }
  async save(workspace: Workspace, name: string, id: string, revision: number, uploadGeometry: boolean, progress:(text:string)=>void): Promise<{scene:SavedScene;workspace:Workspace}> {
    const copy:Workspace={...workspace,items:workspace.items.map(item=>({...item})),animation:structuredClone(workspace.animation)};
    await this.saveMetadata(copy.items.map(item=>item.asset));
    const storage=new CloudStorage(this.client,this.owner);
    const versions=(uploadGeometry||copy.items.some(i=>i.cloudVersionId))?await storage.list():[];
    const mapped=new Map<string,string>();
    for(const item of copy.items){
      const existing=versions.find(v=>v.id===item.cloudVersionId&&v.state==='ready'&&v.asset?.asset_key===item.asset.id);
      if(existing)continue;
      item.cloudVersionId=undefined;
      if(uploadGeometry){
        if(!this.storageEnabled)throw new Error('Enable cloud storage before uploading geometry.');
        if(item.missing)throw new Error(`Reimport missing geometry for ${item.name} before uploading.`);
        let version=mapped.get(item.asset.id);
        if(!version){version=(await storage.upload({id:item.asset.id,asset:item.asset,updatedAt:Date.now()},progress)).id;mapped.set(item.asset.id,version);}
        item.cloudVersionId=version;
      }
    }
    const document={...makeManifest(copy),authoring:{via:'workbench'}};readManifest(document);
    progress('Saving scene and asset references…');
    const {data,error}=await this.client.rpc('save_workspace_scene',{p_id:id,p_name:name.trim(),p_document:document,p_expected_revision:revision,p_write_id:crypto.randomUUID()});
    if(error)throw sceneRPCError(error);
    const scene = (Array.isArray(data)?data[0]:data) as SavedScene;
    return{scene:{...scene,...sceneURLs(scene.id,scene.revision,this.baseURL)},workspace:copy};
  }
  async open(id:string,localAssets:Asset[],progress:(text:string)=>void,revision?:number):Promise<{scene:SavedScene;workspace:Workspace}> {
    const {data,error}=await this.client.rpc('get_workspace_scene',{p_id:id,p_revision:revision??null,p_share_token:null});
    if(error)throw sceneRPCError(error);
    progress('Loading exact saved file versions…');
    const result=await loadSceneSnapshot(this.client,data,{localAssets,baseURL:this.baseURL});
    progress(result.notice||'Scene loaded.');
    return result;
  }
  async history(id:string,before:number|null=null):Promise<SceneHistoryPage> {
    const {data,error}=await this.client.rpc('list_scene_revisions',{p_id:id,p_before_revision:before,p_limit:25});
    if(error)throw sceneRPCError(error);return data;
  }
  async compare(id:string,from:number,to:number) {
    const snapshots=await Promise.all([from,to].map(async revision=>{
      const {data,error}=await this.client.rpc('get_workspace_scene',{p_id:id,p_revision:revision,p_share_token:null});
      if(error)throw sceneRPCError(error);return data.scene as SavedScene;
    }));
    return compareSceneRevisions(snapshots[0],snapshots[1]);
  }
  async restore(id:string,revision:number,baseRevision:number,writeId=crypto.randomUUID()):Promise<SavedScene> {
    const {data,error}=await this.client.rpc('restore_workspace_scene',{p_id:id,p_revision:revision,p_expected_revision:baseRevision,p_write_id:writeId});
    if(error)throw sceneRPCError(error);const scene=(Array.isArray(data)?data[0]:data) as SavedScene;
    return {...scene,...sceneURLs(scene.id,scene.revision,this.baseURL)};
  }
  async share(scene: SavedScene): Promise<{url:string;expires_at:string}> {
    const {data,error}=await this.client.rpc('create_scene_share',{p_id:scene.id,p_revision:scene.revision});
    if(error)throw sceneRPCError(error);
    return {...data,url:this.baseURL?new URL(data.url,this.baseURL).href:data.url};
  }
  async revokeShares(id:string) {
    const {error}=await this.client.rpc('revoke_scene_shares',{p_id:id});
    if(error)throw sceneRPCError(error);
  }
  async remove(scene:SavedScene){const{error}=await this.client.rpc('delete_workspace_scene',{p_id:scene.id,p_expected_revision:scene.revision});if(error)throw sceneRPCError(error);}
  async duplicate(scene:SavedScene,name:string):Promise<SavedScene>{
    const {data,error}=await this.client.rpc('duplicate_workspace_scene',{p_source_id:scene.id,p_new_id:crypto.randomUUID(),p_name:name.trim()});
    if(error)throw sceneRPCError(error);const result=(Array.isArray(data)?data[0]:data) as SavedScene;return {...result,...sceneURLs(result.id,result.revision,this.baseURL)};
  }
}
