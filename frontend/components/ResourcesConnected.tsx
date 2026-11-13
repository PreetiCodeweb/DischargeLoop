'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Bed, CheckCircle2, LoaderCircle, RefreshCw, Send } from 'lucide-react';
import { dl, errorMessage, type BedRow, type Ward } from './discharge/dlApi';

/**
 * Command Center capacity view. Bed state comes from DischargeLoop (the single source of truth);
 * an ICU capacity request is a time-limited DischargeLoop reservation that expires automatically.
 */
export function ResourcesConnected() {
  const [wards, setWards] = useState<Ward[]>([]);
  const [icuBeds, setIcuBeds] = useState<BedRow[]>([]);
  const [holdMinutes, setHoldMinutes] = useState(60);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [nextWards, beds] = await Promise.all([dl.wards(), dl.beds()]);
      const icuCodes = new Set(nextWards.filter((w) => w.department_type === 'ICU').map((w) => w.code));
      setWards(nextWards); setIcuBeds(beds.filter((b) => icuCodes.has(b.ward_code)));
    } catch (requestError) {
      setError(errorMessage(requestError, 'Unable to load live bed availability.'));
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const requestBed = async () => {
    const available = icuBeds.find((bed) => bed.state === 'AVAILABLE');
    if (!available) { setError('No available ICU bed can be held right now.'); return; }
    setSubmitting(true); setError(''); setMessage('');
    try {
      await dl.reserve(available.id, holdMinutes);
      setMessage(`ICU bed ${available.label} held for ${holdMinutes} minutes. It is released automatically if the admission is not confirmed.`);
      await load();
    } catch (requestError) {
      setError(errorMessage(requestError, 'The ICU bed could not be held.'));
    } finally { setSubmitting(false); }
  };

  return <section className="connected-resources">
    <div className="page-header"><div><span className="eyebrow">Capacity intelligence</span><h1>Beds & resource management</h1><p>Live availability from DischargeLoop, the authoritative bed-state system.</p></div>
      <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Refresh</button></div>
    <div className="stat-band">{wards.map((w) => <div key={w.ward_id}><span>{w.code} · {w.department_type ?? 'Ward'}</span><strong>{w.available}</strong>
      <small>{w.available} available / {w.total_beds} total · {w.cleaning} cleaning · {w.ready_to_depart} ready to depart</small></div>)}</div>
    <div className="panel" style={{ marginTop: 16, padding: 20 }}>
      <div className="section-title"><div><h2>Hold ICU capacity</h2><span>Creates a time-limited reservation on the next available ICU bed.</span></div><Bed size={20} /></div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'end', flexWrap: 'wrap' }}>
        <label>Hold for (minutes)<input type="number" min={5} max={1440} value={holdMinutes} onChange={(event) => setHoldMinutes(Number(event.target.value))} /></label>
        <button className="primary-button" onClick={() => void requestBed()} disabled={submitting || loading}>{submitting ? <><LoaderCircle className="scanner-spin" size={16} /> Holding…</> : <><Send size={16} /> Hold ICU bed</>}</button>
      </div>
      {message && <p role="status" style={{ color: 'var(--teal)' }}><CheckCircle2 size={16} /> {message}</p>}
      {error && <p role="alert" style={{ color: 'var(--red)' }}><AlertTriangle size={16} /> {error}</p>}
    </div>
    <div className="panel" style={{ marginTop: 16, padding: 20 }}>
      <div className="section-title"><div><h2>ICU bed inventory</h2><span>{loading ? 'Loading live inventory…' : `${icuBeds.length} beds`}</span></div></div>
      {loading ? <p>Loading live bed inventory…</p> : <div className="table-scroll"><table><thead><tr><th>Bed</th><th>Ward</th><th>Status</th><th>Held until</th></tr></thead>
        <tbody>{icuBeds.map((bed) => <tr key={bed.id}><td>{bed.label}</td><td>{bed.ward_code}</td><td>{bed.state}</td><td>{bed.reserved_until ? new Date(bed.reserved_until).toLocaleTimeString() : '—'}</td></tr>)}</tbody></table></div>}
    </div>
  </section>;
}
