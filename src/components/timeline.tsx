import { useMemo, useState } from 'react';
import { evaluateWorkspace, writeKeyframe, zeroPose, type Pose, type Workspace } from '../lib/workspace';
import type { Vec3 } from '../lib/scene';

type KeyDraft = Pose & { visible?: boolean };

export function Timeline({ workspace, selected, selectedPart, setPart, change, time, setTime, playing, setPlaying, disabled }: {
  workspace: Workspace; selected: number; selectedPart: number; setPart: (part: number) => void; change: (value: Workspace) => void;
  time: number | null; setTime: (time: number | null) => void; playing: boolean; setPlaying: (playing: boolean) => void; disabled: boolean;
}) {
  const item = workspace.items[selected]; const part = item?.asset.parts[selectedPart];
  const track = workspace.animation.tracks.find(t => t.instanceId === item?.id && t.partId === part?.id);
  const sampled = useMemo<KeyDraft>(() => {
    const pose = evaluateWorkspace(workspace.items,workspace.animation,time)[selected];
    return part ? pose?.parts[part.id] ?? zeroPose() : pose ?? zeroPose();
  }, [workspace,selected,part?.id,time]);
  // Keep only uncommitted edits in state. Playback samples must not schedule a
  // second state update on every animation frame, and target/time changes reset edits.
  const [edit,setEdit] = useState<{ sampled: KeyDraft; value: KeyDraft }>();
  const draft = edit?.sampled === sampled ? edit.value : sampled;
  const setDraft = (update: (old: KeyDraft) => KeyDraft) => setEdit(old => ({sampled,value:update(old?.sampled === sampled ? old.value : sampled)}));
  function seek(n: number) { setPlaying(false); setTime(Math.min(workspace.animation.duration,Math.max(0,n))); }
  return <section className="timeline" aria-label="Animation timeline">
    <div className="eyebrow">ANIMATION / KEYFRAMES</div>
    <p>Authored motion is separate from the base layout. Select an instance or component, choose a time, set its pose or visibility, and add a keyframe.</p>
    <div className="capture-actions"><button disabled={disabled || !workspace.items.length} onClick={() => { if (time === null || time >= workspace.animation.duration) setTime(0); setPlaying(!playing); }}>{playing ? 'Pause animation' : 'Play animation'}</button><button onClick={() => { setPlaying(false); setTime(null); }}>Reset to base layout</button></div>
    <label>Timeline time<input aria-label="Timeline time" type="range" min="0" max={workspace.animation.duration} step=".01" value={time ?? 0} onChange={e => seek(Number(e.target.value))} disabled={disabled} /></label>
    <div className="dimensions"><label>Time (s)<input aria-label="Keyframe time" type="number" min="0" max={workspace.animation.duration} step=".1" value={Number((time ?? 0).toFixed(2))} disabled={disabled} onChange={e => { if (e.target.value !== '') seek(Number(e.target.value)); }} /></label><label>Duration (s)<input aria-label="Animation duration" type="number" min=".5" max="120" step=".5" disabled={disabled} value={workspace.animation.duration} onChange={e => { const n=Number(e.target.value); const last=Math.max(0,...workspace.animation.tracks.flatMap(t=>t.keys.map(k=>k.time))); if (n>=.5 && n<=120 && n>=last) { setPlaying(false); change({...workspace,animation:{...workspace.animation,duration:n}}); } }} /></label></div>
    <label className="inline-check"><input type="checkbox" checked={workspace.animation.loop} disabled={disabled} onChange={e=>change({...workspace,animation:{...workspace.animation,loop:e.target.checked}})} /> Loop playback</label>
    {item ? <>
      <p><b>{item.name}</b> · {time === null ? 'Base layout' : `Preview ${time.toFixed(2)}s`}</p>
      <label>Animation target<select aria-label="Animation target" value={selectedPart} disabled={disabled} onChange={e=>setPart(Number(e.target.value))}><option value={-1}>Whole instance</option>{item.asset.parts.map((p,i)=><option key={p.id} value={i}>{p.name}</option>)}</select></label>
      <small>{part ? 'Component offsets (meters) and rotations about its center.' : 'Absolute instance position (meters) and XYZ rotation (degrees).'}</small>
      {(['position','rotation'] as const).map(kind=><div className="dimensions" key={kind}>{['X','Y','Z'].map((axis,index)=><label key={axis}>{kind} {axis}<input aria-label={`Keyframe ${kind} ${axis}`} disabled={disabled || playing} type="number" step={kind==='position'?'.1':'5'} value={Number(draft[kind][index].toFixed(4))} onChange={e=>{const n=Number(e.target.value); if(Number.isFinite(n)) setDraft(old=>({...old,[kind]:old[kind].map((v,i)=>i===index?n:v) as Vec3}));}} /></label>)}</div>)}
      {!part && <><label className="inline-check"><input aria-label="Keyframe visible" type="checkbox" checked={draft.visible ?? item.visible} disabled={disabled || playing || item.missing} onChange={e=>setDraft(old=>({...old,visible:e.target.checked}))} /> Visible at this keyframe</label><small>Visibility changes at the keyframe and holds until the next visibility key. Reset restores the base layout.</small></>}
      <button disabled={disabled || playing || item.missing} onClick={()=>{const t=time??0; change({...workspace,animation:writeKeyframe(workspace.animation,item.id,part?.id,{id:crypto.randomUUID(),time:t,position:[...draft.position],rotation:[...draft.rotation],...(!part ? {visible:draft.visible ?? item.visible} : {})})}); setTime(t);}}>Add / update keyframe</button>
      {track?.keys.map(key=><div className="keyframe" key={key.id}><button onClick={()=>seek(key.time)}>{key.time.toFixed(2)}s · {key.position.map(n=>n.toFixed(1)).join(', ')}{key.visible !== undefined && ` · ${key.visible ? 'visible' : 'hidden'}`}</button><button aria-label={`Delete keyframe at ${key.time} seconds`} disabled={disabled} onClick={()=>change({...workspace,animation:{...workspace.animation,tracks:workspace.animation.tracks.map(t=>t.id===track.id?{...t,keys:t.keys.filter(k=>k.id!==key.id)}:t).filter(t=>t.keys.length)}})}>×</button></div>)}
      {!track && <p>No keyframes for this target yet.</p>}
    </> : <p>Select an instance to author its animation.</p>}
  </section>;
}
