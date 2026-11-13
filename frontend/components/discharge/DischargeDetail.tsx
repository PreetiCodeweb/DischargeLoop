'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import {
  canWork, categoryLabel, dl, errorMessage, formatWhen, humanize, navigate, relativeDue, STATE_LABEL,
  type BlockerSide, type DischargeDetail as Detail, type TransitionTarget,
} from './dlApi';

interface Action { target: TransitionTarget; label: string; tone?: 'go' | 'danger'; needsReason?: boolean }

// Mirrors the server state machine (backend/app/discharge/domain.py); the server remains the authority.
const ACTIONS: Record<TransitionTarget, Action[]> = {
  INITIATED: [{ target: 'MEDICALLY_CLEARED', label: 'Medically clear', tone: 'go' }, { target: 'CANCELLED', label: 'Cancel discharge', tone: 'danger', needsReason: true }],
  MEDICALLY_CLEARED: [{ target: 'TASKS_PENDING', label: 'Start discharge tasks', tone: 'go' }, { target: 'CANCELLED_REVERSED', label: 'Clinical reversal', tone: 'danger', needsReason: true }, { target: 'CANCELLED', label: 'Cancel', tone: 'danger', needsReason: true }],
  TASKS_PENDING: [{ target: 'READY_TO_DEPART', label: 'Mark ready to depart', tone: 'go' }, { target: 'CANCELLED_REVERSED', label: 'Clinical reversal', tone: 'danger', needsReason: true }, { target: 'CANCELLED', label: 'Cancel', tone: 'danger', needsReason: true }],
  READY_TO_DEPART: [{ target: 'DEPARTED', label: 'Patient departed', tone: 'go' }, { target: 'CANCELLED_REVERSED', label: 'Clinical reversal (patient must stay)', tone: 'danger', needsReason: true }],
  DEPARTED: [],
  CANCELLED: [{ target: 'INITIATED', label: 'Restart discharge', tone: 'go' }],
  CANCELLED_REVERSED: [{ target: 'INITIATED', label: 'Restart discharge', tone: 'go' }],
};
const OWNER_ROLES = ['doctor', 'nurse', 'case_manager', 'pharmacist', 'transport', 'housekeeping', 'billing', 'bed_manager'];
const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

