'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import { dl, errorMessage, formatWhen, humanize, type BedRow, type CleaningJob } from './dlApi';

/** Authoritative bed lifecycle + human-confirmed turnover (a different person must verify each cleaning). */
export function BedsBoard() {
  const [beds, setBeds] = useState<BedRow[]>([]);
  const [jobs, setJobs] = useState<CleaningJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextBeds, nextJobs] = await Promise.all([dl.beds(), dl.cleaning()]);
      setBeds(nextBeds); setJobs(nextJobs); setError('');
    } catch (err) { setError(errorMessage(err, 'Unable to load beds.')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, work: () => Promise<unknown>, success: string) => {
    setBusy(key); setError(''); setNotice('');
    try { await work(); setNotice(success); await load(); }
    catch (err) { setError(errorMessage(err, 'The bed action failed.')); }
    finally { setBusy(null); }
  };

  const byWard = useMemo(() => beds.reduce<Record<string, BedRow[]>>((acc, b) => { (acc[b.ward_code] ??= []).push(b); return acc; }, {}), [beds]);

  return (
    <section className="dl-page">
      <div className="page-header">
        <div><span className="eyebrow">DischargeLoop</span><h1>Beds &amp; turnover</h1>
          <p>A bed returns to Available only after two different people accept and verify the cleaning.</p></div>
        <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Refresh</button>
      </div>
      {error && <div className="dl-alert error" role="alert"><AlertTriangle size={16} /> {error}</div>}
      {notice && <div className="dl-alert success" role="status"><CheckCircle2 size={16} /> {notice}</div>}

      <div className="dl-card">
        <h2>Cleaning queue ({jobs.length})</h2>
        {!jobs.length ? <p className="dl-empty">No beds waiting for cleaning.</p> :
          <table className="dl-table"><caption className="sr-only">Beds waiting for cleaning or verification</caption><thead><tr><th scope="col">Bed</th><th scope="col">Requested</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{jobs.map((j) => <tr key={j.id}>
              <td><strong>{j.bed_label}</strong><span className="dl-sub">{j.ward_code}</span></td>
              <td>{formatWhen(j.requested_at)}</td>
              <td><span className={`dl-badge ${j.status === 'OPEN' ? 'warning' : 'ok'}`}>{j.status === 'OPEN' ? 'Needs cleaning' : 'Cleaned — needs verification'}</span></td>
              <td><div className="dl-actions">{j.status === 'OPEN'
                ? <button disabled={busy === j.id} onClick={() => void run(j.id, () => dl.cleaningAction(j.id, 'accept'), `Bed ${j.bed_label}: cleaning accepted`)} aria-label={`Accept and clean bed ${j.bed_label}`}>Accept &amp; clean</button>
                : <button className="go" disabled={busy === j.id} onClick={() => void run(j.id, () => dl.cleaningAction(j.id, 'verify'), `Bed ${j.bed_label} verified and available`)} aria-label={`Verify bed ${j.bed_label} is ready`}>Verify ready</button>}</div></td>
            </tr>)}</tbody></table>}
      </div>

      {loading && !beds.length ? <p className="dl-empty"><LoaderCircle className="scanner-spin" size={16} /> Loading beds…</p> :
        Object.entries(byWard).map(([ward, rows]) => <div className="dl-card" key={ward}>
          <h2>{ward} · {rows.filter((b) => b.state === 'AVAILABLE').length} available / {rows.length}</h2>
          <div className="dl-beds">{rows.map((b) => <div key={b.id} className={`dl-bed ${b.state}`}>
            <strong>{b.label}</strong><span className="dl-sub">{humanize(b.state)}{b.discharge_state ? ` · ${humanize(b.discharge_state)}` : ''}</span>
            {b.reserved_until && <span className="dl-sub">Held until {formatWhen(b.reserved_until)}</span>}
            <div className="dl-actions" style={{ marginTop: 6 }}>
              {b.state === 'AVAILABLE' && <button disabled={busy === b.id} onClick={() => void run(b.id, () => dl.reserve(b.id, 60), `Bed ${b.label} held for 60 min`)} aria-label={`Hold bed ${b.label} for 60 minutes`}>Hold</button>}
              {b.state === 'RESERVED' && <button disabled={busy === b.id} onClick={() => void run(b.id, () => dl.release(b.id), `Bed ${b.label} released`)} aria-label={`Release hold on bed ${b.label}`}>Release</button>}
            </div>
          </div>)}</div>
        </div>)}
    </section>
  );
}
