import * as THREE from 'three';
import { createWorld, applyWorldPoses } from '../../src/lib/world';
import { loadLabRecording, labFramePoses, hashText, type LoadedLab } from '../../src/lib/field-lab-playback';

const el = (id: string) => document.getElementById(id)!;
let loaded: LoadedLab | null = null, world: ReturnType<typeof createWorld> | null = null;
let index = 0, connected = false, playing = false, busy = false;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(960, 650); el('view').append(renderer.domElement);
const camera = new THREE.PerspectiveCamera(36, 960 / 650, .01, 120);
camera.position.set(12, 13, 17); camera.lookAt(0, .3, 0);
const slider = el('timeline') as HTMLInputElement;
const select = el('selection') as HTMLSelectElement;

/** Download exactly the current evidence, with no runtime side effects. */
function download(name: string, blob: Blob): void {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
/** Display one recorded event; time never advances independently of the journal. */
function draw(): void {
  if (!loaded || !world) return;
  const { poses, job, frame } = labFramePoses(loaded, index);
  applyWorldPoses(world.groups, poses); renderer.render(world.scene, camera);
  slider.max = String(loaded.recording.frames.length - 1); slider.value = String(index);
  el('cursor').textContent = `${index + 1}/${loaded.recording.frames.length} · ${(frame.snapshot.simulation_time_ms-frame.snapshot.origin_ms)/60000} modeled minutes`;
  el('finding').textContent = loaded.finding;
  const relevant = ['pipette', 'instruments'].includes(select.value);
  el('selection-state').textContent = relevant
    ? `${job?.id ?? 'No started job'} · ${job?.state ?? 'idle'} · ${job?.reason ?? 'no blocking reason'} · ${job?.progress_ms ?? 0}/900000 ms paid work`
    : 'Static scene occurrence; no articulated job motion is bound here.';
  el('details').textContent = JSON.stringify({ occurrence: select.value, event: frame.id, action: frame.action,
    job: relevant ? job : null,
    waiting: relevant ? frame.snapshot.jobs.filter(j => j.state === 'waiting-for-resource').map(j => ({ id: j.id, reason: j.reason })) : [],
    scene_sha256: loaded.scene_sha256, source_revision: loaded.recording.source_revision,
    opencad_revision: loaded.motion?.opencad_revision ?? 'unvalidated', history_scope: loaded.recording.history_scope,
    mechanics: loaded.motion?.checks ?? null }, null, 2);
  for (const action of ['pause', 'resume', 'fail']) (el(action) as HTMLButtonElement).disabled = !connected || !job
    || (action === 'resume' ? job.state !== 'paused' : job.state !== 'running');
  loaded.recording.cursor = index;
  (window as any).labState = { index, job, event_id: frame.id, poses, finding: loaded.finding };
}
/** Replace replay state only after validating the complete source and timeline. */
async function accept(value: unknown): Promise<void> {
  const next = await loadLabRecording(value);
  if (!loaded || loaded.scene_sha256 !== next.scene_sha256) {
    world?.dispose(); world = createWorld(next.workspace.items.map(i => i.asset), next.workspace.room);
    world.scene.background = new THREE.Color('#e6e9e2');
    select.replaceChildren(...next.workspace.items.map(i => { const o = document.createElement('option'); o.value = i.id; o.textContent = i.name; return o; }));
    select.value = 'pipette';
  }
  loaded = next; index = next.recording.cursor; draw();
}
/** Poll a local authenticated-backend projection; disconnects preserve the last observed frame. */
async function refresh(): Promise<void> {
  if (!connected || busy) return;
  busy = true;
  try {
    const response = await fetch('/lab-recording');
    if (!response.ok) throw Error(`Station unavailable (${response.status})`);
    const value = await response.json();
    if (connected) { await accept(value); el('status').textContent = 'Connected · authoritative recorded state'; }
  } catch (error) { connected = false; el('status').textContent = `Disconnected / stale · ${String(error)}`; draw(); }
  finally { busy = false; }
}
el('connect').onclick = () => { connected = true; playing = false; void refresh(); };
el('disconnect').onclick = () => { connected = false; el('status').textContent = 'Disconnected · last recorded state held; server work continues'; draw(); };
el('import').onchange = async event => {
  connected = false; playing = false;
  try { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
    if (file.size > 40 * 1024 * 1024) throw Error('Recording exceeds 40 MiB');
    await accept(JSON.parse(await file.text())); el('status').textContent = 'Imported recording · offline replay';
  } catch (error) { el('status').textContent = String(error); }
};
el('export').onclick = () => { if (loaded) download('field-lab-recording.json', new Blob([JSON.stringify(loaded.recording)], { type: 'application/json' })); };
el('screenshot').onclick = async () => {
  if (!loaded) return;
  const metadata = { source_revision: loaded.recording.source_revision, scene_sha256: loaded.scene_sha256,
    motion_sha256: await hashText(loaded.recording.motion_json), event: loaded.recording.frames[index].id,
    cursor: index, finding: loaded.finding, opencad_revision: loaded.motion?.opencad_revision };
  // Visible caption carries the exact source, even if the companion JSON is separated.
  const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 760;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#eef0ec'; ctx.fillRect(0,0,960,760);
  ctx.drawImage(renderer.domElement,0,0); ctx.fillStyle = '#203d3c'; ctx.font = '12px monospace';
  [metadata.source_revision, `scene SHA-256 ${metadata.scene_sha256}`, `event ${metadata.event}`, metadata.finding].forEach((s,i) => ctx.fillText(s,12,675+i*21));
  canvas.toBlob(blob => { if (blob) download('field-lab-runtime.png',blob); });
  download('field-lab-runtime-evidence.json', new Blob([JSON.stringify(metadata,null,2)], { type:'application/json' }));
};
slider.oninput = () => { connected = false; playing = false; index = Number(slider.value); el('status').textContent = 'Recorded event playback'; draw(); };
select.onchange = draw;
const raycaster = new THREE.Raycaster();
renderer.domElement.onclick = event => {
  if (!world || !loaded) return;
  const box = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((event.clientX-box.left)/box.width*2-1, 1-(event.clientY-box.top)/box.height*2),camera);
  const hit = raycaster.intersectObjects(world.groups,true)[0];
  if (hit) { let object: THREE.Object3D = hit.object; while (object.parent && !world.groups.includes(object as THREE.Group)) object=object.parent;
    const i=world.groups.indexOf(object as THREE.Group); if(i>=0){select.value=loaded.workspace.items[i].id;draw();} }
};
el('play').onclick = () => { connected = false; playing = !playing; el('status').textContent = 'Recorded events · 4 events/sec, held samples'; };
for (const action of ['pause', 'resume', 'fail']) el(action).onclick = async () => {
  if (!loaded || !connected) return;
  const { job, frame } = labFramePoses(loaded,index); if (!job) return;
  try {
    const response = await fetch('/lab-control', { method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({command_id: crypto.randomUUID(), expected_revision: frame.snapshot.revision, action, payload: {job_id: job.id}}) });
    if (!response.ok) throw Error('Command not confirmed; reconnect and inspect before retrying');
    await refresh();
  } catch(error){el('status').textContent=String(error);}
};
setInterval(() => { if (playing && loaded) { index=Math.min(index+1,loaded.recording.frames.length-1);draw();if(index===loaded.recording.frames.length-1)playing=false; } },250);
setInterval(() => void refresh(),2000);
(window as any).loadLabRecording = accept;
(window as any).showLabEvent = (i: number) => { connected=false;index=i;draw(); };
(window as any).ready = true;

el('overview').onclick = () => { camera.position.set(12,13,17);camera.lookAt(0,.3,0);draw(); };
el('focus').onclick = () => {
  if (!loaded || !world) return;
  const i=loaded.workspace.items.findIndex(item=>item.id===select.value);
  if(i<0)return;
  const bounds=new THREE.Box3().setFromObject(world.groups[i]), center=bounds.getCenter(new THREE.Vector3());
  const distance=Math.max(.5,bounds.getSize(new THREE.Vector3()).length());
  camera.position.copy(center).add(new THREE.Vector3(distance*.9,distance*.7,distance));camera.lookAt(center);draw();
};
