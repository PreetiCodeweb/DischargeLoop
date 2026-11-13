'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { canWork, dl, errorMessage, navigate, relativeDue, type Task } from './dlApi';

/** Feature 2: the queue for my functional role on my wards (e.g. pharmacist@4A), plus anything I claimed. */
export function MyTasks({ role, userId }: { role: string; userId: string }) {
  const [mine, setMine] = useState(true);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setTasks(await dl.tasks(mine)); setError(''); }
    catch (err) { setError(errorMessage(err, 'Unable to load tasks.')); }
    finally { setLoading(false); }
  }, [mine]);

  useEffect(() => { void load(); }, [load]);

  const act = async (task: Task, action: 'claim' | 'complete') => {
    setBusy(task.id); setError('');
    try { await dl.taskAction(task.id, action); await load(); }
    catch (err) { setError(errorMessage(err, 'The task could not be updated.')); }
    finally { setBusy(null); }
  };

  return (
    <section className="dl-page">
      <div className="page-header">
        <div><span className="eyebrow">DischargeLoop</span><h1>{mine ? 'My task queue' : 'All open tasks on my wards'}</h1>
          <p>Every task has a named owner role and a due time. Overdue work escalates automatically.</p></div>
        <div className="dl-toolbar">
          <label>View<select value={mine ? 'mine' : 'ward'} onChange={(e) => setMine(e.target.value === 'mine')}><option value="mine">My role &amp; claimed</option><option value="ward">Whole ward</option></select></label>
          <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Refresh</button>
        </div>
      </div>
      {error && <div className="dl-alert error" role="alert"><AlertTriangle size={16} /> {error}</div>}
      <div className="dl-card">
        {loading && !tasks.length ? <p className="dl-empty"><LoaderCircle className="scanner-spin" size={16} /> Loading…</p>
          : !tasks.length ? <p className="dl-empty">Nothing waiting on you right now.</p>
          : <div className="table-scroll"><table className="dl-table">
            <caption className="sr-only">Open discharge tasks, soonest due first</caption>
            <thead><tr><th scope="col">Due</th><th scope="col">Task</th><th scope="col">Bed</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{tasks.map((t) => <tr key={t.id}>
              <td className={t.overdue ? 'dl-overdue' : ''}>{relativeDue(t.due_at)}{t.escalation_level > 0 && <span className="dl-sub">Escalated L{t.escalation_level}</span>}</td>
              <td><button className="dl-small-button" onClick={() => t.discharge_id && navigate(`/discharges/${t.discharge_id}`)}>{t.title}</button></td>
              <td>{t.bed_label ?? '—'}<span className="dl-sub">{t.ward_code}</span></td>
              <td>{t.owner}</td>
              <td><span className={`dl-badge ${t.status === 'CLAIMED' ? 'ok' : 'muted'}`}>{t.status === 'CLAIMED' ? 'Claimed' : 'Open'}</span></td>
              <td>{canWork(t, role, userId) ? <div className="dl-actions">
                {t.status === 'OPEN' && <button disabled={busy === t.id} onClick={() => void act(t, 'claim')} aria-label={`Claim task: ${t.title}`}>Claim</button>}
                <button className="go" disabled={busy === t.id} onClick={() => void act(t, 'complete')} aria-label={`Mark done: ${t.title}`}>Done</button></div>
                : <span className="dl-sub">Owned by {t.owner}</span>}</td>
            </tr>)}</tbody></table></div>}
      </div>
    </section>
  );
}
