import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { cloudStorageEnabled, connectCloudStorage } from '../lib/cloud-session';
import type { CloudStorage, CloudVersion } from '../lib/cloud-storage';
import type { LibraryEntry } from '../lib/library';
import type { Asset } from '../lib/scene';
import './cloud-library.css';

export function CloudLibrary(props: { entries: LibraryEntry[]; addAsset: (asset: Asset, cloudVersionId?: string) => void; roomOperation?: number }) {
  return cloudStorageEnabled ? <EnabledCloudLibrary {...props} /> : <p className="cloud-disabled">Cloud file storage is disabled. Your device library remains available.</p>;
}

function EnabledCloudLibrary({ entries, addAsset, roomOperation = 0 }: { entries: LibraryEntry[]; addAsset: (asset: Asset, cloudVersionId?: string) => void; roomOperation?: number }) {
  const [owner, setOwner] = useState<string | null>(null);
  const ownerRef = useRef<string | null>(null);
  const roomRef=useRef(roomOperation);roomRef.current=roomOperation;
  const epoch = useRef(0);
  const mounted = useRef(true);
  const lock = useRef(false);
  const [versions, setVersions] = useState<CloudVersion[]>([]);
  const [selected, setSelected] = useState('');
  const [source, setSource] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [download, setDownload] = useState<{ blob: Blob; name: string }>();
  const [url, setUrl] = useState('');
  const selectedEntry = entries.find(entry => entry.id === selected) ?? entries[0];
  useEffect(() => {
    mounted.current = true;
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const next = session?.user.id ?? null;
      if (next === ownerRef.current) return;
      ownerRef.current = next; epoch.current++;
      setOwner(next); setVersions([]); setDownload(undefined); setMessage(''); setError('');
    });
    return () => { mounted.current = false; epoch.current++; data.subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!download) { setUrl(''); return; }
    const next = URL.createObjectURL(download.blob); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [download]);
  const isCurrent = (token: number) => mounted.current && token === epoch.current;
  async function operate(work: (storage: CloudStorage, token: number, roomAtStart: number) => Promise<void>) {
    if (!owner || lock.current) return;
    lock.current = true; const token = epoch.current; const roomAtStart = roomOperation;
    setBusy(true); setError('');
    try { await work(await connectCloudStorage(owner), token, roomAtStart); }
    catch (e) { if (isCurrent(token)) setError((e as Error).message); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function refresh(storage: CloudStorage, token: number) {
    const rows = await storage.list(); if (isCurrent(token)) setVersions(rows);
  }
  useEffect(() => {
    if (!owner) return;
    const token = epoch.current;
    void connectCloudStorage(owner).then(storage => refresh(storage, token)).catch(e => { if (isCurrent(token)) setError(e.message); });
  }, [owner]);

  return <section className="cloud-library" aria-label="Cloud asset storage">
    <div className="eyebrow">CLOUD FILES / OPTIONAL</div>
    {!owner ? <p>Sign in with GitHub to upload or retrieve your private cloud assets. Local files are never uploaded automatically.</p> : <>
      <p>Explicitly upload geometry and its latest GIF preview. Copies are private to your account. Each changed preview creates a new immutable version.</p>
      <label>Local asset to upload<select aria-label="Local asset to upload" disabled={busy || !entries.length} value={selectedEntry?.id ?? ''} onChange={e => { setSelected(e.target.value); setSource(undefined); }}>
        {!entries.length && <option value="">Save an asset to the device library first</option>}
        {entries.map(entry => <option key={entry.id} value={entry.id}>{entry.asset.name}</option>)}
      </select></label>
      {selectedEntry?.asset.source.kind === 'step' && <label>Optional original STEP source<input key={selectedEntry.id} aria-label="Optional original STEP source" type="file" accept=".step,.stp" disabled={busy} onChange={e => setSource(e.target.files?.[0])} /><small>Must match the imported file’s SHA-256. Renderable geometry is always included.</small></label>}
      <div className="capture-actions"><button disabled={busy || !selectedEntry} onClick={() => void operate(async (storage, token) => {
        try {
          await storage.upload(selectedEntry!, text => { if (isCurrent(token)) setMessage(text); }, source);
          if (isCurrent(token)) setMessage('Cloud copy ready. Available to this account on other devices.');
        } finally { await refresh(storage, token); }
      })}>Upload cloud copy</button><button disabled={busy} onClick={() => void operate(async (storage, token) => { await refresh(storage, token); if (isCurrent(token)) setMessage('Cloud list refreshed.'); })}>Refresh cloud list</button></div>
      {!versions.length && <p>No cloud copies yet.</p>}
      {versions.map(version => <article className="cloud-version" aria-label={`Cloud ${version.asset?.name ?? version.asset_id}`} key={version.id}>
        <h3>{version.asset?.name ?? 'Asset'}</h3><p><span className="badge">{version.state.toUpperCase()}</span> · {version.files.length} files · {(version.files.reduce((n, file) => n + file.size, 0) / 1024).toFixed(0)} KB<br />{new Date(version.created_at).toLocaleString()}<br /><small>Version {version.id.slice(0, 8)}</small></p>
        {version.state === 'pending' && <p>Incomplete upload. Select the same local asset/preview and upload again to resume, or remove this copy to clean up.</p>}
        {version.state === 'deleting' && <p>Removal is incomplete. Retry removal to delete remaining objects and metadata.</p>}
        <div className="capture-actions">
          <button disabled={busy || version.state !== 'ready'} onClick={() => void operate(async (storage, token, roomAtStart) => {
            setMessage('Downloading and verifying geometry…');
            const entry = await storage.load(version);
            if (!isCurrent(token)) return;
            if(roomAtStart!==roomRef.current) throw new Error('Room changed while loading this asset. Open Cloud files again to add it to the active room.');
            addAsset(entry.asset, version.id);
            setDownload(entry.preview ? { blob: entry.preview, name: `${version.id}-preview.gif` } : undefined);
            setMessage('Verified cloud asset loaded into the room.');
          })}>Load cloud asset into room</button>
          {version.files.some(file => file.name === 'preview.gif') && <button disabled={busy || version.state !== 'ready'} onClick={() => void operate(async (storage, token) => {
            const blob = await storage.downloadFile(version, 'preview.gif');
            if (isCurrent(token)) { setDownload({ blob, name: `${version.id}-preview.gif` }); setMessage('GIF verified and ready to download.'); }
          })}>Get cloud GIF</button>}
          {version.files.some(file => file.name === 'source.step') && <button disabled={busy || version.state !== 'ready'} onClick={() => void operate(async (storage, token) => {
            const blob = await storage.downloadFile(version, 'source.step');
            if (isCurrent(token)) { setDownload({ blob, name: `${version.id}-source.step` }); setMessage('STEP source verified and ready to download.'); }
          })}>Get STEP source</button>}
          <button disabled={busy} onClick={() => void operate(async (storage, token) => {
            try { await storage.remove(version); if (isCurrent(token)) { setDownload(undefined); setMessage('Cloud files removed. Local assets and core metadata remain.'); } }
            finally { await refresh(storage, token); }
          })}>{version.state === 'deleting' ? 'Retry removal' : 'Remove cloud copy'}</button>
        </div>
      </article>)}
    </>}
    <p role="status" aria-label="Cloud storage status">{busy ? 'Working… ' : ''}{message}</p>
    {error && <p role="alert" className="capture-error">{error}</p>}
    {url && download && owner && <div className="cloud-download">{download.blob.type === 'image/gif' && <img alt="Verified cloud GIF preview" src={url} />}<a href={url} download={download.name}>Download verified file</a></div>}
  </section>;
}
