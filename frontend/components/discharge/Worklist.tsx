'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ClipboardList, LoaderCircle, Play, RefreshCw } from 'lucide-react';
import { categoryLabel, dl, errorMessage, formatWhen, humanize, navigate, relativeDue, STATE_LABEL, type FeedHealth, type Ward, type Worklist as WorklistData, type WorklistItem } from './dlApi';

const REFRESH_MS = 30_000;

/** Feature 1: per-ward discharge worklist — status, EDD, top blocker, next owner, delay since medically cleared. */
export function Worklist() {
  const [wards, setWards] = useState<Ward[]>([]);
  const [wardId, setWardId] = useState('');
  const [data, setData] = useState<WorklistData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedHealth | null>(null);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const [nextWards, nextList, nextFeed] = await Promise.all([dl.wards(), dl.worklist(wardId || undefined), dl.feedHealth().catch(() => null)]);
      if (signal?.cancelled) return;
      setWards(nextWards); setData(nextList); setFeed(nextFeed); setError('');
    } catch (err) {
      if (!signal?.cancelled) setError(errorMessage(err, 'Unable to load the discharge worklist.'));
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  }, [wardId]);

  useEffect(() => {
    const signal = { cancelled: false };
    setLoading(true);
    void load(signal);
    const timer = window.setInterval(() => { void load(signal); }, REFRESH_MS);
    return () => { signal.cancelled = true; window.clearInterval(timer); };
  }, [load]);

  const start = async (item: WorklistItem) => {
    setStarting(item.encounter_id); setError('');
    try {
      const created = await dl.initiate(item.encounter_id);
      navigate(`/discharges/${created.id}`);
    } catch (err) {
      setError(errorMessage(err, 'Could not start the discharge.'));
    } finally { setStarting(null); }
  };

  const open = (item: WorklistItem) => { if (item.discharge_id) navigate(`/discharges/${item.discharge_id}`); };
  const s = data?.summary;

  return (
    <section className="dl-page">
      <div className="page-header">
        <div><span className="eyebrow">DischargeLoop</span><h1>Discharge worklist</h1>
          <p>What is still preventing each patient from leaving safely, who owns the next step, and how late it is.</p></div>
        <div className="dl-toolbar">
          <label>Ward
            <select value={wardId} onChange={(e) => setWardId(e.target.value)} aria-label="Filter by ward">
              <option value="">All my wards</option>
              {wards.map((w) => <option key={w.ward_id} value={w.ward_id}>{w.code} · {w.name}</option>)}
            </select>
          </label>
          <button className="secondary-button" onClick={() => { setLoading(true); void load(); }} disabled={loading}><RefreshCw size={16} /> Refresh</button>
        </div>
      </div>

      {error && <div className="dl-alert error" role="alert"><AlertTriangle size={16} /> {error}</div>}
      {feed?.stale && <div className="dl-alert error dl-feed-banner" role="alert"><AlertTriangle size={16} />{' '}
        <strong>EHR feed delayed.</strong> No update from the EHR for {feed.age_seconds !== null ? `${Math.round(feed.age_seconds / 60)} minutes` : 'a while'}.
        Admissions, transfers and discharges may be missing — confirm the census in the EHR before acting.</div>}

      <div className="dl-summary" aria-live="polite">
        <div><span>Patients</span><strong>{s?.patients ?? '—'}</strong></div>
        <div><span>Discharges in progress</span><strong>{s?.in_progress ?? '—'}</strong></div>
        <div><span>Ready to depart</span><strong>{s?.ready_to_depart ?? '—'}</strong></div>
        <div className={s?.overdue_tasks ? 'critical' : ''}><span>Overdue tasks</span><strong>{s?.overdue_tasks ?? '—'}</strong></div>
        <div className={s?.external_blockers ? 'warning' : ''}><span>Waiting on external</span><strong>{s?.external_blockers ?? '—'}</strong></div>
      </div>

      <div className="dl-card">
        {loading && !data ? <p className="dl-empty"><LoaderCircle className="scanner-spin" size={16} /> Loading worklist…</p>
          : !data?.items.length ? <p className="dl-empty">No admitted patients in your wards.</p>
          : <div className="table-scroll"><table className="dl-table">
            <caption className="sr-only">Admitted patients and their discharge status, ordered by readiness</caption>
            <thead><tr><th scope="col">Bed</th><th scope="col">Patient</th><th scope="col">Status</th><th scope="col">Expected discharge</th><th scope="col">Top blocker</th><th scope="col">Next step · owner</th><th scope="col">Tasks</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{data.items.map((item) => (
              <tr key={item.encounter_id}>
                <td><strong>{item.bed_label ?? '—'}</strong><span className="dl-sub">{item.ward_code}</span></td>
                <td>{item.discharge_id ? <button className="dl-link-button" onClick={() => open(item)}>{item.patient_name}</button> : item.patient_name}
                  <span className="dl-sub">{item.mrn}{item.patient_class !== 'I' ? ` · ${item.patient_class === 'O' ? 'Observation' : 'Emergency'}` : ''}{item.on_leave ? ' · On leave' : ''}{item.medicare ? ' · Medicare' : ''}</span></td>
                <td><span className={`dl-badge state-${item.state}`}>{STATE_LABEL[item.state]}</span>
                  {item.hours_since_medically_cleared !== null && <span className="dl-sub">{item.hours_since_medically_cleared} h since cleared</span>}
                  {item.state === 'CANCELLED_REVERSED' && item.reversal_reason && <span className="dl-sub">{item.reversal_reason}</span>}</td>
                <td>{formatWhen(item.expected_discharge_at)}</td>
                <td>{item.top_blocker
                  ? <><span className={`dl-badge ${item.top_blocker.side === 'EXTERNAL' ? 'external' : 'internal'}`}>{humanize(item.top_blocker.side)}</span> {categoryLabel(item.top_blocker.category)}
                    <span className="dl-sub">{item.top_blocker.external_party ?? item.top_blocker.description}</span></>
                  : <span className="dl-sub">None</span>}</td>
                <td>{item.next_task
                  ? <>{item.next_task.title}<span className="dl-sub">{item.next_task.owner} · <span className={new Date(item.next_task.due_at) < new Date() ? 'dl-overdue' : ''}>{relativeDue(item.next_task.due_at)}</span></span></>
                  : <span className="dl-sub">—</span>}</td>
                <td>{item.open_tasks}{item.overdue_tasks > 0 && <span className="dl-sub dl-overdue">{item.overdue_tasks} overdue</span>}</td>
                <td>
                  {item.state === 'NOT_STARTED' || item.state === 'CANCELLED' || item.state === 'CANCELLED_REVERSED'
                    ? <button className="dl-small-button go" onClick={() => void start(item)} disabled={starting === item.encounter_id}
                        aria-label={`${item.state === 'NOT_STARTED' ? 'Start' : 'Restart'} discharge for bed ${item.bed_label ?? item.ward_code}`}>
                        {starting === item.encounter_id ? <LoaderCircle className="scanner-spin" size={14} /> : <Play size={14} />} {item.state === 'NOT_STARTED' ? 'Start' : 'Restart'}
                      </button>
                    : <button className="dl-small-button" onClick={() => open(item)} aria-label={`Open discharge for bed ${item.bed_label ?? item.ward_code}`}><ClipboardList size={14} /> Open</button>}
                </td>
              </tr>))}
            </tbody></table></div>}
      </div>
    </section>
  );
}
