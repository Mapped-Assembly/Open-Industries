import { useEffect,useLayoutEffect,useRef,useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal,flushSync } from 'react-dom';
import { ImportService } from './lib/imports';
import type { Asset,Vec3 } from './lib/scene';
import { appendAssets,emptyWorkspace,hydrateManifest,readManifest,type Workspace } from './lib/workspace';
import { preserveAuthWorkspace,restoreAuthWorkspace } from './lib/auth-workspace';
import { useUserId } from './lib/use-user';
import type { RoomDestination,RoomTransitionHandle } from './lib/room-transition';
import type { SavedScene } from './lib/scene-repository';
import type { FloorRegion } from './lib/gif';
import type { GifMetadata } from './lib/gif';
import { makeAnimationFeedback } from './lib/animation-feedback';
import { readSamplingPlan, type SamplingRoomPlan } from './lib/cleanroom';
import { SPACE_BRIEFS, buildSpace, inferSpaceBrief, type SpaceBriefKey } from './lib/space-builder';
import { CaptureTools } from './components/capture-tools';
import { AuthControls } from './components/auth-controls';
import { WorkspaceViewer } from './components/workspace-viewer';
import { Timeline } from './components/timeline';
import { SceneControls } from './components/scene-controls';
import { ProjectInspector } from './components/project-inspector';
import { FormGeneration } from './components/form-generation';
import { generateFormProject, type GenerationRequest } from './lib/form-generation';
import { downloadProject, formaProjectJSON, oiProjectJSON, projectFilename } from './lib/project-files';
import { backupDraft, loadWorkspaceDraft, replaceDraftWithBackup, saveWorkspaceDraft } from './lib/workspace-draft';
import { supabase } from './lib/supabase';
import { readSceneLink } from './lib/scene-links';
import { downloadSharedGeometry, openSceneLink, publicSceneClient } from './lib/scene-link-loader';
import { connectUserClient } from './lib/cloud-session';
import './style.css';
import './workspace.css';

