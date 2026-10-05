import type { Asset } from './scene';
import { assertSourceMatches, type VersionedAsset } from './workspace';
import { validateScene, type MergenceScene } from './scene-manifest';
import { parseCloudBundle } from './cloud-storage';
import { scrubPortableData } from './portable-data.mjs';

const DATABASE='astra-scenes';
const VERSION=1;
const TIMEOUT=8000;
const sceneKey=(scope?:string)=>scope?`active:${scope}`:'active';
const assetKey=(scope:string|undefined,id:string,version?:string)=>`${scope?scope+':':''}${version?'version:'+version+':':''}${id}`;
const activeRoomKey=(scope:string)=>`active-room:${scope}`;
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

export class DraftStorageError extends Error {
  constructor(message:string,readonly scope?:string){super(message);this.name='DraftStorageError';}
}
export type StoredScene={scene:MergenceScene;assets:Asset[];versionedAssets:VersionedAsset[];missingAssetIds:string[];invalidAssetIds:string[]};
export type DraftBackup={format:'astra.draft-backup';version:1;originalKey:string;createdAt:string;record:unknown;assets:unknown[]};

function openDatabase():Promise<IDBDatabase>{
  return new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>fail('Opening local drafts timed out. Close other Mergence tabs or check browser storage permissions.'),TIMEOUT);
    const fail=(message:string)=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error(message));}};
    try{
      const request=indexedDB.open(DATABASE,VERSION);
      request.onupgradeneeded=()=>{
        try{const db=request.result;if(!db.objectStoreNames.contains('scenes'))db.createObjectStore('scenes',{keyPath:'id'});if(!db.objectStoreNames.contains('assets'))db.createObjectStore('assets',{keyPath:'id'});}
        catch{request.transaction?.abort();fail('Could not initialize local draft storage.');}
      };
      request.onsuccess=()=>{
        const db=request.result;
        if(settled){db.close();return;}
        settled=true;clearTimeout(timer);db.onversionchange=()=>db.close();resolve(db);
      };
      request.onerror=()=>fail('Could not open local drafts. Check browser storage permissions or close older Mergence tabs.');
      request.onblocked=()=>fail('Local drafts are blocked by another tab. Close other Mergence tabs and retry.');
    }catch{fail('Local draft storage is unavailable in this browser.');}
  });
}

/** Every callback has an error path, and synchronous enqueue failures abort writes. */
async function transact<T>(scope:string|undefined,mode:IDBTransactionMode,work:(tx:IDBTransaction,guard:(fn:()=>void)=>()=>void)=>()=>T):Promise<T>{
  let database:IDBDatabase;
  try{database=await openDatabase();}catch(e){throw new DraftStorageError((e as Error).message,scope);}
  return new Promise((resolve,reject)=>{
    let tx:IDBTransaction|undefined,settled=false,timer:ReturnType<typeof setTimeout>|undefined;
    const fail=(error:unknown)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      try{tx?.abort();}catch{/* Transaction may already be complete. */}
      database.close();reject(new DraftStorageError(error instanceof Error?error.message:'Local draft operation failed.',scope));
    };
    const guard=(fn:()=>void)=>()=>{if(settled)return;try{fn();}catch(e){fail(e);}};
    try{
      tx=database.transaction(['scenes','assets'],mode);
      timer=setTimeout(()=>fail(new Error('Local draft operation timed out. Retry after closing other Mergence tabs.')),TIMEOUT);
      tx.onerror=()=>fail(new Error('Local draft storage failed. Check available browser storage and retry.'));
      tx.onabort=()=>fail(new Error('Local draft operation was interrupted. The existing record was not replaced.'));
      const result=work(tx,guard);
      tx.oncomplete=guard(()=>{const value=result();settled=true;clearTimeout(timer);database.close();resolve(value);});
    }catch(e){fail(e);}
  });
}

export async function saveScene(scene:MergenceScene,assets:Asset[],scope?:string,versions:VersionedAsset[]=[]):Promise<void>{
  const errors=validateScene(scene);if(errors.length)throw new DraftStorageError(`Scene was not saved: ${errors.slice(0,8).join(' ')}`,scope);
  await transact(scope,'readwrite',tx=>{
    tx.objectStore('scenes').put({...scene,id:sceneKey(scope)});
    for(const asset of assets)tx.objectStore('assets').put(scope?{id:assetKey(scope,asset.id),scope,asset}:asset);
    for(const entry of versions)tx.objectStore('assets').put({id:assetKey(scope,entry.asset.id,entry.cloudVersionId),scope,...entry});
    return()=>undefined;
  });
}
export async function loadActiveRoom(scope:string):Promise<string|undefined>{
  return transact(scope,'readonly',tx=>{const request=tx.objectStore('scenes').get(activeRoomKey(scope));return()=>{const value=request.result;return record(value)&&typeof value.roomId==='string'&&value.roomId.length<=128?value.roomId:undefined;};});
}
export async function saveActiveRoom(scope:string,roomId:string,isCurrent:()=>boolean=()=>true):Promise<void>{
  if(!scope||!roomId||roomId.length>128)throw new Error('Invalid active room identity.');
  await transact(scope,'readwrite',tx=>{if(isCurrent())tx.objectStore('scenes').put({id:activeRoomKey(scope),kind:'astra.active-room',version:1,roomId,updatedAt:new Date().toISOString()});return()=>undefined;});
}

