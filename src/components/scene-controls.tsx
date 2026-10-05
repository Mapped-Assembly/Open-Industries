import { useEffect,useImperativeHandle,useRef,useState,type Ref } from 'react';
import { cloudStorageEnabled,connectUserClient } from '../lib/cloud-session';
import { SceneRepository,type SavedScene,type AssetRow } from '../lib/scene-repository';
import { sceneURLs } from '../lib/scene-links';
import { SceneHistory } from './scene-history';
import { SceneConflictError } from '../lib/scene-history';
import { listLibrary } from '../lib/library';
import type { RoomDestination,RoomTransitionHandle } from '../lib/room-transition';
import { canonicalJSON,emptyWorkspace,makeManifest,sceneContent,type Workspace } from '../lib/workspace';

export function SceneControls({workspace,owner,roomId,current,replace,busy,setBusy,onExport,flushDraft,getScope,roomOperation,ref}: {
  workspace:Workspace;owner:string|null;roomId:string;current:SavedScene|null;
  replace:(destination:RoomDestination)=>void;busy:boolean;setBusy:(busy:boolean)=>void;onExport:()=>void;
  flushDraft:()=>Promise<void>;getScope:()=>string;roomOperation:number;ref?:Ref<RoomTransitionHandle>;
}) {
  const [shareURL,setShareURL]=useState('');
  const [name,setName]=useState(current?.name??'Untitled room');
  const [scenes,setScenes]=useState<SavedScene[]>([]);const[catalog,setCatalog]=useState<AssetRow[]>([]);
  const[message,setMessage]=useState('');const[error,setError]=useState('');
  const [retry,setRetry]=useState<{label:string;run:()=>void}|null>(null);
  const [pendingSwitch,setPendingSwitch]=useState<{label:string;action:()=>RoomDestination|Promise<RoomDestination>}|null>(null);
  const[upload,setUpload]=useState(cloudStorageEnabled);
  const operation=useRef(0);const active=useRef(true);const lock=useRef(false);
  const latest=useRef({workspace,current,owner,roomId,name,flushDraft,getScope});latest.current={workspace,current,owner,roomId,name,flushDraft,getScope};
  const cancelled=useRef(0);const saveIdentity=useRef<{scope:string;id:string}|null>(null);
  const operationScope=useRef('');const namedRoom=useRef('');const dialog=useRef<HTMLDialogElement>(null);const returnFocus=useRef<HTMLElement|null>(null);
  useEffect(()=>{if(namedRoom.current!==roomId){setName(current?.name??'Untitled room');namedRoom.current=roomId;}setShareURL('');},[roomId,current?.name]);
  useEffect(()=>{active.current=true;return()=>{active.current=false;operation.current++;};},[]);
  useEffect(()=>{setError('');setMessage('');},[owner]);
  useEffect(()=>{
    if(operationScope.current!==getScope()){operation.current++;lock.current=false;}
    setPendingSwitch(null);setRetry(null);setShareURL('');setCatalog([]);
    setScenes([]);if(!owner)return;
    const scope=getScope(),token=operation.current;
    void connectUserClient(owner).then(async client=>{
      const rows=await new SceneRepository(client,owner,cloudStorageEnabled).list();
      if(active.current&&scope===latest.current.getScope()&&token===operation.current)setScenes(rows);
    }).catch(e=>{if(active.current&&scope===latest.current.getScope()&&token===operation.current)setError(e.message);});
  },[owner,roomId]);
  const valid=(token:number)=>active.current&&token===operation.current&&operationScope.current===latest.current.getScope();
  async function run(work:(repo:SceneRepository,token:number)=>Promise<void>){
    const account=latest.current.owner;if(!account||lock.current)return;
    const token=++operation.current;operationScope.current=latest.current.getScope();lock.current=true;setBusy(true);setError('');setRetry(null);
    try{const client=await connectUserClient(account);if(valid(token))await work(new SceneRepository(client,account,cloudStorageEnabled),token);}
    catch(e){if(valid(token)){setError((e as Error).message);if(!(e instanceof SceneConflictError))setRetry({label:'Retry last cloud action',run:()=>void run(work)});}}
    finally{if(token===operation.current){lock.current=false;if(valid(token))setBusy(false);}}
  }
  async function performSwitch(action:()=>RoomDestination|Promise<RoomDestination>,discard=false){
    if(lock.current)return;
    const token=++operation.current;operationScope.current=latest.current.getScope();lock.current=true;setBusy(true);setError('');setRetry(null);
    try{
      if(!discard)await latest.current.flushDraft();
      if(!valid(token))return;
      const destination=await action();
      if(!valid(token))return;
      setPendingSwitch(null);namedRoom.current=destination.roomId;setName(destination.name??destination.scene?.name??'Untitled room');
      setMessage(destination.message??'Room opened.');replace(destination);
    }catch(e){if(valid(token)){setError((e as Error).message);if(!(e instanceof SceneConflictError))setRetry({label:'Retry room switch',run:()=>void performSwitch(action,discard)});}}
    finally{if(token===operation.current){lock.current=false;if(valid(token))setBusy(false);}}
  }
  function requestSwitch(label:string,action:()=>RoomDestination|Promise<RoomDestination>){
    if(dirty){returnFocus.current=document.activeElement as HTMLElement;setError('');setRetry(null);setPendingSwitch({label,action});return;}
    void performSwitch(action);
  }
  useImperativeHandle(ref,()=>({requestSwitch}));
  useEffect(()=>{setPendingSwitch(null);setRetry(null);},[roomOperation]);
  useEffect(()=>{
    if(!pendingSwitch)return;
    dialog.current?.showModal();
    return()=>{dialog.current?.close();returnFocus.current?.focus();};
  },[!!pendingSwitch]);
  function cancelAction(){cancelled.current++;operation.current++;lock.current=false;setBusy(false);setPendingSwitch(null);setRetry(null);setError('');setMessage('Action cancelled; current room retained.');}
  async function saveBeforeSwitch(){
    const pending=pendingSwitch,account=latest.current.owner,cancellation=cancelled.current;if(!pending)return;
    const saved=await saveCurrent();
    if(account!==latest.current.owner||!active.current||cancellation!==cancelled.current)return;
    if(saved){setPendingSwitch(null);void performSwitch(pending.action);}
    else setRetry({label:'Retry save and continue',run:()=>void saveBeforeSwitch()});
  }
  async function saveCurrent():Promise<boolean>{
    if(!latest.current.owner){
      if(lock.current)return false;
      const token=++operation.current;operationScope.current=latest.current.getScope();lock.current=true;setBusy(true);setError('');
      try{await latest.current.flushDraft();if(!valid(token))return false;setMessage('Local draft saved.');return true;}
      catch(e){if(valid(token))setError((e as Error).message);return false;}
      finally{if(token===operation.current){lock.current=false;if(valid(token))setBusy(false);}}
    }
    if(!latest.current.name.trim()){setError('Name the room before saving.');return false;}
    let succeeded=false;
    await run(async(repo,token)=>{
      const state=latest.current;
      const scope=state.getScope();
      if(saveIdentity.current?.scope!==scope)saveIdentity.current={scope,id:/^[a-f0-9-]{36}$/i.test(state.roomId)?state.roomId:crypto.randomUUID()};
      const result=await repo.save(state.workspace,state.name,state.current?.id??saveIdentity.current.id,state.current?.revision??0,upload&&cloudStorageEnabled,text=>{if(valid(token))setMessage(text);});
      if(!valid(token))return;
      // Listing is independent of a successful save; a list failure must never retry the write.
      setScenes(rows=>[result.scene,...rows.filter(row=>row.id!==result.scene.id)]);
      setMessage('Scene saved to Postgres.');namedRoom.current=result.scene.id;setName(result.scene.name);succeeded=true;
      replace({...result,roomId:result.scene.id});
    });
    return succeeded;
  }
  async function openScene(scene:SavedScene):Promise<RoomDestination>{
    const state=latest.current;if(!state.owner)throw new Error('Sign in to open this scene.');
    const repo=new SceneRepository(await connectUserClient(state.owner),state.owner,cloudStorageEnabled);
    const local=await listLibrary();
    const result=await repo.open(scene.id,[...state.workspace.items.filter(i=>!i.missing).map(i=>i.asset),...local.map(e=>e.asset)],()=>{});
    return {...result,roomId:result.scene.id,message:result.workspace.items.some(i=>i.missing)?'Scene opened with unavailable geometry. Retrieve exact pinned versions; unversioned assets can be reimported.':'Cloud scene opened.'};
  }
  function restoreRevision(revision:number,baseRevision:number){
    if(!current)return;
    const id=current.id;
    if(!window.confirm(`Restore revision ${revision} as a new head based on revision ${baseRevision}?${dirty?' This replaces your unsaved local edits. Export or save them first if you need to keep them.':''} Existing saved revisions will remain unchanged.`))return;
    const writeId=crypto.randomUUID();
    void performSwitch(async()=>{
      const state=latest.current;if(!state.owner)throw new Error('Sign in to restore this revision.');
      const repo=new SceneRepository(await connectUserClient(state.owner),state.owner,cloudStorageEnabled);
      const restored=await repo.restore(id,revision,baseRevision,writeId);
      const local=await listLibrary();
      const result=await repo.open(id,[...state.workspace.items.filter(item=>!item.missing).map(item=>item.asset),...local.map(entry=>entry.asset)],()=>{},restored.revision);
      return {...result,roomId:id,message:`Restored revision ${revision} as revision ${restored.revision}.${result.workspace.items.some(item=>item.missing)?' Some exact geometry is unavailable.':''}`};
    },true);
  }

  async function duplicateScene(scene:SavedScene):Promise<RoomDestination>{
    const state=latest.current;if(!state.owner)throw new Error('Sign in to duplicate this scene.');
    const repo=new SceneRepository(await connectUserClient(state.owner),state.owner,cloudStorageEnabled);
    const duplicate=await repo.duplicate(scene,`${scene.name} copy`);
    return {...await openScene(duplicate),message:'Room duplicated.'};
  }
  function deleteScene(scene:SavedScene){
    if(!window.confirm(`Delete ${scene.name}? Shared geometry and other rooms remain.`))return;
    const remove=async()=>{
      const account=latest.current.owner;if(!account)throw new Error('Sign in to delete this scene.');
      await new SceneRepository(await connectUserClient(account),account,cloudStorageEnabled).remove(latest.current.current?.id===scene.id?latest.current.current:scene);
      return {workspace:emptyWorkspace(),scene:null,roomId:crypto.randomUUID(),message:'Room deleted; shared cloud files retained.'};
    };
    if(current?.id===scene.id)requestSwitch(`Delete ${scene.name}`,remove);
    else void run(async(repo,token)=>{await repo.remove(scene);if(valid(token)){setScenes(rows=>rows.filter(row=>row.id!==scene.id));setMessage('Room deleted; shared cloud files retained.');}});
  }
  function deleteMetadata(asset:AssetRow){if(!window.confirm(`Delete cloud metadata for ${asset.name}? Binary versions must be removed first.`))return;void run(async(repo,token)=>{await repo.deleteMetadata(asset.asset_key);if(!valid(token))return;setCatalog((rows)=>rows.filter(row=>row.asset_key!==asset.asset_key));setMessage('Asset metadata deleted.');});}
  const urls=current?sceneURLs(current.id,current.revision,window.location.origin):null;
  const dirty=current?!current.document||canonicalJSON(sceneContent(current.document))!==canonicalJSON(makeManifest(workspace))||current.name!==name.trim():canonicalJSON(makeManifest(workspace))!==canonicalJSON(makeManifest(emptyWorkspace()))||name.trim()!=='Untitled room';
  return <section aria-label="Scene persistence">
    <div className="eyebrow">SCENES / POSTGRES</div>
    <p>{current?`Cloud revision ${current.revision} · ${dirty?'Unsaved changes':'Saved'}`:'Local workspace · not saved to cloud'}</p>
    <button disabled={busy} onClick={onExport}>Export scene JSON</button>
    {!owner?<p>Sign in to save scenes and library metadata across devices. You can export/import scene JSON locally.</p>:<>
      <label>Scene name<input aria-label="Scene name" value={name} disabled={busy} maxLength={200} onChange={e=>setName(e.target.value)}/></label>
      <label className="inline-check"><input aria-label="Include cloud geometry" type="checkbox" checked={upload&&cloudStorageEnabled} disabled={busy||!cloudStorageEnabled} onChange={e=>setUpload(e.target.checked)}/> Include cloud geometry</label>
      <p>{cloudStorageEnabled?'Saving with geometry uploads the referenced assets for use on other devices.':'Storage is disabled. Metadata-only scenes can still be saved; geometry must be reimported on other devices.'}</p>
      <div className="capture-actions"><button disabled={busy||!name.trim()} onClick={()=>void saveCurrent()}>Save cloud scene</button><button disabled={busy} onClick={()=>requestSwitch('Create a new room',()=>({workspace:emptyWorkspace(),scene:null,roomId:crypto.randomUUID(),message:'New room ready.'}))}>New room</button><button disabled={busy||!current} onClick={()=>requestSwitch('Create a copy',()=>({workspace:latest.current.workspace,scene:null,roomId:crypto.randomUUID(),name:`${latest.current.name} copy`,message:'Copy ready to save as a new room.'}))}>Save as new copy</button><button disabled={busy} onClick={()=>void run(async(repo,token)=>{const rows=await repo.list();if(valid(token))setScenes(rows);})}>Refresh scenes</button></div>
      {current&&urls&&<div aria-label="Scene links">
        <p>Private links require the owner's sign-in.</p>
        <p><a href={urls.head_url}>Open latest revision</a><br/><a href={urls.revision_url}>Open revision {current.revision}</a></p>
        <button disabled={busy} onClick={()=>void navigator.clipboard.writeText(urls.revision_url)
          .then(()=>setMessage('Private revision link copied.'))
          .catch(()=>setError('Copy failed. Copy the revision link address above.'))}>Copy private revision link</button>
        <p>Sharing lets anyone with the link view this saved revision and its geometry for 7 days. Edits must be saved before sharing.</p>
        <button disabled={busy||dirty} onClick={()=>void run(async(repo,token)=>{
          const share=await repo.share(current);
          if(valid(token)){setShareURL(share.url);setMessage(`Shared revision ${current.revision} until ${new Date(share.expires_at).toLocaleString()}.`);}
        })}>Create shared revision link</button>
        <button disabled={busy} onClick={()=>void run(async(repo,token)=>{
          await repo.revokeShares(current.id);
          if(valid(token)){setShareURL('');setMessage('All shared links for this scene revoked.');}
        })}>Revoke all shared links</button>
        {shareURL&&<>
          <label>Shared revision URL<input aria-label="Shared revision URL" readOnly value={shareURL}/></label>
          <button onClick={()=>void navigator.clipboard.writeText(shareURL)
            .then(()=>setMessage('Shared revision link copied.'))
            .catch(()=>setError('Copy failed. Select and copy the shared URL.'))}>Copy shared link</button>
        </>}
      </div>}
      {current?.owner_id===owner&&<SceneHistory key={`${owner}:${current.id}:${current.revision}`} scene={current} owner={owner} busy={busy} restore={restoreRevision}/>}
      {scenes.map(scene=><div className={`saved-scene ${current?.id===scene.id?'active-scene':''}`} key={scene.id}><span><b>{scene.name}</b><br/><small>Revision {scene.revision} · {new Date(scene.updated_at).toLocaleString()}</small></span><div className="capture-actions"><button disabled={busy} aria-label={`Open scene ${scene.name}`} onClick={()=>requestSwitch(`Open ${scene.name}`,()=>openScene(scene))}>Open</button><button disabled={busy} aria-label={`Duplicate scene ${scene.name}`} onClick={()=>requestSwitch(`Create a copy of ${scene.name}`,()=>duplicateScene(scene))}>Duplicate</button><button disabled={busy} aria-label={`Delete scene ${scene.name}`} onClick={()=>deleteScene(scene)}>Delete</button></div></div>)}
      <details><summary>Cloud library metadata</summary><p>Explicitly sync the device library catalog through Postgres. This does not upload binary geometry or GIFs.</p><div className="capture-actions"><button disabled={busy} onClick={()=>void run(async(repo,token)=>{const local=await listLibrary();await repo.saveMetadata(local.map(e=>e.asset));const rows=await repo.catalog();if(valid(token)){setCatalog(rows);setMessage('Library metadata synced.');}})}>Sync library metadata</button><button disabled={busy} onClick={()=>void run(async(repo,token)=>{const rows=await repo.catalog();if(valid(token))setCatalog(rows);})}>Refresh asset metadata</button></div>{catalog.map(asset=><div className="metadata-row" key={asset.id}><p><b>{asset.name}</b><br />{asset.source_kind} · {asset.metadata.dimensions?.join(' × ')} m<br /><small>Use Cloud files to retrieve geometry, or reimport the matching source.</small></p><button disabled={busy} onClick={()=>deleteMetadata(asset)}>Delete metadata</button></div>)}</details>
    </>}
    {pendingSwitch&&<dialog ref={dialog} className="switch-confirm" aria-label="Unsaved room changes" onCancel={e=>{e.preventDefault();cancelAction();}}><b>Unsaved changes</b><p>{owner?'Save this room to cloud before continuing, or explicitly discard the pending edits.':'Save this room as a local draft before continuing. Export scene JSON to keep a portable copy.'}</p><p>{pendingSwitch.label}?</p><div className="capture-actions"><button disabled={busy} onClick={()=>void saveBeforeSwitch()}>Save and continue</button><button disabled={busy} onClick={()=>void performSwitch(pendingSwitch.action,true)}>Discard and continue</button><button onClick={cancelAction}>Cancel</button></div>{retry&&<button disabled={busy} onClick={retry.run}>{retry.label}</button>}{error&&<p role="alert" className="capture-error">{error}</p>}</dialog>}
    {!pendingSwitch&&retry&&<button disabled={busy} onClick={retry.run}>{retry.label}</button>}
    {!pendingSwitch&&busy&&lock.current&&<button onClick={cancelAction}>Cancel current action</button>}
    <p role="status" aria-label="Scene save status">{busy?'Working… ':''}{message}</p>
    {!pendingSwitch&&error&&<p role="alert" className="capture-error">{error}</p>}
  </section>;
}