const importer=new ImportService();
type History={past:Workspace[];present:Workspace;future:Workspace[]};
function App(){
  const [history,setHistory]=useState<History>(()=>({past:[],present:emptyWorkspace(),future:[]}));
  const workspace=history.present;const assets=workspace.items.map(i=>i.asset);
  const latestWorkspace=useRef(workspace);latestWorkspace.current=workspace;
  const [selected,setSelected]=useState(-1);const[selectedPart,setSelectedPart]=useState(-1);const[focus,setFocus]=useState(0);
  const [time,setTime]=useState<number|null>(null);const[playing,setPlaying]=useState(false);
  const [currentScene,setCurrentScene]=useState<SavedScene|null>(null);
  const [roomId,setRoomId]=useState('local');
  const [status,setStatus]=useState('Ready to import');const[error,setError]=useState('');const[busyState,setBusy]=useState(true);
  const [spaceKey,setSpaceKey]=useState<SpaceBriefKey>('maker');const[spaceRequirements,setSpaceRequirements]=useState(SPACE_BRIEFS.maker.description);
  const [upAxis,setUpAxis]=useState<'Z'|'Y'>('Z');const[scale,setScale]=useState(1);
  const stage=useRef<HTMLDivElement>(null);const input=useRef<HTMLInputElement>(null);const folderInput=useRef<HTMLInputElement>(null);
  const oiInput=useRef<HTMLInputElement>(null);
  const [fullscreen,setFullscreen]=useState(false);const[expanded,setExpanded]=useState(false);const[workspaceVisible,setWorkspaceVisible]=useState(false);
  const [captureOpen,setCaptureOpen]=useState(false);const[captureRegion,setCaptureRegion]=useState<FloorRegion|null>(null);
  const isFullscreen=fullscreen||expanded;const restoreAfterPicker=useRef(false);
  const workspaceSlot=useRef<HTMLDivElement>(null);
  const [workspaceHost]=useState(()=>{const host=document.createElement('div');host.style.display='contents';return host;});
  useLayoutEffect(()=>{
    (isFullscreen?stage.current:workspaceSlot.current)?.append(workspaceHost);
    return()=>workspaceHost.remove();
  },[isFullscreen,workspaceHost]);
  const linkMode=new URLSearchParams(location.search).has('sceneId');
  const [linkHash,setLinkHash]=useState(location.hash);
  const [linkedScene,setLinkedScene]=useState<SavedScene|null>(null);
  const cleanroomPreview=!linkMode&&new URLSearchParams(location.search).get('scene')==='cleanroom';
  const owner=useUserId();const previousOwner=useRef<string|null>(null);
  const roomOperation=useRef(0);const sceneControls=useRef<RoomTransitionHandle>(null);
  const session=useRef({owner,roomId,workspace,currentScene});session.current={owner,roomId,workspace,currentScene};
  const mainOperation=useRef(0);
  const getScope=()=>`${session.current.owner??'guest'}:${session.current.roomId}:${roomOperation.current}`;
  const[draftReady,setDraftReady]=useState(false);const draftOwner=useRef<string|null>(null);const draftEpoch=useRef(0);const[localSaved,setLocalSaved]=useState(false);
  const busy=busyState||(!linkMode&&(!draftReady||previousOwner.current!==owner));
  const [adoptionPending,setAdoptionPending]=useState(false);
  const [draftRecovery,setDraftRecovery]=useState<{scope:string;message:string}|null>(null);
  const [samplingPlan,setSamplingPlan]=useState<SamplingRoomPlan[]>([]);
  function change(next:Workspace){setLocalSaved(false);setHistory(old=>({past:[...old.past,old.present].slice(-50),present:next,future:[]}));}
  function acceptSavedScene(scene:SavedScene|null){
    setCurrentScene(scene);
    if(linkMode&&scene){
      setLinkedScene(scene);
      window.history.replaceState(null,'',`/?sceneId=${encodeURIComponent(scene.id)}&revision=${scene.revision}`);
    }
  }
  function replace(next:Workspace){setLocalSaved(false);roomOperation.current++;latestWorkspace.current=next;session.current.workspace=next;setPlaying(false);setTime(null);setSelected(-1);setSelectedPart(-1);setHistory({past:[],present:next,future:[]});setFocus(n=>n+1);}
  function installRoom(destination:RoomDestination){
    // Identity and contents change in the same React update and synchronous guard.
    session.current={...session.current,workspace:destination.workspace,roomId:destination.roomId,currentScene:destination.scene};
    setRoomId(destination.roomId);acceptSavedScene(destination.scene);replace(destination.workspace);
    setCaptureOpen(false);setCaptureRegion(null);setBusy(false);setError('');setDraftRecovery(null);
    if(destination.selected!==undefined)setSelected(destination.selected);
    if(destination.message)setStatus(destination.message);
  }
  async function flushDraft(){
    if(linkMode||cleanroomPreview)return;
    if(draftRecovery)throw new Error('Recover the existing draft or explicitly discard it before switching rooms.');
    const state=session.current,scope=getScope();
    await saveWorkspaceDraft(state.workspace,state.owner,state.roomId,state.currentScene,()=>scope===getScope());
    if(scope===getScope())setLocalSaved(true);
  }
  function requestNewRoom(){sceneControls.current?.requestSwitch('Create a new room',()=>({workspace:emptyWorkspace(),scene:null,roomId:crypto.randomUUID(),message:'New room ready.'}));}
  useEffect(()=>{
    if(linkMode||!draftReady)return;
    const previous=previousOwner.current;previousOwner.current=owner;
    if(previous===owner)return;
    roomOperation.current++;
    if(!previous&&owner&&draftOwner.current!==owner&&workspace.items.length){setAdoptionPending(true);setBusy(true);setStatus('Choose what to do with this anonymous draft.');return;}
    {
      if(previous&&draftOwner.current===previous)void saveWorkspaceDraft(workspace,previous,roomId,currentScene,()=>false).catch(()=>setError('The previous account draft could not be saved on this device.'));
      const epoch=++draftEpoch.current;draftOwner.current=owner;setAdoptionPending(false);
      installRoom({workspace:emptyWorkspace(),scene:null,roomId:crypto.randomUUID()});setDraftReady(false);setBusy(true);
      void loadWorkspaceDraft(owner).then(draft=>{
        if(epoch!==draftEpoch.current||session.current.owner!==owner)return;
        if(draft)installRoom({...draft,message:'Restored account workspace.'});
        else setStatus('Account changed; a clean workspace is active.');
      }).catch(e=>{if(epoch===draftEpoch.current)setDraftRecovery({scope:owner??'guest',message:e.message});})
        .finally(()=>{if(epoch===draftEpoch.current){setDraftReady(true);setBusy(false);}});
    }
  },[owner,draftReady]);
  useEffect(()=>{
    if(!linkMode)return;
    const changed=()=>setLinkHash(location.hash);
    window.addEventListener('hashchange',changed);
    return()=>window.removeEventListener('hashchange',changed);
  },[linkMode]);
  useEffect(()=>{
    if(!linkMode)return;
    let active=true;
    setBusy(true);setError('');setLinkedScene(null);setCurrentScene(null);setCaptureOpen(false);replace(emptyWorkspace());
    setStatus('Opening scene link…');
    void (async()=>{
      const link=readSceneLink(new URL(location.href))!;
      const session=supabase?await supabase.auth.getSession():null;
      const id=session?.data.session?.user.id??null;
      const client=link.token||!id?publicSceneClient():await connectUserClient(id);
      const result=await openSceneLink(client,link,version=>downloadSharedGeometry(link,version));
      if(!active)return;
      replace(result.workspace);setLinkedScene(result.scene);
      setCurrentScene(!link.token&&result.scene.owner_id===id?result.scene:null);
      setRoomId(crypto.randomUUID());setTime(0);
      setStatus(`Opened ${result.scene.name} · revision ${result.scene.revision}${link.revision?' (pinned)':' (latest)'}`);
      if(result.notice)setError(result.notice);
    })().catch(e=>{if(active){setError((e as Error).message);setStatus('Scene link could not be opened.');}}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;};
  },[owner,linkHash]);
  useEffect(()=>{
    if(linkMode)return;
    let active=true;const epoch=draftEpoch.current;let requestedScope='guest';
    const fallback=window.setTimeout(()=>{if(active){setDraftReady(true);setBusy(false);setDraftRecovery({scope:requestedScope,message:'Saved workspace loading exceeded 12 seconds. Retry or recover it without discarding the stored data.'});setError('Saved workspace loading timed out.');}},12000);
    void (async()=>{
      const authSession=supabase?await supabase.auth.getSession():null;const id=authSession?.data.session?.user.id??null;
      requestedScope=id??'guest';
      let snapshot:Awaited<ReturnType<typeof restoreAuthWorkspace>>=null;
      let draft:Awaited<ReturnType<typeof loadWorkspaceDraft>>=null;
      let restored:Workspace|undefined;
      if(cleanroomPreview){
        const [sceneResponse,planResponse]=await Promise.all([fetch('/examples/cleanroom/cleanroom-suite.json'),fetch('/examples/cleanroom/sampling-plan.json')]);
        if(!sceneResponse.ok||!planResponse.ok)throw new Error('The bundled cleanroom example could not be loaded.');
        const [scene,plan]=await Promise.all([sceneResponse.json(),planResponse.json()]);
        restored=hydrateManifest(readManifest(scene),[]);setSamplingPlan(readSamplingPlan(plan));
      }else{
        snapshot=await restoreAuthWorkspace();restored=snapshot?.workspace;
        if(snapshot&&!restored){restored=appendAssets(emptyWorkspace(),snapshot.assets);restored.room=snapshot.room as Vec3;restored.items=restored.items.map((item,i)=>({...item,position:snapshot?.positions?.[i]??item.position}));}
        draft=restored?null:await loadWorkspaceDraft(id);restored??=draft?.workspace;
        if(!restored){const response=await fetch('/default-room.json');if(response.ok)restored=hydrateManifest(readManifest(await response.json()),[]);}
      }
      if(!active||epoch!==draftEpoch.current||session.current.owner!==id)return;draftOwner.current=id;previousOwner.current=id;
      if(restored){replace(restored);setCurrentScene(cleanroomPreview?null:draft?.scene??null);setRoomId(draft?.roomId??(cleanroomPreview?'cleanroom-suite-doubled':'default-machine-room'));setSelected(cleanroomPreview?-1:snapshot?.selected??(restored.items.length?0:-1));if(cleanroomPreview){setTime(0);setPlaying(true);}setStatus(cleanroomPreview?'Playing cleanroom sampling route':snapshot?'Restored workspace after sign-in':draft?'Restored local draft':'Loaded default machine interface room');}
    })().catch(e=>{if(active){draftOwner.current=requestedScope==='guest'?null:requestedScope;setDraftRecovery({scope:requestedScope,message:e instanceof Error?e.message:'The saved workspace could not be opened.'});setError('Your saved local workspace is invalid. Recover it below or start a clean workspace.');}}).finally(()=>{clearTimeout(fallback);if(active){setDraftReady(true);setBusy(false);}});
    return()=>{active=false;clearTimeout(fallback);};
  },[]);
  useEffect(()=>{
    if(linkMode||!draftReady||draftRecovery||draftOwner.current!==owner||cleanroomPreview||session.current.workspace!==workspace||session.current.roomId!==roomId)return;setLocalSaved(false);
    const scope=getScope();let active=true;
    const timer=setTimeout(()=>{void saveWorkspaceDraft(workspace,owner,roomId,currentScene,()=>scope===getScope()).then(()=>{if(active&&scope===getScope())setLocalSaved(true);}).catch(e=>{if(active&&scope===getScope())setError(e.message);});},250);
    return()=>{active=false;clearTimeout(timer);};
  },[workspace,owner,roomId,draftReady,currentScene,draftRecovery]);
  useEffect(()=>{
    if(!playing)return;let frame=0,last=performance.now();
    const tick=(now:number)=>{const dt=Math.min((now-last)/1000,.1);last=now;setTime(t=>{const next=(t??0)+dt;if(next>=workspace.animation.duration){if(workspace.animation.loop)return next%workspace.animation.duration;setPlaying(false);return workspace.animation.duration;}return next;});frame=requestAnimationFrame(tick);};
    frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
  },[playing,workspace.animation.duration,workspace.animation.loop]);
  useEffect(()=>{
    const sync=()=>setFullscreen(document.fullscreenElement===stage.current);
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape')setExpanded(false);};
    document.addEventListener('fullscreenchange',sync);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('fullscreenchange',sync);document.removeEventListener('keydown',escape);};
  },[]);
  useEffect(()=>{if(!expanded)return;const previous=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{document.body.style.overflow=previous;};},[expanded]);
  async function toggleFullscreen(){
    if(isFullscreen){restoreAfterPicker.current=false;if(document.fullscreenElement===stage.current)await document.exitFullscreen();setExpanded(false);return;}
    try{if(!stage.current?.requestFullscreen)throw new Error();await stage.current.requestFullscreen();}catch{setExpanded(true);}
  }
  function openFilePicker(folder=false,oi=false){restoreAfterPicker.current=document.fullscreenElement===stage.current;if(isFullscreen)flushSync(()=>setExpanded(true));(oi?oiInput:folder?folderInput:input).current?.click();}
  function finishFilePicker(){const restore=restoreAfterPicker.current;restoreAfterPicker.current=false;if(!restore)return;if(document.fullscreenElement===stage.current){setExpanded(false);return;}void stage.current?.requestFullscreen?.().then(()=>setExpanded(false)).catch(()=>{});}
  useEffect(()=>{const elements=[input.current,folderInput.current,oiInput.current];if(folderInput.current)folderInput.current.webkitdirectory=true;for(const el of elements)el?.addEventListener('cancel',finishFilePicker);return()=>{for(const el of elements)el?.removeEventListener('cancel',finishFilePicker);};});
  function addAsset(asset:Asset,cloudVersionId?:string){
    try { change(appendAssets(latestWorkspace.current,[asset],cloudVersionId)); } catch(e) { setError((e as Error).message);return; }
    setError('');
    setSelected(workspace.items.length);setSelectedPart(-1);setTime(null);setPlaying(false);setStatus(`Added ${asset.name} from library`);
  }
  async function adoptAnonymousDraft(){
    if(!owner)return;
    const account=owner,scope=getScope();
    try{await saveWorkspaceDraft(workspace,null,roomId,null,()=>false);if(scope!==getScope())return;
      draftOwner.current=account;installRoom({workspace,scene:null,roomId:crypto.randomUUID(),message:'Anonymous draft adopted. Save it to your account when ready.'});setAdoptionPending(false);
    }catch(e){if(scope===getScope())setError((e as Error).message);}
  }
  async function discardAnonymousDraft(){
    if(!owner)return;
    const account=owner,scope=getScope();
    try{await saveWorkspaceDraft(workspace,null,roomId);if(scope!==getScope())return;
      draftOwner.current=account;installRoom({workspace:emptyWorkspace(),scene:null,roomId:crypto.randomUUID(),message:'Anonymous draft retained locally; a clean account workspace is active.'});setAdoptionPending(false);
    }catch(e){if(scope===getScope())setError((e as Error).message);}
  }
  async function load(files:File[],oiOnly=false){
    if(busy||!files.length)return;setBusy(true);setError('');
    const scope=getScope(),operation=++mainOperation.current;
    const valid=()=>scope===getScope()&&operation===mainOperation.current;
    let destination:Workspace|undefined;
    try{
      if(files.length===1&&files[0].name.toLowerCase().endsWith('.json')){
        if(files[0].size>75*1024*1024)throw new Error('Scene file exceeds 75 MiB.');
        let json;try{json=JSON.parse(await files[0].text());}catch{/* Form importer supplies its normal invalid-JSON diagnostic. */}
        if(!valid())return;
        if(json?.format==='astra.scene')destination=hydrateManifest(readManifest(json),assets);
      }
      if(oiOnly&&!destination)throw new Error('Choose an exported OI project (.oi.json) or legacy scene JSON. Use Import project for Forma equipment and STEP files.');
      if(!destination){
        const next=await importer.files(files,{upAxis,scale},text=>{if(valid())setStatus(text);});
        if(!valid())return;
        const current=latestWorkspace.current;
        const repair=current.items.findIndex(i=>i.missing&&next.some(a=>a.id===i.asset.id));
        change(appendAssets(current,next));setSelected(repair>=0?repair:current.items.length);
        setSelectedPart(-1);setTime(null);setPlaying(false);setStatus(`Imported ${next.length} asset(s)`);
      }
    }catch(e){if(valid()){setError((e as Error).message);setStatus('Import failed');}}finally{if(valid())setBusy(false);}
    if(destination&&valid())sceneControls.current?.requestSwitch('Open imported scene',()=>({workspace:destination!,scene:null,roomId:crypto.randomUUID(),message:'Scene JSON opened.'}));
  }
  async function generate(request:GenerationRequest){
    if(busy)return;setBusy(true);setError('');setStatus('Starting Form…');
    const scope=getScope(),operation=++mainOperation.current;
    const valid=()=>scope===getScope()&&operation===mainOperation.current;
    try{
      const project=await generateFormProject(request,text=>{if(valid())setStatus(text);},valid);
      if(!valid()||!project)return;
      const next=await importer.files([new File([JSON.stringify(project)],'form-generated.json')],{upAxis:'Z',scale:1},text=>{if(valid())setStatus(text);});
      if(!valid())return;const current=latestWorkspace.current;change(appendAssets(current,next));setSelected(current.items.length);setSelectedPart(-1);setTime(null);setPlaying(false);setStatus(`Form ${request.mode} project imported`);
    }catch(e){if(valid()){setError((e as Error).message);setStatus('Generation failed');}}finally{if(valid())setBusy(false);}
  }
  async function sendAnimationFeedback(review: GifMetadata, instruction: string) {
    const scope=getScope();
    const feedback = makeAnimationFeedback(workspace, review, instruction);
    const response = await fetch('/api/form/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(feedback) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? 'Could not send animation feedback.');
    if(scope===getScope())setStatus(data.message ?? 'Animation feedback saved for Form.');
  }
  function buildDemoSpace() {
    const result=buildSpace(inferSpaceBrief(spaceRequirements)||spaceKey,spaceRequirements);
    sceneControls.current?.requestSwitch('Build a generated layout',()=>({workspace:result.workspace,scene:null,roomId:crypto.randomUUID(),selected:result.movingIndex,message:`Built ${result.brief.label} layout with ${result.workspace.items.length} Form equipment envelopes. Replace envelopes with Form-authored equipment when ready.`}));
  }
  function exportScene(){
    try{downloadProject(oiProjectJSON(workspace),projectFilename(currentScene?.name??'oi-project','oi'));setError('');setStatus(workspace.items.some(item=>item.missing)?'OI project exported. Missing geometry remains unresolved.':'OI project exported with equipment, layout, and animation.');}
    catch(e){setError((e as Error).message);}
  }
  function exportForma(){
    const asset=workspace.items[selected]?.asset;if(!asset)return;
    try{downloadProject(formaProjectJSON(asset),projectFilename(asset.name,'forma'));setError('');setStatus('Forma project JSON exported. Referenced CAD files are separate.');}
    catch(e){setError((e as Error).message);}
  }
  async function exportCorruptDraft(){
    if(!draftRecovery)return;
    try{const backup=await backupDraft(draftRecovery.scope);const blob=new Blob([JSON.stringify(backup,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='open-industries-draft-recovery.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setStatus('Recovery backup downloaded.');}
    catch(e){setError((e as Error).message);}
  }
  async function resetCorruptDraft(){
    if(!draftRecovery)return;
    const scope=getScope();setBusy(true);
    try{const clean=emptyWorkspace(),newRoom=crypto.randomUUID();await replaceDraftWithBackup(clean,draftOwner.current,draftRecovery.scope,newRoom,null);
      if(scope!==getScope())return;
      installRoom({workspace:clean,scene:null,roomId:newRoom,message:'A clean workspace was created. The corrupt draft was backed up locally.'});
    }catch(e){if(scope===getScope())setError((e as Error).message);}
    finally{if(scope===getScope())setBusy(false);}
  }
  const side=<aside id="workspace-panel" className={isFullscreen?'fullscreen-workspace':''} hidden={isFullscreen&&!workspaceVisible}>
    <div className="eyebrow">WORKSPACE</div><h1>Make room<br/>for your ideas.</h1><p>Generate Forma equipment or import an OI project, Forma JSON, or STEP model. Arrange it, author motion, and export the project to keep or share.</p>
    <small role="status" aria-label="Local draft status">{linkMode?'Link workspace · not autosaved':localSaved?'Local draft saved':'Local draft changes pending'}</small>
    {linkMode&&<section aria-label="Scene link"><b>{linkedScene?`${linkedScene.name} · revision ${linkedScene.revision}`:'Scene link'}</b><p>This workspace is separate from your saved local rooms. Export edits or save to cloud to keep them.</p><a href="/">Return to saved workspace</a><button disabled={busy} onClick={()=>location.reload()}>Reload scene link</button></section>}
    <div className="capture-actions"><button onClick={()=>document.querySelector('.timeline')?.scrollIntoView({block:'start'})}>Animate</button><button onClick={()=>document.querySelector('[aria-label="Scene persistence"]')?.scrollIntoView({block:'start'})}>Save / open scenes</button></div>
     {cleanroomPreview&&<section className="cleanroom-plan" aria-label="Today's cleanroom sampling plan"><div className="eyebrow">TODAY'S SAMPLING / POC</div><table aria-label="Room access and sample schedule"><thead><tr><th scope="col">Room</th><th scope="col">Samples</th><th scope="col">Proposed times</th><th scope="col">Access status</th></tr></thead><tbody>{samplingPlan.map(room=><tr key={room.room} className={room.access.status==='blocked'?'blocked-room':''}><th scope="row">{room.room}</th><td>{room.requiredSamples}</td><td>{room.proposedTimes.length?room.proposedTimes.map((time,index)=><span key={`${time.start}-${time.end}`}>{index>0&&<br/>}{time.start}–{time.end}</span>):'Not scheduled'}</td><td>{room.access.status==='available'?`Available ${room.access.window.start}–${room.access.window.end}`:`No access window; ${room.access.reason}`}</td></tr>)}</tbody></table><p>Facility map: A northwest, B northeast, C southwest; D is unplanned. The bot enters A and C only, and skips occupied Room B. Animation scale: 1 second = 1 scheduled minute from 09:00. POC only; confirm current access and sample points before operation.</p></section>}
    <input ref={input} aria-label="Import files" type="file" accept=".json,.step,.stp" multiple hidden onChange={e=>{finishFilePicker();void load(Array.from(e.target.files??[]));e.target.value='';}}/>
    <input ref={folderInput} aria-label="Import project folder" type="file" multiple hidden onChange={e=>{finishFilePicker();void load(Array.from(e.target.files??[]));e.target.value='';}}/>
    <input ref={oiInput} aria-label="Import OI project file" type="file" accept=".json" hidden onChange={e=>{finishFilePicker();void load(Array.from(e.target.files??[]),true);e.target.value='';}}/>
    <section aria-label="Project files" className="project-files"><div className="eyebrow">PROJECT FILES</div><div className="capture-actions"><button disabled={busy} onClick={()=>openFilePicker(false,true)}>Import OI project</button><button disabled={busy} onClick={exportScene}>Export OI project</button></div><p>Includes the room, equipment geometry, layout, and animation. Opens without signing in.</p><button disabled={busy||!workspace.items[selected]?.asset.formProject} onClick={exportForma}>Export selected Forma project</button><small className="project-file-note">Forma JSON contains the equipment design and BOM. Referenced CAD files stay separate; use OI export to carry the displayed geometry.</small></section>
    {!cleanroomPreview&&<FormGeneration busy={busy} generate={generate}/>}
     <button className="import" disabled={busy} onClick={()=>openFilePicker()}>↑ Drop files or browse<br/><small>FORMA JSON · STEP · OI PROJECT</small></button>
     <button disabled={busy} onClick={()=>openFilePicker(true)}>Import project folder</button>
     {!cleanroomPreview&&<section aria-label="Space brief"><div className="eyebrow">SPACE BRIEF / LOCAL DEMO</div><p>Describe the space. OpenIndustries organizes zones and workflow; Form OSS authors the actual equipment.</p><label>Space type<select aria-label="Space type" value={spaceKey} disabled={busy} onChange={e=>{const key=e.target.value as SpaceBriefKey;setSpaceKey(key);setSpaceRequirements(SPACE_BRIEFS[key].description);}}>{Object.values(SPACE_BRIEFS).map(brief=><option key={brief.key} value={brief.key}>{brief.label}</option>)}</select></label><label>Requirements<textarea aria-label="Space requirements" value={spaceRequirements} maxLength={2000} disabled={busy} onChange={e=>setSpaceRequirements(e.target.value)} /></label><button className="capture-primary" disabled={busy||!spaceRequirements.trim()} onClick={buildDemoSpace}>Build space layout</button><small>Demo output uses clearly marked planning envelopes and includes a simple material-flow animation.</small></section>}
     <details><summary>STEP import settings</summary><label>Source up axis<select value={upAxis} onChange={e=>setUpAxis(e.target.value as 'Z'|'Y')}><option>Z</option><option>Y</option></select></label><label>Scale correction<input type="number" min=".000001" value={scale} onChange={e=>setScale(Number(e.target.value))}/></label></details>
     <section><div className="eyebrow">ROOM / METERS</div><div className="dimensions">{['Width','Depth','Height'].map((name,i)=><label key={name}>{name}<input aria-label={name} type="number" min="1" max="100" step=".5" disabled={busy} value={workspace.room[i]} onChange={e=>{const n=Number(e.target.value);if(n>=1&&n<=100)change({...workspace,room:workspace.room.map((v,j)=>j===i?n:v) as Vec3});}}/></label>)}</div><div className="capture-actions"><button onClick={()=>{setSelected(-1);setSelectedPart(-1);setFocus(n=>n+1);}}>View entire room</button><button disabled={busy} onClick={requestNewRoom}>New room</button></div></section>
    <section><div className="eyebrow">SCENE COLLECTION <span>{workspace.items.length}</span></div>{workspace.items.map((item,i)=><button className={`asset ${selected===i?'active':''}`} key={item.id} onClick={()=>{setSelected(i);setSelectedPart(-1);setFocus(n=>n+1);}}><span>◇ {item.name}{item.missing?' · MISSING GEOMETRY':''}</span><small>{item.asset.source.kind.toUpperCase()} · {item.asset.parts.length} components</small></button>)}</section>
    <div className="capture-actions"><button disabled={busy||!history.past.length} onClick={()=>{setPlaying(false);setTime(null);setHistory(old=>({past:old.past.slice(0,-1),present:old.past.at(-1)!,future:[old.present,...old.future]}));}}>Undo</button><button disabled={busy||!history.future.length} onClick={()=>{setPlaying(false);setTime(null);setHistory(old=>({past:[...old.past,old.present],present:old.future[0],future:old.future.slice(1)}));}}>Redo</button></div>
    {workspace.items.length>0&&<section><div className="eyebrow">LAYOUT / BASE TRANSFORMS</div>{workspace.items.map((item,i)=><fieldset className="placement" key={item.id}><legend>{item.name}</legend><label>Instance name<input aria-label={`${item.name} instance name`} maxLength={200} disabled={busy} value={item.name} onChange={e=>change({...workspace,items:workspace.items.map((v,j)=>i===j?{...v,name:e.target.value}:v)})}/></label>{(['position','rotation'] as const).map(kind=><div className="dimensions" key={kind}>{['X','Y','Z'].map((axis,index)=><label key={axis}>{axis}{kind==='rotation'?'°':''}<input aria-label={`${item.name} ${axis} ${kind}`} type="number" step={kind==='position'?'.1':'5'} disabled={busy} value={item[kind][index]} onChange={e=>{const n=Number(e.target.value);if(Number.isFinite(n)){setPlaying(false);setTime(null);change({...workspace,items:workspace.items.map((v,j)=>i===j?{...v,[kind]:v[kind].map((value,k)=>index===k?n:value) as Vec3}:v)});}}}/></label>)}</div>)}<label className="inline-check"><input type="checkbox" checked={item.visible} disabled={busy} onChange={e=>change({...workspace,items:workspace.items.map((v,j)=>i===j?{...v,visible:e.target.checked}:v)})}/> Visible</label><div className="capture-actions"><button disabled={busy} onClick={()=>change({...workspace,items:workspace.items.map((v,j)=>i===j?{...v,position:[0,0,0],rotation:[0,0,0]}:v)})}>Reset position</button><button disabled={busy} onClick={()=>change({...workspace,items:[...workspace.items,{...item,id:crypto.randomUUID(),name:`${item.name} copy`,position:[item.position[0]+item.asset.dimensions[0]+.25,item.position[1],item.position[2]]}]})}>Duplicate</button><button disabled={busy} onClick={()=>{change({...workspace,items:workspace.items.filter(v=>v.id!==item.id),animation:{...workspace.animation,tracks:workspace.animation.tracks.filter(t=>t.instanceId!==item.id)}});setSelected(-1);setSelectedPart(-1);}}>Delete instance</button></div></fieldset>)}</section>}
    <Timeline workspace={workspace} selected={selected} selectedPart={selectedPart} setPart={setSelectedPart} change={change} time={time} setTime={setTime} playing={playing} setPlaying={setPlaying} disabled={busy}/>
    <SceneControls ref={sceneControls} workspace={workspace} owner={owner} roomId={roomId} current={currentScene} replace={installRoom} flushDraft={flushDraft} getScope={getScope} roomOperation={roomOperation.current} busy={busy} setBusy={setBusy} onExport={exportScene}/>
  </aside>;
  return <><header className="app-header"><div className="brand"><span className="logo">O</span> OPENINDUSTRIES</div><span className="tag">SPATIAL WORKBENCH</span><AuthControls returnTo={linkMode?location.origin+location.pathname+location.search:undefined} beforeSignIn={()=>linkMode?Promise.resolve():preserveAuthWorkspace(assets,workspace.room,selected,workspace.items.map(i=>i.position),workspace)}/><button disabled={busy} onClick={()=>openFilePicker()}>+ Import project</button></header>
    <main onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void load(Array.from(e.dataTransfer.files));}}>
      <div ref={workspaceSlot} style={{display:'contents'}}/>{createPortal(side,workspaceHost)}
      <div ref={stage} className={`stage${expanded?' stage-expanded':''}`}>
        <div className="stage-label"><span className="dot"/> PERSPECTIVE VIEW <span>1:1 / METERS</span></div>
        {isFullscreen&&<button className="workspace-toggle" aria-controls="workspace-panel" aria-expanded={workspaceVisible} onClick={()=>setWorkspaceVisible(v=>!v)}>{workspaceVisible?'Hide workspace':'Show workspace'}</button>}
        <button className="fullscreen-toggle" aria-label={isFullscreen?'Exit fullscreen':'Enter fullscreen'} aria-pressed={isFullscreen} onClick={()=>void toggleFullscreen()}>{isFullscreen?'↙ Exit fullscreen':'⛶ Fullscreen'}</button>
        <button className="capture-launch" aria-expanded={captureOpen} onClick={()=>setCaptureOpen(v=>!v)}>GIF studio</button>
        <WorkspaceViewer workspace={workspace} selected={selected} selectedPart={selectedPart} time={time} focus={focus} region={captureRegion} onSelect={(i,j)=>{setSelected(i);setSelectedPart(j);}}/>
        <CaptureTools key={`${owner}:${roomId}:${roomOperation.current}`} open={captureOpen} assets={assets} room={workspace.room} selected={selected} close={()=>setCaptureOpen(false)} onRegion={setCaptureRegion} addAsset={addAsset} workspace={workspace} time={time} roomOperation={roomOperation.current} onFeedback={sendAnimationFeedback}/>
        <div className="hint">{time!==null?`ANIMATION ${time.toFixed(2)}s · `:''}Drag to orbit · Right-drag to pan · Scroll to zoom</div>
      </div>
      <aside className="inspector"><div className="eyebrow">INSPECTOR</div><ProjectInspector item={workspace.items[selected]} selectedPart={selectedPart} selectPart={index=>{setSelectedPart(index);setFocus(n=>n+1);}}/></aside>
    </main><footer><span role="status">{busy?'◌ ':'● '}{status}</span><span>FORM POWERED · LOCAL + CLOUD</span></footer>
    {adoptionPending&&(isFullscreen&&stage.current?createPortal(<div className="draft-recovery adoption" role="dialog" aria-label="Adopt anonymous draft"><b>Anonymous draft found</b><p>This workspace was created before sign-in. Adopt it into your account, or start a separate clean workspace. The anonymous draft is retained either way.</p><div className="capture-actions"><button onClick={adoptAnonymousDraft}>Adopt draft</button><button onClick={discardAnonymousDraft}>Start clean workspace</button></div></div>,stage.current):<div className="draft-recovery adoption" role="dialog" aria-label="Adopt anonymous draft"><b>Anonymous draft found</b><p>This workspace was created before sign-in. Adopt it into your account, or start a separate clean workspace. The anonymous draft is retained either way.</p><div className="capture-actions"><button onClick={adoptAnonymousDraft}>Adopt draft</button><button onClick={discardAnonymousDraft}>Start clean workspace</button></div></div>)}
    {draftRecovery&&(isFullscreen&&stage.current?createPortal(<div className="draft-recovery" role="alert"><b>Saved workspace needs recovery</b><p>{draftRecovery.message}</p><div className="capture-actions"><button disabled={busy} onClick={()=>{setDraftRecovery(null);setError('');setDraftReady(false);window.location.reload();}}>Retry loading</button><button disabled={busy} onClick={()=>void exportCorruptDraft()}>Download backup</button><button disabled={busy} onClick={()=>void resetCorruptDraft()}>Start clean workspace</button></div></div>,stage.current):<div className="draft-recovery" role="alert"><b>Saved workspace needs recovery</b><p>{draftRecovery.message}</p><div className="capture-actions"><button disabled={busy} onClick={()=>{setDraftRecovery(null);setError('');setDraftReady(false);window.location.reload();}}>Retry loading</button><button disabled={busy} onClick={()=>void exportCorruptDraft()}>Download backup</button><button disabled={busy} onClick={()=>void resetCorruptDraft()}>Start clean workspace</button></div></div>)}
    {error&&(isFullscreen&&stage.current?createPortal(<div className="error" role="alert">{error}<button aria-label="Dismiss error" onClick={()=>setError('')}>×</button></div>,stage.current):<div className="error" role="alert">{error}<button aria-label="Dismiss error" onClick={()=>setError('')}>×</button></div>)}
  </>;
}
createRoot(document.getElementById('root')!).render(<App/>);
