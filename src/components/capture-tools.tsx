import { useEffect, useMemo, useRef, useState } from 'react';
import type { Asset } from '../lib/scene';
import { renderGif, type FloorRegion, type GifOptions, type GifResult } from '../lib/gif';
import { deleteLibrary, listLibrary, saveLibrary, type LibraryEntry } from '../lib/library';
import { CloudLibrary } from './cloud-library';
import type { Workspace } from '../lib/workspace';
import './capture-tools.css';

function useBlobUrl(blob?: Blob) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) { setUrl(''); return; }
    const next = URL.createObjectURL(blob); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}
function LibraryCard({ entry, disabled, render, add, remove }: {
  entry: LibraryEntry; disabled: boolean; render: (motion: GifOptions['motion']) => void; add: () => void; remove: () => void;
}) {
  const url = useBlobUrl(entry.preview);
  const metadataBlob = useMemo(() => entry.previewMetadata ? new Blob([JSON.stringify(entry.previewMetadata, null, 2)], { type: 'application/json' }) : undefined, [entry.previewMetadata]);
  const metadataUrl = useBlobUrl(metadataBlob);
  return <article className="library-card" aria-label={entry.asset.name}>
    {url ? <img src={url} alt={`${entry.asset.name} ${entry.previewMetadata?.motion ?? ''} GIF preview`} /> : <div className="preview-placeholder">◇<small>No preview yet</small></div>}
    <h3>{entry.asset.name}</h3><p>{entry.asset.source.kind.toUpperCase()} · {entry.asset.parts.length} parts<br />{entry.asset.dimensions.map(n => n.toFixed(3)).join(' × ')} m</p>
    {entry.previewMetadata && <p>{entry.previewMetadata.motion === 'sample' ? 'Synthetic lift-and-return' : 'Turntable'} · {entry.previewMetadata.frameCount} frames</p>}
    <div className="capture-actions"><button disabled={disabled} onClick={() => render('turntable')}>Render turntable</button><button disabled={disabled} onClick={() => render('sample')}>Render sample motion</button><button disabled={disabled} onClick={add}>Add to room</button>{url && <a href={url} download={`${entry.asset.name.replace(/[^a-z0-9_-]+/gi, '-')}-preview.gif`}>Download preview</a>}{metadataUrl && <a href={metadataUrl} download="asset-preview-metadata.json">Preview metadata</a>}<button disabled={disabled} onClick={remove}>Remove from library</button></div>
  </article>;
}

