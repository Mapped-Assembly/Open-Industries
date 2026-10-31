import { useEffect, useRef, useState } from 'react';
import type { Asset } from '../lib/scene';
import { loadRobotAssets, runWorkspace, type RunSnapshot } from '../lib/embodied-scene';
import { WorkspaceViewer } from './workspace-viewer';
import './embodied-workbench.css';

type RequestBody={task_id:string|null;request_id:string;run_id:string;action:string;text:string;selected_id:string|null;scene_revision:number};
/** A pinned Run workspace: displayed poses come exclusively from the local controller. */
export function EmbodiedWorkbench() {
  const [run,setRun]=useState<RunSnapshot|null>(null),[assets,setAssets]=useState<Record<string,Asset>|null>(null);
  const [selected,setSelected]=useState<string|null>(null),[text,setText]=useState(''),[error,setError]=useState('');
  const [connected,setConnected]=useState(true),[stale,setStale]=useState(true),[sending,setSending]=useState(false);
  const pending=useRef<RequestBody|null>(null),last=useRef(0),generation=useRef(0);
  const [focus,setFocus]=useState(0);
  const [objectX,setObjectX]=useState('.15'),[objectY,setObjectY]=useState('-.05');
  useEffect(()=>{let cancelled=false;loadRobotAssets().then(value=>{if(!cancelled)setAssets(value);}).catch(e=>{if(!cancelled)setError(String(e));});return()=>{cancelled=true;};},[]);
  useEffect(()=>{
    const epoch=++generation.current;last.current=0;setStale(true);
    if(!connected)return;
    let stopped=false,inFlight=false;
    const refresh=async()=>{
      if(inFlight)return;inFlight=true;
      try {
        const response=await fetch('/api/embodied/run',{signal:AbortSignal.timeout(3000)});
        if(!response.ok)throw Error('Station unavailable. Start the local embodied launcher and reconnect.');
        const value:RunSnapshot=await response.json();
        if(!stopped&&epoch===generation.current&&value.revision>=last.current){last.current=value.revision;setRun(value);setStale(!value.healthy);}
      } catch(e){if(!stopped){setStale(true);setError(String(e));}} finally {inFlight=false;}
    };
    void refresh();const timer=setInterval(()=>void refresh(),200);
    return()=>{stopped=true;clearInterval(timer);};
  },[connected]);
  async function send(action:string, retry=false) {
    if(!run)return;
    // Stop remains callable while a chat POST is unresolved. Its request is independent.
    const body=retry?pending.current:{task_id:run.task?.id??null,request_id:crypto.randomUUID(),run_id:run.run_id,action,text:action==='chat'?text:action==='edit_object'?JSON.stringify([Number(objectX),Number(objectY),.015]):'',selected_id:selected,scene_revision:run.scene_revision};
    if(!body)return;
    if(action==='chat')pending.current=body;
    setSending(true);setError('');
    try {
      const response=await fetch('/api/embodied/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
      const result=await response.json();
      if(!response.ok){if(action==='chat')pending.current=null;throw Error(result.error||'Request rejected');}
      if(action==='chat'){pending.current=null;setText('');}
    } catch(e){setError(String(e));} finally {setSending(false);}
  }
  const workspace=run&&assets?runWorkspace(run,assets):null;
  const index=workspace?.items.findIndex(item=>item.id===selected)??-1;
  const active=run?.task&&['planning','running','paused'].includes(run.task.stage);
  return <div className="embodied-shell">
    <header><div><b>OpenIndustries / SO-101 tabletop</b><p>Simulated kinematics · no grasp, contact or physical validation</p></div><a href="/">Return to scene editor</a></header>
    <nav aria-label="Run controls">
      <button disabled={stale||!assets||!!active} onClick={()=>void send(run?.mode==='run'?'edit':'run')}>{run?.mode==='run'?'Leave Run mode':'Enter Run mode'}</button>
      <button onClick={()=>{setConnected(v=>!v);setError('');}}>{connected?'Disconnect viewer':'Reconnect'}</button>
      <button className="stop" disabled={!run||!connected} onClick={()=>void send('stop')}>Stop</button>
      <button disabled={stale||run?.task?.stage!=='paused'} onClick={()=>void send('resume')}>Resume</button>
      <button disabled={stale||!active} onClick={()=>void send('cancel')}>Cancel task</button>
      <button disabled={stale} onClick={()=>void send('status')}>What are you doing?</button>
      <span role="status">{stale?'Disconnected / stale — last pose held':`${run?.mode.toUpperCase()} · ${run?.task?.stage??'idle'}`}</span>
    </nav>
    <main><section className="embodied-view">{workspace?<WorkspaceViewer workspace={workspace} selected={index} selectedPart={-1} time={null} focus={focus} focusSelection={false} overview={{position:[.65,.5,.7],target:[.12,.1,0]}} region={null} onSelect={i=>{const id=workspace.items[i]?.id;setSelected(run!.objects.some(o=>o.id===id)?id:null);setFocus(v=>v+1);}}/>:<p>Loading pinned model…</p>}</section>
    <aside><h1>Robot chat</h1><p>SO-101 follower · {run?.policy_mode==='model'?'Configured model':'Manual test mode — no natural-language model connected'}</p>
      <label>Selected object <select value={selected??''} onChange={e=>setSelected(e.target.value||null)}><option value="">None</option>{run?.objects.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select></label>
      {run?.mode==='edit'&&<fieldset><legend>Explicit fixture edit (metres)</legend><label>X <input aria-label="Object X" type="number" step=".01" min=".05" max=".35" value={objectX} onChange={e=>setObjectX(e.target.value)}/></label><label>Y <input aria-label="Object Y" type="number" step=".01" min="-.15" max=".15" value={objectY} onChange={e=>setObjectY(e.target.value)}/></label><button disabled={!selected||stale} onClick={()=>void send('edit_object')}>Save object position</button></fieldset>}
      <p>Available: approach a block, inspect simulated state, return home. Objects remain stationary.</p>
      <div className="embodied-chat" aria-label="Conversation" aria-live="polite">{run?.messages.map(m=><p key={m.id}><b>{m.role==='user'?'You':'Agent'}</b> {m.text}</p>)}</div>
      <form onSubmit={e=>{e.preventDefault();void send('chat');}}><label htmlFor="robot-chat">Task</label><textarea id="robot-chat" value={text} maxLength={2000} onChange={e=>setText(e.target.value)} placeholder={run?.policy_mode==='model'?'Move the gripper above the selected block.':'approach selected'}/><button disabled={stale||!assets||sending||!!active||run?.mode!=='run'||!text.trim()}>Send</button></form>
      {pending.current&&<button onClick={()=>void send('chat',true)}>Retry same request</button>}
      {error&&<p role="alert">{error}</p>}
      <progress max={1} value={run?.task?.progress??0}/><p>{run?.task?.skill??'No skill dispatched'} · {Math.round((run?.task?.progress??0)*100)}%</p>
      <button disabled={!run} onClick={()=>{if(!run)return;const url=URL.createObjectURL(new Blob([JSON.stringify(run,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`${run.run_id}-trace.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>Export trace</button>
      <details><summary>Run and evidence</summary><pre>{JSON.stringify({run:run?.run_id,scene:run?.scene_id,scene_revision:run?.scene_revision,revision:run?.revision,task:run?.task,observations:run?.observations.map(o=>({id:o.id,kind:o.kind,task_id:o.task_id})),model:run?.robot.model_sha256},null,2)}</pre></details>
    </aside></main>
  </div>;
}
