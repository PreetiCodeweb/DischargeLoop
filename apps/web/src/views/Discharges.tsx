import { useEffect, useState } from 'react';
import { ApiError, request, type Session } from '../api';
import { label, timeAgo, usePolling } from '../lib';
import type { Discharge, DischargeDetail, DischargeState, Encounter, Task } from '../types';

const NEXT: Partial<Record<DischargeState, { target: DischargeState; text: string }>> = {
  INITIATED: { target: 'MEDICALLY_CLEARED', text: 'Record medical clearance' },
  MEDICALLY_CLEARED: { target: 'TASKS_PENDING', text: 'Create handoff tasks' },
  TASKS_PENDING: { target: 'READY_TO_DEPART', text: 'Mark ready to depart' },
  READY_TO_DEPART: { target: 'DEPARTED', text: 'Confirm departure' },
};

export function Discharges({ session }: { session: Session }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [admission, setAdmission] = useState<{ encounters: Encounter[]; open: boolean }>({ encounters: [], open: false });

  const { data, error: loadError, refresh } = usePolling(async () => {
    const [discharges, encounters] = await Promise.all([
      request<Discharge[]>('/discharges'),
      request<Encounter[]>('/encounters?status=ADMITTED'),
    ]);
    return { discharges, encounters };
  }, 5000);

  useEffect(() => {
    if (data) setAdmission((current) => ({ ...current, encounters: data.encounters }));
  }, [data]);

  const detail = usePolling(async () => {
    if (!selected) return null;
    return request<DischargeDetail>(`/discharges/${selected}`);
  }, 4000);
  useEffect(() => { detail.refresh(); }, [selected]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
      detail.refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const advance = (discharge: Discharge, target: DischargeState) =>
    run(() => request(`/discharges/${discharge.id}`, { method: 'PATCH', body: { targetState: target } }));

  const cancel = (discharge: Discharge) => {
    const reason = window.prompt('Cancellation reason (required)');
    if (!reason) return;
    void run(() => request(`/discharges/${discharge.id}`, { method: 'PATCH', body: { targetState: 'CANCELLED', reasonCode: 'DISCHARGE_CANCELLED_REVERSED', reversalReason: reason } }));
  };

  const startDischarge = (encounter: Encounter) =>
    run(async () => {
      const created = await request<{ dischargeId: string }>('/discharges', {
        method: 'POST',
        body: { encounterId: encounter.id },
      });
      setSelected(created.dischargeId);
      setAdmission({ encounters: [], open: false });
    });

  const addTask = (dischargeId: string, input: { type: string; title: string; ownerRole: string; dueMinutes: number }) =>
    run(() => request(`/discharges/${dischargeId}/tasks`, { method: 'POST', body: input }));

  const taskAction = (task: Task, action: 'claim' | 'complete' | 'cancel') =>
    run(() => request(`/tasks/${task.id}`, { method: 'PATCH', body: { action } }));

  if (loadError) return <p className="alert">{loadError}</p>;
  if (!data) return <p className="muted">Loading discharges…</p>;

  const eligible = data.encounters.filter((encounter) => !encounter.discharge_id);
  const d = detail.data?.discharge ?? null;

  return (
    <div className="split-wide">
      <section className="panel">
        <header className="panel-head">
          <h2>Discharges</h2>
          <button className="primary" onClick={() => setAdmission((current) => ({ ...current, open: !current.open }))}>
            New discharge
          </button>
        </header>
        {error && <p className="alert">{error}</p>}
        {admission.open && (
          <div className="subpanel">
            <h3>Start a discharge</h3>
            <ul className="list">
              {eligible.map((encounter) => (
                <li key={encounter.id}>
                  <span>{encounter.patient_name} <span className="muted small">{encounter.ward_name} · {encounter.bed_label ?? 'no bed'}</span></span>
                  <button className="link" disabled={busy} onClick={() => void startDischarge(encounter)}>Initiate</button>
                </li>
              ))}
              {eligible.length === 0 && <li className="muted">No admitted patients without a discharge.</li>}
            </ul>
          </div>
        )}
        <table className="table clickable">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Location</th>
              <th>State</th>
              <th>Tasks</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.discharges.map((discharge) => (
              <tr
                key={discharge.id}
                className={selected === discharge.id ? 'selected' : ''}
                onClick={() => setSelected(discharge.id)}
              >
                <td>{discharge.patient_name}</td>
                <td className="muted">{discharge.ward_name} · {discharge.bed_label ?? '—'}</td>
                <td><StateChip state={discharge.state} /></td>
                <td>
                  {discharge.open_tasks > 0
                    ? <span className={discharge.blocking_tasks > 0 ? 'chip chip-warn' : 'chip chip-ghost'}>{discharge.open_tasks} open</span>
                    : <span className="chip chip-good">clear</span>}
                </td>
                <td className="muted small">{timeAgo(discharge.initiated_at)}</td>
                <td>
                  <button
                    className="link"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelected(discharge.id);
                    }}
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <aside className="panel detail">
        {!selected && <p className="muted">Select a discharge to see the handoff checklist.</p>}
        {detail.error && <p className="alert">{detail.error}</p>}
        {d && (
          <>
            <header className="panel-head">
              <div>
                <h2>{d.patient_name}</h2>
                <span className="muted small">{d.ward_name} · bed {d.bed_label ?? '—'}</span>
              </div>
              <StateChip state={d.state} />
            </header>

            <ol className="timeline">
              <TimelineStep active={d.state} value="INITIATED" text="Discharge initiated" at={d.initiated_at} />
              <TimelineStep active={d.state} value="MEDICALLY_CLEARED" text="Medically cleared" at={d.cleared_at} />
              <TimelineStep active={d.state} value="TASKS_PENDING" text="Handoff tasks created" at={null} />
              <TimelineStep active={d.state} value="READY_TO_DEPART" text="Ready to depart" at={d.ready_at} />
              <TimelineStep active={d.state} value="DEPARTED" text="Departed" at={d.departed_at} />
            </ol>

            <div className="actions">
              {NEXT[d.state] && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void advance(d, NEXT[d.state]!.target)}
                >
                  {NEXT[d.state]!.text}
                </button>
              )}
              {!['DEPARTED', 'CANCELLED'].includes(d.state) && (
                <button className="ghost" disabled={busy} onClick={() => cancel(d)}>Cancel discharge</button>
              )}
            </div>

            <h3>Handoff tasks</h3>
            <ul className="task-list">
              {(detail.data?.tasks ?? []).map((task) => (
                <li key={task.id} className={task.status === 'DONE' ? 'task-done' : ''}>
                  <div>
                    <strong>{task.title}</strong>
                    <span className="muted small"> {task.owner_role} · due {new Date(task.due_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{task.blocking ? ' · blocking' : ''}</span>
                  </div>
                  <div className="row-actions">
                    <span className={`chip chip-${task.status === 'DONE' ? 'good' : task.status === 'OPEN' ? 'warn' : 'info'}`}>{label(task.status)}</span>
                    {task.status === 'OPEN' && (
                      <button className="link" disabled={busy} onClick={() => void taskAction(task, 'claim')}>Claim</button>
                    )}
                    {['OPEN', 'CLAIMED'].includes(task.status) && (
                      <button className="link" disabled={busy} onClick={() => void taskAction(task, 'complete')}>Complete</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {!['DEPARTED', 'CANCELLED'].includes(d.state) && (
              <AddTask busy={busy} onAdd={(input) => addTask(d.id, input)} />
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function StateChip({ state }: { state: DischargeState }): JSX.Element {
  const tone = state === 'READY_TO_DEPART' || state === 'DEPARTED'
    ? 'good'
    : state === 'TASKS_PENDING' || state === 'CANCELLED'
      ? 'warn'
      : 'info';
  return <span className={`chip chip-${tone}`}>{label(state)}</span>;
}

function TimelineStep({ active, value, text, at }: { active: string; value: string; text: string; at: string | null }): JSX.Element {
  const order = ['INITIATED', 'MEDICALLY_CLEARED', 'TASKS_PENDING', 'READY_TO_DEPART', 'DEPARTED'];
  const done = order.indexOf(active) >= order.indexOf(value) && !['CANCELLED'].includes(active);
  return (
    <li className={done ? 'step done' : 'step'}>
      <span className="dot" />
      <div>
        <strong>{text}</strong>
        <span className="muted small"> {at ? new Date(at).toLocaleString() : done ? '' : 'pending'}</span>
      </div>
    </li>
  );
}

function AddTask({ busy, onAdd }: { busy: boolean; onAdd: (input: { type: string; title: string; ownerRole: string; dueMinutes: number }) => void }): JSX.Element {
  const [title, setTitle] = useState('');
  const [ownerRole, setOwnerRole] = useState('pharmacy');
  return (
    <form
      className="add-task"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) return;
        onAdd({ type: ownerRole.toUpperCase(), title: title.trim(), ownerRole, dueMinutes: 60 });
        setTitle('');
      }}
    >
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add a handoff task…" />
      <select value={ownerRole} onChange={(event) => setOwnerRole(event.target.value)}>
        {['pharmacy', 'billing', 'clinical', 'transport', 'housekeeping', 'coordinator'].map((role) => (
          <option key={role} value={role}>{role}</option>
        ))}
      </select>
      <button className="primary" disabled={busy}>Add</button>
    </form>
  );
}
