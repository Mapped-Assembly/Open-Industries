import { useEffect, useRef, useState } from 'react';
import { connectUserClient, cloudStorageEnabled } from '../lib/cloud-session';
import { SceneRepository, type SavedScene } from '../lib/scene-repository';
import { describeRevision, type SceneHistoryPage, type RevisionComparison } from '../lib/scene-history';
import { sceneURLs } from '../lib/scene-links';
import './scene-history.css';

export function SceneHistory({ scene, owner, busy, restore }: {
  scene: SavedScene; owner: string; busy: boolean; restore: (revision: number, baseRevision: number) => void;
}) {
  const [open, setOpen] = useState(false), [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<SceneHistoryPage | null>(null);
  const [from, setFrom] = useState(0), [to, setTo] = useState(0);
  const [comparison, setComparison] = useState<RevisionComparison | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current;
    setPage(null); setComparison(null); setError('');
    if (!open) return;
    setLoading(true);
    void connectUserClient(owner).then(client => new SceneRepository(client, owner, cloudStorageEnabled).history(scene.id)).then(result => {
      if (generation.current !== token) return;
      setPage(result); setFrom(result.revisions[1]?.revision ?? result.head_revision); setTo(result.head_revision);
    }).catch(e => { if (generation.current === token) setError(e.message); })
      .finally(() => { if (generation.current === token) setLoading(false); });
    return () => { generation.current++; };
  }, [open, refresh, owner, scene.id, scene.revision]);
  async function loadMore() {
    if (!page?.next_before || loading) return;
    const token = generation.current; setLoading(true); setError('');
    try {
      const client = await connectUserClient(owner);
      const older = await new SceneRepository(client, owner, cloudStorageEnabled).history(scene.id, page.next_before);
      if (generation.current === token) setPage(current => current ? { ...current, revisions: [...current.revisions, ...older.revisions], next_before: older.next_before } : current);
    } catch (e) { if (generation.current === token) setError((e as Error).message); }
    finally { if (generation.current === token) setLoading(false); }
  }
  async function compare() {
    const token = generation.current; setLoading(true); setError(''); setComparison(null);
    try {
      const client = await connectUserClient(owner);
      const result = await new SceneRepository(client, owner, cloudStorageEnabled).compare(scene.id, from, to);
      if (generation.current === token) setComparison(result);
    } catch (e) { if (generation.current === token) setError((e as Error).message); }
    finally { if (generation.current === token) setLoading(false); }
  }
  return <details className="scene-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Revision history</summary>
    <p>Saved revisions stay unchanged. Restore appends a new head. Source and agent labels describe the authoring client; the account identifies the authenticated author.</p>
    <button disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}>Refresh history</button>
    {page && <>
      <p>Latest saved revision: {page.head_revision}</p>
      <ol aria-label="Scene revisions">
        {page.revisions.map(revision => <li key={revision.revision}>
          <b>Revision {revision.revision}</b> · <time dateTime={revision.created_at}>{new Date(revision.created_at).toLocaleString()}</time>
          <p>{revision.author_source}{revision.author_agent ? ` · ${revision.author_agent}` : ''}<br />
            <small>Account: {revision.author_id ?? 'Unknown'}{revision.parent_revision ? ` · Parent: ${revision.parent_revision}` : ''}</small></p>
          <p>{describeRevision(revision)}</p>
          <a href={sceneURLs(scene.id, revision.revision, window.location.origin).revision_url}>Open revision {revision.revision}</a>{' '}
          <button disabled={busy || loading || revision.revision === page.head_revision} onClick={() => restore(revision.revision, page.head_revision)}>Restore revision {revision.revision}</button>
        </li>)}
      </ol>
      {page.next_before && <button disabled={loading || busy} onClick={() => void loadMore()}>Load older revisions</button>}
      <div className="history-compare">
        <label>Compare from<select aria-label="Compare from revision" value={from} disabled={loading || busy} onChange={event => { setFrom(Number(event.target.value)); setComparison(null); }}>
          {page.revisions.map(revision => <option key={revision.revision} value={revision.revision}>Revision {revision.revision}</option>)}
        </select></label>
        <label>Compare to<select aria-label="Compare to revision" value={to} disabled={loading || busy} onChange={event => { setTo(Number(event.target.value)); setComparison(null); }}>
          {page.revisions.map(revision => <option key={revision.revision} value={revision.revision}>Revision {revision.revision}</option>)}
        </select></label>
        <button disabled={loading || busy || from === to} onClick={() => void compare()}>Compare revisions</button>
      </div>
      {comparison && <div role="region" aria-label="Revision comparison">
        <p>Revision {comparison.from_revision} → {comparison.to_revision}: {comparison.total_changes} changes</p>
        {comparison.total_changes > comparison.changes.length && <p>Showing the first {comparison.changes.length} changes. Open either revision to inspect the complete scene.</p>}
        {comparison.total_changes > 0 && <div className="history-diff-scroll"><table><thead><tr><th scope="col">Change</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>
          {comparison.changes.map((change, i) => <tr key={i}><th scope="row">{change.section}: {change.target}<br />{change.field}</th><td>{change.before}</td><td>{change.after}</td></tr>)}
        </tbody></table></div>}
      </div>}
    </>}
    {loading && <p role="status">Loading revision history…</p>}
    {error && <p role="alert" className="capture-error">{error}</p>}
  </details>;
}
