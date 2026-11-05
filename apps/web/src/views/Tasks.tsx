import { useState } from 'react';
import { ApiError, request, type Session } from '../api';
import { timeAgo, usePolling } from '../lib';
import type { Task } from '../types';

type Row = Task & { overdue: boolean };

export function Tasks({ session }: { session: Session }): JSX.Element {
  const [role, setRole] = useState('mine');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const roles = session.actor.roles;
  const { data, error: loadError, refresh } = usePolling(async () => {
    const tasks = await request<Row[]>('/tasks');
    return tasks.filter((task) =>
      role === 'all' ? true : role === 'mine' ? roles.includes(task.owner_role) || roles.includes('admin') : task.owner_role === role,
    );
  }, 5000);

  const act = async (task: Row, action: 'claim' | 'complete') => {
    setBusy(task.id + action);
    setError(null);
    try {
      await request(`/tasks/${task.id}`, { method: 'PATCH', body: { action } });
      refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <p className="alert">{loadError}</p>;

  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head">
          <h2>Handoff tasks</h2>
          <select value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="mine">My roles</option>
            <option value="all">Everything</option>
            {['pharmacy', 'billing', 'clinical', 'transport', 'housekeeping', 'coordinator'].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </header>
        <p className="muted small">Signed in as {session.actor.name} · {roles.join(', ')}</p>
        {error && <p className="alert">{error}</p>}
        <table className="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Patient</th>
              <th>Owner</th>
              <th>Due</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((task) => (
              <tr key={task.id}>
                <td>
                  <strong>{task.title}</strong>
                  {task.blocking && <span className="chip chip-ghost">blocking</span>}
                </td>
                <td className="muted">{task.patient_name} · {task.ward_name}</td>
                <td>{task.owner_role}</td>
                <td className={task.overdue ? 'overdue' : 'muted small'}>{timeAgo(task.due_at)}</td>
                <td><span className={`chip chip-${task.status === 'OPEN' ? 'warn' : 'info'}`}>{task.status}</span></td>
                <td className="row-actions">
                  {task.status === 'OPEN' && (
                    <button className="link" disabled={busy !== null} onClick={() => void act(task, 'claim')}>Claim</button>
                  )}
                  <button className="link" disabled={busy !== null} onClick={() => void act(task, 'complete')}>Complete</button>
                </td>
              </tr>
            ))}
            {(data ?? []).length === 0 && (
              <tr><td colSpan={6} className="muted">No open tasks for this filter.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
