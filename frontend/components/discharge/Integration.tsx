'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { categoryLabel, dl, errorMessage, formatWhen, humanize, type IntegrationStatus, type Metrics } from './dlApi';

/** Feature 5 health (HL7 feed, quarantine) and the operational measures the pilot is judged on. */
export function Integration() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([dl.integration(), dl.metrics()]);
      setStatus(s); setMetrics(m); setError('');
    } catch (err) { setError(errorMessage(err, 'Unable to load integration status.')); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const escalate = async () => {
    try { const r = await dl.runEscalations(); setNotice(`${r.escalated} task(s) escalated`); await load(); }
    catch (err) { setError(errorMessage(err, 'Escalation run failed.')); }
  };

  return (
    <section className="dl-page">
      <div className="page-header">
        <div><span className="eyebrow">DischargeLoop</span><h1>EHR feed &amp; outcomes</h1>
          <p>HL7 v2 from the interface engine (Epic Bridges → Mirth/Redox). Read-only: nothing is written back to the EHR.</p></div>
        <div className="dl-toolbar"><button className="secondary-button" onClick={() => void escalate()}>Run escalations now</button>
          <button className="secondary-button" onClick={() => void load()}><RefreshCw size={16} /> Refresh</button></div>
      </div>
      {error && <div className="dl-alert error" role="alert"><AlertTriangle size={16} /> {error}</div>}
      {notice && <div className="dl-alert success" role="status">{notice}</div>}
      <div className="dl-summary">
        <div><span>Discharges completed</span><strong>{metrics?.ready_delay.departed ?? '—'}</strong></div>
        <div><span>Avg hours cleared → departed</span><strong>{metrics?.ready_delay.avg_hours_cleared_to_departed ?? '—'}</strong></div>
        <div className={status?.open_quarantine ? 'warning' : ''}><span>HL7 messages needing review</span><strong>{status?.open_quarantine ?? '—'}</strong></div>
        <div className={status?.feed.stale ? 'critical' : ''}><span>EHR feed</span>
          <strong>{!status ? '—' : !status.feed.configured ? 'Not connected' : status.feed.stale ? 'Delayed' : 'Live'}</strong>
          {status?.feed.last_message_at && <span className="dl-sub">Last message {formatWhen(status.feed.last_message_at)}</span>}</div>
      </div>
      <div className="dl-grid-2">
        <div className="dl-card"><h2>HL7 messages (24 h)</h2>
          {!status?.events.length ? <p className="dl-empty">No messages received in the last 24 hours.</p> :
            <table className="dl-table"><caption className="sr-only">HL7 messages received in the last 24 hours</caption><thead><tr><th scope="col">Event</th><th scope="col">Status</th><th scope="col">Count</th><th scope="col">Last seen</th></tr></thead>
              <tbody>{status.events.map((e) => <tr key={`${e.event_type}-${e.processing_status}`}><td>{e.event_type}</td>
                <td><span className={`dl-badge ${e.processing_status === 'PROCESSED' ? 'ok' : 'warning'}`}>{humanize(e.processing_status)}</span></td>
                <td>{e.n}</td><td>{formatWhen(e.last_seen)}</td></tr>)}</tbody></table>}
        </div>
        <div className="dl-card"><h2>Delay by blocker category</h2>
          {!metrics?.blockers_by_category.length ? <p className="dl-empty">No blockers recorded yet.</p> :
            <table className="dl-table"><caption className="sr-only">Discharge delay by blocker category</caption><thead><tr><th scope="col">Category</th><th scope="col">Side</th><th scope="col">Total</th><th scope="col">Open</th><th scope="col">Avg h open</th></tr></thead>
              <tbody>{metrics.blockers_by_category.map((b) => <tr key={`${b.category}-${b.side}`}><td>{categoryLabel(b.category)}</td>
                <td><span className={`dl-badge ${b.side === 'EXTERNAL' ? 'external' : 'internal'}`}>{humanize(b.side)}</span></td>
                <td>{b.total}</td><td>{b.open}</td><td>{b.avg_hours_open ?? '—'}</td></tr>)}</tbody></table>}
        </div>
      </div>
    </section>
  );
}
