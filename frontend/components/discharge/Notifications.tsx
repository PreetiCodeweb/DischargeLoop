'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BellRing, RefreshCw } from 'lucide-react';
import { dl, errorMessage, formatWhen, navigate, type Notification } from './dlApi';

/** Feature 4: escalations and reminders addressed to my role (and my wards). No PHI leaves the app. */
export function Notifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await dl.notifications(unreadOnly)); setError(''); }
    catch (err) { setError(errorMessage(err, 'Unable to load alerts.')); }
    finally { setLoading(false); }
  }, [unreadOnly]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const open = async (n: Notification) => {
    try { if (!n.read_at) await dl.markRead(n.id); } catch { /* opening the item matters more than the read receipt */ }
    if (n.entity_type === 'discharge' && n.entity_id) navigate(`/discharges/${n.entity_id}`);
    else if (n.entity_type === 'task') navigate('/tasks');
    else if (n.entity_type === 'bed') navigate('/beds');
    else void load();
  };

  return (
    <section className="dl-page">
      <div className="page-header">
        <div><span className="eyebrow">DischargeLoop</span><h1>Alerts &amp; escalations</h1><p>Overdue tasks escalate by policy: owner first, then case management, then operations.</p></div>
        <div className="dl-toolbar">
          <label>Show<select value={unreadOnly ? 'unread' : 'all'} onChange={(e) => setUnreadOnly(e.target.value === 'unread')}><option value="unread">Unread</option><option value="all">All</option></select></label>
          <button className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={16} /> Refresh</button>
        </div>
      </div>
      {error && <div className="dl-alert error" role="alert"><AlertTriangle size={16} /> {error}</div>}
      <div className="dl-card" style={{ display: 'grid', gap: 8 }}>
        {!items.length ? <p className="dl-empty"><BellRing size={16} /> {loading ? 'Loading…' : 'No alerts.'}</p> :
          items.map((n) => <button key={n.id} className={`dl-card dl-notice ${n.severity} ${n.read_at ? '' : 'unread'}`} style={{ textAlign: 'left' }} onClick={() => void open(n)}>
            <strong>{n.title}</strong><span className="dl-sub">{n.body}</span>
            <span className="dl-sub">{n.severity} · {formatWhen(n.created_at)}{n.ward_code ? ` · ${n.ward_code}` : ''}</span>
          </button>)}
      </div>
    </section>
  );
}
