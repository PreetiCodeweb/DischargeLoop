import { request } from '../api';
import { label, usePolling } from '../lib';
import type { AuditEvent } from '../types';

export function Audit(): JSX.Element {
  const { data, error } = usePolling(() => request<AuditEvent[]>('/audit?limit=100'), 8000);

  if (error) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted">Loading audit trail…</p>;

  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head">
          <h2>Audit trail</h2>
          <span className="muted">Append-only · {data.length} most recent events</span>
        </header>
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Actor role</th>
              <th>Transition</th>
            </tr>
          </thead>
          <tbody>
            {data.map((event) => {
              const before = event.before_state?.state as string | undefined;
              const after = event.after_state?.state as string | undefined;
              return (
                <tr key={event.id}>
                  <td className="muted small">{new Date(event.occurred_at).toLocaleString()}</td>
                  <td><code>{event.action}</code></td>
                  <td>{event.entity_type}<span className="muted small"> …{event.entity_id.slice(-6)}</span></td>
                  <td>{event.actor_role}</td>
                  <td>{before || after ? `${before ? label(before) : '—'} → ${after ? label(after) : '—'}` : '—'}</td>
                </tr>
              );
            })}
            {data.length === 0 && <tr><td colSpan={5} className="muted">No audit events yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
