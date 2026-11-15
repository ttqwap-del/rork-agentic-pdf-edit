import { useEffect, useState } from 'react';
import { deleteRun, listRuns, type PublicRunStatus } from './lib/backend';
export default function RetainedDocuments({ refreshKey, onDeleted }: { refreshKey: number; onDeleted: (id: string) => void }) {
  const [runs, setRuns] = useState<PublicRunStatus[]>([]); const [busy, setBusy] = useState('');
  const [error, setError] = useState(''); const [confirm, setConfirm] = useState(''); const [loaded, setLoaded] = useState(false);
  useEffect(() => { let alive = true; setLoaded(false); void listRuns().then(data => { if (alive) { setRuns(data.runs); setError(''); } }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'Could not load saved documents.'); }).finally(() => { if (alive) setLoaded(true); }); return () => { alive = false; }; }, [refreshKey]);
  async function remove(id: string) { setBusy(id); setError(''); try { await deleteRun(id); setRuns(items => items.filter(r => r.runId !== id)); setConfirm(''); onDeleted(id); } catch (e) { setError(e instanceof Error ? e.message : 'Deletion failed. The document may still be retained; retry.'); } finally { setBusy(''); } }
  return <section aria-label="Retained documents">
    <h3>Retained documents</h3>
    <p>{loaded ? `${runs.length} of 20 runs · ${(runs.reduce((n, r) => n + (r.storageBytes || 0), 0) / 1048576).toFixed(1)} MB in saved PDF copies` : 'Loading saved documents…'}</p>
    <p className="connection-note">Source, working and finished PDFs stay in this browser’s studio session until you delete them. Delete Now stops studio work, removes these copies and disables their links. External processors may retain their own copies; this action cannot recall accepted emails or downloads. Other sessions’ and older unassigned jobs remain isolated and are not included here.</p>
    {error && <p role="alert">{error}</p>}
    {loaded && !runs.length && !error && <p>No documents saved in this browser studio session yet.</p>}
    <div className="retained-list">{runs.map(run => <article className="retained-row" key={run.runId}>
      <strong>{run.documentName}</strong><small>{run.status} · {((run.storageBytes || 0) / 1048576).toFixed(1)} MB</small>
      {confirm === run.runId ? <><p>Delete this run and every saved studio copy? This cannot be undone.</p><div className="storage-actions"><button type="button" className="withdraw-consent-btn" disabled={Boolean(busy)} onClick={() => void remove(run.runId)}>{busy === run.runId ? 'Deleting…' : 'Confirm Delete Now'}</button><button type="button" className="secondary-glass-btn" disabled={Boolean(busy)} onClick={() => setConfirm('')}>Keep document</button></div></> : <div className="storage-actions"><a className="secondary-glass-btn" href={`/?run=${encodeURIComponent(run.runId)}`}>Open saved run</a><button type="button" className="withdraw-consent-btn" onClick={() => setConfirm(run.runId)}>Delete Now</button></div>}
    </article>)}</div>
  </section>;
}