export function DischargeDetail({ id, role, userId }: { id: string; role: string; userId: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [blocker, setBlocker] = useState({ category: 'POST_ACUTE_PLACEMENT', description: '', side: '' as '' | BlockerSide, external_party: '', due: 240 });
  const [task, setTask] = useState({ title: '', owner_role: 'nurse', due: 120, blocking: true });
  const [edd, setEdd] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await dl.discharge(id);
      setDetail(next); setEdd(toLocalInput(next.expected_discharge_at)); setError('');
    } catch (err) { setError(errorMessage(err, 'Unable to load this discharge.')); }
  }, [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { dl.meta().then((m) => setCategories(m.blocker_categories)).catch(() => setCategories([])); }, []);

  const run = async (work: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(success); await load(); return true; }
    catch (err) { setError(errorMessage(err, 'The action failed.')); return false; }
    finally { setBusy(false); }
  };

  const transition = async (action: Action) => {
    if (!detail) return;
    if (action.needsReason && !pending) { setPending(action); setReason(''); return; }
    const ok = await run(() => dl.transition(detail.id, action.target, detail.version, action.needsReason ? reason : undefined), `${action.label}: done`);
    if (ok) setPending(null);
  };

  const submitBlocker = async (e: FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    const ok = await run(() => dl.addBlocker(detail.id, {
      category: blocker.category, description: blocker.description.trim(), due_in_minutes: blocker.due,
      ...(blocker.side ? { side: blocker.side } : {}), ...(blocker.external_party.trim() ? { external_party: blocker.external_party.trim() } : {}),
    }), 'Blocker recorded and owner task created');
    if (ok) setBlocker((b) => ({ ...b, description: '', external_party: '' }));
  };

  const submitTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!detail) return;
    const type = task.title.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').slice(0, 40) || 'CUSTOM';
    const ok = await run(() => dl.addTask(detail.id, { type, title: task.title.trim(), owner_role: task.owner_role, due_in_minutes: task.due, blocking: task.blocking }), 'Task added');
    if (ok) setTask((t) => ({ ...t, title: '' }));
  };

  if (!detail) return <section className="dl-page">{error ? <div className="dl-alert error" role="alert">{error}</div> : <p className="dl-empty"><LoaderCircle className="scanner-spin" size={16} /> Loading discharge…</p>}</section>;

  const active = !['DEPARTED', 'CANCELLED', 'CANCELLED_REVERSED'].includes(detail.state);
  const openBlockers = detail.blockers.filter((b) => b.status === 'OPEN');
  const openTasks = detail.tasks.filter((t) => t.status === 'OPEN' || t.status === 'CLAIMED');

  return (
    <section className="dl-page">
      <div className="page-header">
        <div>
          <button className="dl-small-button" onClick={() => navigate('/worklist')}><ArrowLeft size={14} /> Worklist</button>
          <span className="eyebrow" style={{ display: 'block', marginTop: 10 }}>Bed {detail.bed_label ?? '—'} · {detail.ward_code} · {detail.mrn}</span>
          <h1>{detail.patient_name}</h1>
          <p><span className={`dl-badge state-${detail.state}`}>{STATE_LABEL[detail.state]}</span> {detail.source === 'HL7_A16' && <span className="dl-badge muted">Started by EHR (A16)</span>}
            {detail.reversal_count > 0 && <span className="dl-badge critical">Reversed {detail.reversal_count}×</span>}</p>
        </div>
        <button className="secondary-button" onClick={() => void load()} disabled={busy}><RefreshCw size={16} /> Refresh</button>
      </div>

      {error && <div className="dl-alert error" role="alert"><AlertTriangle size={16} /> {error}</div>}
      {notice && <div className="dl-alert success" role="status"><CheckCircle2 size={16} /> {notice}</div>}
      {detail.state === 'CANCELLED_REVERSED' && detail.reversal_reason && <div className="dl-alert warning">Clinical reversal: {detail.reversal_reason}</div>}

      <div className="dl-card">
        <h2>Next step</h2>
        <div className="dl-actions">
          {ACTIONS[detail.state].map((a) => <button key={a.target} className={a.tone} disabled={busy} onClick={() => void transition(a)}>{a.label}</button>)}
          {!ACTIONS[detail.state].length && <span className="dl-sub">Discharge complete. Bed turnover continues in Beds &amp; turnover.</span>}
        </div>
        {detail.state === 'TASKS_PENDING' && (openBlockers.length > 0 || openTasks.some((t) => t.blocking)) &&
          <p className="dl-sub">Ready to depart unlocks when {openBlockers.length} blocker(s) and {openTasks.filter((t) => t.blocking).length} blocking task(s) are closed.</p>}
        {pending && <form className="dl-form" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void transition(pending); }}>
          <label>Reason for “{pending.label}” (required, recorded in the audit trail)
            <textarea required maxLength={500} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </label>
          <div className="dl-actions"><button className="danger" type="submit" disabled={busy || !reason.trim()}>Confirm {pending.label.toLowerCase()}</button>
            <button type="button" onClick={() => setPending(null)}>Keep current state</button></div>
        </form>}
        {active && <form className="dl-toolbar" style={{ marginTop: 12 }} onSubmit={(e) => { e.preventDefault(); void run(() => dl.setExpectedDischarge(detail.id, edd ? new Date(edd).toISOString() : null), 'Expected discharge updated'); }}>
          <label>Expected discharge<input type="datetime-local" value={edd} onChange={(e) => setEdd(e.target.value)} /></label>
          <button className="dl-small-button" type="submit" disabled={busy}>Save</button>
        </form>}
      </div>

      <div className="dl-grid-2">
        <div className="dl-card">
          <h2>Blockers ({openBlockers.length} open)</h2>
          {detail.blockers.length === 0 ? <p className="dl-empty">No blockers recorded.</p> :
            <table className="dl-table"><tbody>{detail.blockers.map((b) => (
              <tr key={b.id}><td><span className={`dl-badge ${b.side === 'EXTERNAL' ? 'external' : 'internal'}`}>{humanize(b.side)}</span>
                <strong style={{ marginLeft: 6 }}>{categoryLabel(b.category)}</strong>
                <span className="dl-sub">{b.description}{b.external_party ? ` · ${b.external_party}` : ''} · owner {b.owner_role} · opened {formatWhen(b.opened_at)}</span>
                {b.resolution_note && <span className="dl-sub">Resolution: {b.resolution_note}</span>}</td>
                <td style={{ textAlign: 'right' }}>{b.status === 'OPEN'
                  ? <div className="dl-actions" style={{ justifyContent: 'flex-end' }}><button className="go" disabled={busy} onClick={() => void run(() => dl.closeBlocker(b.id, 'resolve'), 'Blocker resolved')} aria-label={`Resolve blocker: ${b.description}`}>Resolve</button>
                    <button disabled={busy} onClick={() => void run(() => dl.closeBlocker(b.id, 'cancel'), 'Blocker cancelled')}>Cancel</button></div>
                  : <span className="dl-badge muted">{humanize(b.status)}</span>}</td></tr>))}</tbody></table>}
          {active && <form className="dl-form" onSubmit={(e) => void submitBlocker(e)} style={{ marginTop: 12 }}>
            <div className="dl-form-row">
              <label>Category<select value={blocker.category} onChange={(e) => setBlocker({ ...blocker, category: e.target.value })}>{categories.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}</select></label>
              <label>Side<select value={blocker.side} onChange={(e) => setBlocker({ ...blocker, side: e.target.value as '' | BlockerSide })}><option value="">Default for category</option><option value="INTERNAL">Internal (our team)</option><option value="EXTERNAL">External (another organization)</option></select></label>
              <label>Due in (min)<input type="number" min={5} max={10080} value={blocker.due} onChange={(e) => setBlocker({ ...blocker, due: Number(e.target.value) })} /></label>
            </div>
            <label>What is blocking discharge?<input required minLength={3} maxLength={280} value={blocker.description} onChange={(e) => setBlocker({ ...blocker, description: e.target.value })} /></label>
            <label>External party (facility, payer, vendor, family) — required for external blockers<input maxLength={160} value={blocker.external_party} onChange={(e) => setBlocker({ ...blocker, external_party: e.target.value })} /></label>
            <div className="dl-actions"><button type="submit" disabled={busy}><Plus size={14} /> Add blocker</button></div>
          </form>}
        </div>

        <div className="dl-card">
          <h2>Tasks ({openTasks.length} open)</h2>
          {detail.tasks.length === 0 ? <p className="dl-empty">Tasks are created when the discharge reaches “Tasks pending”, or added below.</p> :
            <table className="dl-table"><tbody>{detail.tasks.map((t) => (
              <tr key={t.id}><td><strong>{t.title}</strong>{t.blocking && <span className="dl-badge muted" style={{ marginLeft: 6 }}>Blocking</span>}
                {t.source === 'HL7' && <span className="dl-badge ok" style={{ marginLeft: 6 }}>EHR</span>}
                <span className="dl-sub">{t.owner} · {t.status === 'OPEN' || t.status === 'CLAIMED'
                  ? <span className={t.overdue ? 'dl-overdue' : ''}>{relativeDue(t.due_at)}{t.escalation_level > 0 ? ` · escalated L${t.escalation_level}` : ''}</span>
                  : `${humanize(t.status)} ${formatWhen(t.completed_at)}`}</span></td>
                <td style={{ textAlign: 'right' }}>{(t.status === 'OPEN' || t.status === 'CLAIMED') && (canWork(t, role, userId) ?
                  <div className="dl-actions" style={{ justifyContent: 'flex-end' }}>
                    {t.status === 'OPEN' && <button disabled={busy} onClick={() => void run(() => dl.taskAction(t.id, 'claim'), 'Task claimed')} aria-label={`Claim task: ${t.title}`}>Claim</button>}
                    <button className="go" disabled={busy} onClick={() => void run(() => dl.taskAction(t.id, 'complete'), 'Task completed')} aria-label={`Mark done: ${t.title}`}>Done</button>
                  </div> : <span className="dl-sub">Waiting on {t.owner}</span>)}</td></tr>))}</tbody></table>}
          {active && <form className="dl-form" onSubmit={(e) => void submitTask(e)} style={{ marginTop: 12 }}>
            <label>New task<input required minLength={3} maxLength={160} value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} /></label>
            <div className="dl-form-row">
              <label>Owner role (on this ward)<select value={task.owner_role} onChange={(e) => setTask({ ...task, owner_role: e.target.value })}>{OWNER_ROLES.map((r) => <option key={r} value={r}>{humanize(r)}@{detail.ward_code}</option>)}</select></label>
              <label>Due in (min)<input type="number" min={5} max={10080} value={task.due} onChange={(e) => setTask({ ...task, due: Number(e.target.value) })} /></label>
              <label>Blocks departure<select value={task.blocking ? 'yes' : 'no'} onChange={(e) => setTask({ ...task, blocking: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></select></label>
            </div>
            <div className="dl-actions"><button type="submit" disabled={busy}><Plus size={14} /> Add task</button></div>
          </form>}
        </div>
      </div>

      <div className="dl-card">
        <h2>Timeline</h2>
        <ul className="dl-timeline">{detail.timeline.map((e, i) => <li key={`${e.occurred_at}-${i}`}><strong>{humanize(e.reason_code)}</strong><span className="dl-sub">{formatWhen(e.occurred_at)} · {e.actor_role} · {e.action}</span></li>)}</ul>
      </div>
    </section>
  );
}