export async function loadScene(scope?:string):Promise<StoredScene|undefined>{
  return transact(scope,'readonly',(tx,guard)=>{
    let result:StoredScene|undefined;
    const sceneRequest=tx.objectStore('scenes').get(sceneKey(scope));
    sceneRequest.onsuccess=guard(()=>{
      const raw:unknown=sceneRequest.result;
      if(raw===undefined)return;
      const errors=validateScene(raw);if(errors.length)throw new Error(`Saved draft is invalid: ${errors.slice(0,8).join(' ')}`);
      const scene=raw as MergenceScene;
      const instances=scene.workspaceDocument?.instances??scene.instances;
      const bindings=[...new Map(instances.map(instance=>{const version='cloudVersionId' in instance&&typeof instance.cloudVersionId==='string'?instance.cloudVersionId:undefined;return [assetKey(scope,instance.assetId,version),{id:instance.assetId,version}];})).values()];
      result={scene,assets:[],versionedAssets:[],missingAssetIds:[],invalidAssetIds:[]};
      // Fetch only referenced keys in this account's namespace. Malformed data
      // elsewhere in the cache must not break this user's scene restoration.
      for(const {id,version} of bindings){
        const request=tx.objectStore('assets').get(assetKey(scope,id,version));
        request.onsuccess=guard(()=>{
          const row:unknown=request.result;
          if(row===undefined){result!.missingAssetIds.push(id);return;}
          try{
            const candidate=scope||version?(record(row)&&row.scope===scope&&row.cloudVersionId===version?row.asset:undefined):row;
            const asset=parseCloudBundle(JSON.stringify({schemaVersion:1,asset:candidate})).asset;
            const ref=scene.workspaceDocument?.assets.find(ref=>ref.id===id);
            if(asset.id!==id)throw new Error('Cached source identity mismatch');
            if(ref)assertSourceMatches(ref,asset);
            if(version)result!.versionedAssets.push({cloudVersionId:version,asset});else result!.assets.push(asset);
          }catch{
            // Preserve the scene/instance/reference. The workspace hydrator will
            // create a labeled placeholder that can be repaired by reimporting.
            result!.missingAssetIds.push(id);result!.invalidAssetIds.push(id);
          }
        });
      }
    });
    return()=>result;
  });
}

function backupAssets(tx:IDBTransaction,scope?:string){
  return scope?tx.objectStore('assets').getAll(IDBKeyRange.bound(`${scope}:`,`${scope}:\uffff`)):tx.objectStore('assets').getAll();
}
function relevantAssets(rows:unknown[],scope?:string):unknown[]{
  if(scope)return rows; // Scoped key range, not untrusted row.scope, sets the boundary.
  return rows.filter(row=>record(row)&&!row.scope&&typeof row.id==='string'&&!/^(guest|[a-f0-9-]{36}):/i.test(row.id));
}
export async function exportStoredDraft(scope?:string):Promise<DraftBackup>{
  return transact(scope,'readonly',tx=>{
    const saved=tx.objectStore('scenes').get(sceneKey(scope));const assets=backupAssets(tx,scope);
    return()=>scrubPortableData({format:'astra.draft-backup',version:1,originalKey:sceneKey(scope),createdAt:new Date().toISOString(),record:saved.result??null,assets:relevantAssets(assets.result,scope)}) as DraftBackup;
  });
}

/** Backup and replace are one transaction; quota/clone failures leave the draft intact. */
export async function backupAndResetDraft(scope:string|undefined,replacement:MergenceScene,replacementScope:string,replacementAssets:Asset[]=[],versions:VersionedAsset[]=[]):Promise<string>{
  const errors=validateScene(replacement);if(errors.length)throw new Error('The replacement draft is invalid.');
  return transact(scope,'readwrite',(tx,guard)=>{
    const id=`recovery:${replacementScope}:${crypto.randomUUID()}`;
    const saved=tx.objectStore('scenes').get(sceneKey(scope));const assets=backupAssets(tx,scope);let reads=0;
    const finish=guard(()=>{
      if(++reads!==2)return;
      tx.objectStore('scenes').put({id,format:'astra.draft-backup',version:1,originalKey:sceneKey(scope),createdAt:new Date().toISOString(),record:saved.result??null,assets:relevantAssets(assets.result,scope)});
      if(sceneKey(scope)!==sceneKey(replacementScope))tx.objectStore('scenes').delete(sceneKey(scope));
      tx.objectStore('scenes').put({...replacement,id:sceneKey(replacementScope)});
      for(const asset of replacementAssets)tx.objectStore('assets').put({id:assetKey(replacementScope,asset.id),scope:replacementScope,asset});
      for(const entry of versions)tx.objectStore('assets').put({id:assetKey(replacementScope,entry.asset.id,entry.cloudVersionId),scope:replacementScope,...entry});
      // Asset records are deliberately retained for other instances/scenes.
    });
    saved.onsuccess=finish;assets.onsuccess=finish;
    return()=>id;
  });
}

export async function readDraftBackup(id:string,scope:string):Promise<DraftBackup>{
  if(!id.startsWith(`recovery:${scope}:`))throw new Error('Recovery backup belongs to a different local account.');
  return transact(scope,'readonly',tx=>{
    const request=tx.objectStore('scenes').get(id);
    return()=>{const value=request.result;if(!record(value)||value.format!=='astra.draft-backup')throw new Error('Recovery backup was not found.');return value as unknown as DraftBackup;};
  });
}