export function CaptureTools({ open, assets, room, selected, close, addAsset, onRegion, workspace, time, roomOperation, onFeedback }: {
  open: boolean; assets: Asset[]; room: number[]; selected: number; close: () => void;
  addAsset: (asset: Asset, cloudVersionId?: string) => void; onRegion: (region: FloorRegion | null) => void;
  workspace?: Workspace; time?: number | null; roomOperation?: number; onFeedback?: (review: GifResult['metadata'], instruction: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<'export' | 'library'>('export');
  const [scope, setScope] = useState<GifOptions['scope']>('room');
  const [motion, setMotion] = useState<GifOptions['motion']>('turntable');
  const [size, setSize] = useState(480);
  const [duration, setDuration] = useState(3);
  const [fps, setFps] = useState(10);
  const [rangeStart,setRangeStart]=useState(0);
  const [rangeEnd,setRangeEnd]=useState(2);
  useEffect(()=>{setRangeEnd(Math.min(3,workspace?.animation.duration??3));setRangeStart(0);},[workspace?.animation.duration]);
  const [region, setRegion] = useState<FloorRegion>({ x: 0, z: 0, width: 2, depth: 2 });
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<GifResult>();
  const [feedback, setFeedback] = useState('');
  const [metadataBlob, setMetadataBlob] = useState<Blob>();
  const controller = useRef<AbortController | null>(null);
  const resultUrl = useBlobUrl(result?.blob);
  const metadataUrl = useBlobUrl(metadataBlob);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void listLibrary().then(items => { if (active) setEntries(items); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [open]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (!open) controller.current?.abort(); }, [open]);
  useEffect(() => {
    onRegion(open && tab === 'export' && scope === 'section' ? region : null);
    return () => onRegion(null);
  }, [open, tab, scope, region, onRegion]);

  async function saveSelected() {
    const asset = assets[selected]; if (!asset) return;
    setBusy(true); setError('');
    try {
      const existing = entries.find(e => e.id === asset.id);
      const entry: LibraryEntry = { ...existing, id: asset.id, asset, updatedAt: Date.now() };
      await saveLibrary(entry);
      setEntries(old => [entry, ...old.filter(e => e.id !== entry.id)]);
      setMessage(`Saved ${asset.name} to this browser's library.`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove(entry: LibraryEntry) {
    setBusy(true); setError('');
    try { await deleteLibrary(entry.id); setEntries(old => old.filter(item => item.id !== entry.id)); setMessage(`Removed ${entry.asset.name} from the library. Room instances are unchanged.`); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function capture(entry?: LibraryEntry, preset?: GifOptions['motion']) {
    if (controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setProgress(0); setMessage('Rendering frames…'); setError('');
    try {
      const output = await renderGif(entry ? [entry.asset] : assets, room, {
        scope: entry ? 'asset' : scope, assetIndex: entry ? 0 : selected,
        motion: preset ?? motion, region, size, duration, fps, rangeStart, rangeEnd, snapshotTime:time,
      }, abort.signal, setProgress, entry ? undefined : workspace);
      setResult(output); setMetadataBlob(new Blob([JSON.stringify(output.metadata, null, 2)], { type: 'application/json' }));
      if (entry) {
        const updated: LibraryEntry = { ...entry, preview: output.blob, previewMetadata: output.metadata, updatedAt: Date.now() };
        await saveLibrary(updated);
        setEntries(old => [updated, ...old.filter(item => item.id !== entry.id)]);
      }
      setMessage(`GIF ready · ${output.metadata.frameCount} frames · ${(output.blob.size / 1024).toFixed(0)} KB${entry ? ' · preview saved' : ''}`);
    } catch (e) {
      if (abort.signal.aborted) setMessage('Export cancelled. Your scene is unchanged.');
      else { setMessage('Export did not complete.'); setError((e as Error).message); }
    } finally { setBusy(false); controller.current = null; }
  }
  async function sendFeedback() {
    if (!result || !onFeedback || !feedback.trim()) return;
    setBusy(true); setError('');
    try { await onFeedback(result.metadata, feedback); setMessage('Animation feedback sent to Form.'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!open) return null;
  return <section className="capture-panel" aria-label="GIF studio">
    <div className="capture-heading"><div><div className="eyebrow">VISUAL REVIEW</div><h2>GIF studio</h2></div><button aria-label="Close GIF studio" onClick={() => { controller.current?.abort(); close(); }}>×</button></div>
    <div className="capture-tabs"><button aria-pressed={tab === 'export'} onClick={() => setTab('export')}>Floor export</button><button aria-pressed={tab === 'library'} onClick={() => setTab('library')}>Asset library ({entries.length})</button></div>
    <div className="capture-settings">
      <label>GIF resolution<select value={size} disabled={busy} onChange={e => setSize(Number(e.target.value))}>{[320, 480, 640].map(value => <option key={value} value={value}>{value} × {value}</option>)}</select></label>
      <label>Duration<select value={duration} disabled={busy} onChange={e => setDuration(Number(e.target.value))}>{[2, 3, 4].map(value => <option key={value} value={value}>{value} seconds</option>)}</select></label>
      <label>Frame rate<select value={fps} disabled={busy} onChange={e => setFps(Number(e.target.value))}><option value={10}>10 fps</option><option value={15}>15 fps</option></select></label>
    </div>
    {tab === 'export' ? <>
      <p>Capture geometry for positioning review. Exporting uses a separate camera and leaves your room unchanged.</p>
      <label>Export scope<select disabled={busy} value={scope} onChange={e => {setScope(e.target.value as GifOptions['scope']);if(motion==='sample')setMotion('turntable');}}><option value="room">Entire room</option><option value="section">Floor section</option><option value="asset">Selected asset</option></select></label>
      <label>Preview motion<select disabled={busy} value={motion} onChange={e=>setMotion(e.target.value as GifOptions['motion'])}><option value="turntable">Turntable camera orbit</option>{scope==='asset'&&<option value="sample">Sample lift-and-return</option>}<option value="animation">Authored timeline animation</option></select></label>
      {motion==='animation'&&<><p>Export up to 4 seconds of the authored timeline with a fixed camera.</p><div className="dimensions"><label>Range start<input aria-label="Animation export start" type="number" min="0" step=".1" value={rangeStart} onChange={e=>setRangeStart(Number(e.target.value))}/></label><label>Range end<input aria-label="Animation export end" type="number" min="0" step=".1" value={rangeEnd} onChange={e=>setRangeEnd(Number(e.target.value))}/></label></div></>}
      {scope === 'section' && <><p>The highlighted box is the export region. Coordinates are in meters from the room center; X is width, Z is depth. Geometry outside the box is clipped.</p><div className="region-fields">{(['x', 'z', 'width', 'depth'] as const).map(key => <label key={key}>{({ x: 'Section center X', z: 'Section center Z', width: 'Section width', depth: 'Section depth' })[key]}<input type="number" step="0.1" disabled={busy} value={Number.isFinite(region[key]) ? region[key] : ''} onChange={e => setRegion(old => ({ ...old, [key]: e.target.value === '' ? NaN : Number(e.target.value) }))} /></label>)}</div></>}
      {scope === 'asset' && <p>{assets[selected] ? `Selected: ${assets[selected].name}` : 'Select an asset in the workspace first.'}</p>}
      {scope === 'asset' && motion === 'sample' && <p className="notice">Synthetic demonstration motion, not a physical simulation or an authored animation track.</p>}
      <button className="capture-primary" disabled={busy || !assets.length || (scope === 'asset' && !assets[selected])} onClick={() => void capture()}>Render GIF</button>
      {!assets.length && <p>Import a Form project or STEP file to get started.</p>}
    </> : <>
      <p>Save imported objects and their animated previews on this device. Reuse them after refreshing; clearing browser storage removes this library.</p>
      <button disabled={busy || !assets[selected]} onClick={() => void saveSelected()}>Save selected asset to library</button>
      <p>{assets[selected] ? `Selected: ${assets[selected].name}` : 'Select a room asset to save it.'}</p>
      {!entries.length && <p>Your library is empty. Import an object, select it, and save it here.</p>}
      {entries.map(entry => <LibraryCard key={entry.id} entry={entry} disabled={busy} render={preset => void capture(entry, preset)} add={() => { addAsset(entry.asset); setMessage(`Added ${entry.asset.name} to the room.`); }} remove={() => void remove(entry)} />)}
      <CloudLibrary entries={entries} addAsset={addAsset} roomOperation={roomOperation} />
    </>}
    {busy && controller.current && <div className="capture-progress"><progress aria-label="GIF export progress" value={progress} max={1} /><button onClick={() => controller.current?.abort()}>Cancel export</button></div>}
    <p role="status" aria-label="GIF export status">{message}</p>
    {error && <p className="capture-error" role="alert">{error}</p>}
    {resultUrl && result && <div className="capture-result"><img src={resultUrl} alt="Rendered GIF preview" /><p>{result.filename}<br />{result.metadata.durationSeconds.toFixed(2)} seconds · {result.metadata.animation?.loop === false ? 'plays once' : 'loops continuously'}</p><div className="capture-actions"><a href={resultUrl} download={result.filename}>Download GIF</a><a href={metadataUrl} download={result.filename.replace(/\.gif$/, '.json')}>Download review metadata</a></div>{result.metadata.motion === 'animation' && onFeedback && <div className="feedback-box"><label>Feedback for Form<textarea aria-label="Animation feedback" value={feedback} maxLength={4000} placeholder="Example: raise the display assembly during the final lift so it clears the enclosure." onChange={e => setFeedback(e.target.value)} /></label><button disabled={busy || !feedback.trim()} onClick={() => void sendFeedback()}>Send feedback to Form</button><small>The review is saved locally and consumed by the Form/OpenCode loop. It does not change the room automatically.</small></div>}</div>}
  </section>;
}
