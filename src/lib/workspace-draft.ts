import {backupAndResetDraft,exportStoredDraft,loadActiveRoom,loadScene,saveActiveRoom,saveScene, type DraftBackup} from './scene-storage';
import type {MergenceScene} from './scene-manifest';
import {emptyWorkspace,hydrateManifest,makeManifest,missingAsset,readManifest,workspaceVersions,type Workspace} from './workspace';
import type {SavedScene} from './scene-repository';

function storedWorkspace(workspace:Workspace,owner:string|null,cloudScene:SavedScene|null):MergenceScene{
  const document=makeManifest(workspace);readManifest(document);
  return {schemaVersion:1,id:'active-scene',source:{},room:{width:workspace.room[0],depth:workspace.room[1],height:workspace.room[2]},
    instances:workspace.items.map(({id,name,asset,position,rotation,visible})=>({id,name,assetId:asset.id,position,rotation,visible})),workspaceDocument:document,activeCloudScene:cloudScene?.owner_id===owner?cloudScene:null};
}
export function draftScope(owner:string|null,roomId:string){return `${owner??'guest'}:${roomId}`;}
// Serialize device writes per account so a late write cannot replace a newer
// snapshot or active-room pointer. A failed write must not poison later retries.
const draftWrites = new Map<string, Promise<void>>();
export async function saveWorkspaceDraft(workspace:Workspace,owner:string|null,roomId:string,cloudScene:SavedScene|null=null,isCurrent:()=>boolean=()=>true){
  const identity=owner??'guest';
  const document=storedWorkspace(workspace,owner,cloudScene);
  const next=(draftWrites.get(identity)??Promise.resolve()).then(async()=>{
    await saveScene(document,workspace.items.filter(item=>!item.missing).map(item=>item.asset),draftScope(owner,roomId),workspaceVersions(workspace));
    await saveActiveRoom(identity,roomId,isCurrent);
  });
  const settled=next.catch(()=>{});draftWrites.set(identity,settled);
  void settled.then(()=>{if(draftWrites.get(identity)===settled)draftWrites.delete(identity);});
  return next;
}
export async function replaceDraftWithBackup(workspace:Workspace,owner:string|null,failedScope:string|undefined,roomId:string,cloudScene:SavedScene|null){
  return backupAndResetDraft(failedScope,storedWorkspace(workspace,owner,cloudScene),draftScope(owner,roomId),workspace.items.filter(item=>!item.missing).map(item=>item.asset),workspaceVersions(workspace));
}
export async function backupDraft(scope:string|undefined):Promise<DraftBackup>{
  return exportStoredDraft(scope);
}
export async function loadWorkspaceDraft(owner:string|null):Promise<{workspace:Workspace;scene:SavedScene|null;roomId:string}|null>{
  const loadWithTimeout=(scope?:string)=>Promise.race([
    loadScene(scope),
    new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('Saved local workspace did not finish loading. Close other Mergence tabs and retry.')),10000)),
  ]);
  const identity=owner??'guest';
  const roomId=await loadActiveRoom(identity).catch(()=>undefined) ?? 'local';
  const stored=await loadWithTimeout(draftScope(owner,roomId))??await loadWithTimeout(owner??'guest').catch(()=>undefined)??(!owner?await loadWithTimeout():undefined);
  if(!stored)return null;
  if(stored.scene.workspaceDocument){
    const workspace=hydrateManifest(readManifest(stored.scene.workspaceDocument),stored.assets,new Map(stored.versionedAssets.map(entry=>[entry.cloudVersionId,entry.asset])));
    workspace.items=workspace.items.map(item=>item.missing&&stored.invalidAssetIds.includes(item.asset.id)?{...item,asset:{...item.asset,warnings:[...item.asset.warnings,'Cached geometry is invalid or belongs to a different source revision. Reimport the matching original file to repair it.']}}:item);
    return {workspace,scene:stored.scene.activeCloudScene?.owner_id===owner?stored.scene.activeCloudScene:null,roomId};
  }
  // Compatibility with the scene format merged in #38/#39. Preserve every
  // occurrence of shared geometry and its instance identity, not a deduped list.
  const byId=new Map(stored.assets.map(asset=>[asset.id,asset]));const workspace=emptyWorkspace();
  workspace.room=[stored.scene.room.width,stored.scene.room.depth,stored.scene.room.height];
  workspace.items=stored.scene.instances.map(instance=>({id:instance.id,name:instance.name,position:instance.position,rotation:instance.rotation,visible:instance.visible,
    asset:byId.get(instance.assetId)??missingAsset({id:instance.assetId,name:instance.name,dimensions:[1,1,1],source:{kind:'form',filename:'Missing legacy source',digest:'unknown'}}),missing:!byId.has(instance.assetId)}));
  if(stored.scene.animation){
    workspace.animation.duration=Math.max(.5,stored.scene.animation.durationSeconds);
    workspace.animation.tracks=stored.scene.animation.tracks.filter(track=>track.keyframes.length).map(track=>{
      const item=workspace.items.find(i=>i.id===track.instanceId)!;let position=item.position,rotation=item.rotation;
      return{id:`${track.instanceId}:instance`,instanceId:track.instanceId,keys:track.keyframes.map(key=>{position=key.position??position;rotation=key.rotation??rotation;return{id:crypto.randomUUID(),time:key.timeSeconds,position,rotation,...(key.visible !== undefined ? {visible:key.visible} : {})};})};
    });
  }
  return {workspace,scene:null,roomId};
}
