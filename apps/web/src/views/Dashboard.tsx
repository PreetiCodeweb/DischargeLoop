import { request } from '../api';
import { label, usePolling } from '../lib';
import type { Analytics, Discharge, Ward } from '../types';

export function Dashboard(): JSX.Element {
  const { data, error } = usePolling(async () => {
    const [wards, analytics, discharges] = await Promise.all([
      request<Ward[]>('/wards'),
      request<Analytics>('/analytics'),
      request<Discharge[]>('/discharges'),
    ]);
    return { wards, analytics, discharges };
  });

  if (error) return <p className="alert">{error}</p>;
  if (!data) return <p className="muted">Loading ward status…</p>;

  const { wards, analytics, discharges } = data;
  const inFlight = discharges.filter((item) => !['DEPARTED', 'CANCELLED'].includes(item.state));
  const bedStates = analytics.beds;

  return (
    <div className="stack">
      <section className="kpi-row">
        <Kpi title="Occupancy" value={`${analytics.occupancyRate}%`} note={`${bedStates.OCCUPIED ?? 0} of ${analytics.totalBeds} beds occupied`} />
        <Kpi title="Beds ready" value={String(bedStates.AVAILABLE ?? 0)} note={`${bedStates.CLEANING ?? 0} awaiting clean verification`} />
        <Kpi title="Open tasks" value={String(analytics.openTasks)} note={`${analytics.overdueTasks} overdue`} accent={analytics.overdueTasks > 0} />
        <Kpi title="In-flight discharges" value={String(inFlight.length)} note={`${analytics.departedLast30Days} departures in 30 days`} />
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Ward capacity</h2>
          <span className="muted">Live bed counts by ward</span>
        </header>
        <table className="table">
          <thead>
            <tr>
              <th>Ward</th>
              <th>Beds</th>
              <th>Occupied</th>
              <th>Available</th>
              <th>Cleaning</th>
              <th>Blocked / maintenance</th>
              <th>Occupancy</th>
            </tr>
          </thead>
          <tbody>
            {wards.map((ward) => {
              const used = ward.occupied + ward.cleaning + ward.unavailable;
              const rate = Math.round((used / Math.max(ward.bed_count, 1)) * 100);
              return (
                <tr key={ward.id}>
                  <td><strong>{ward.name}</strong><span className="chip chip-ghost">{ward.code}</span></td>
                  <td>{ward.bed_count}</td>
                  <td>{ward.occupied}</td>
                  <td>{ward.available}</td>
                  <td>{ward.cleaning}</td>
                  <td>{ward.unavailable}</td>
                  <td>
                    <div className="bar" role="img" aria-label={`${rate}% occupancy`}>
                      <span style={{ width: `${Math.min(rate, 100)}%` }} />
                    </div>
                    <span className="muted small">{rate}%</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <div className="split">
        <section className="panel">
          <header className="panel-head">
            <h2>Discharges in progress</h2>
            <span className="muted">Click Discharges to advance a case</span>
          </header>
          <ul className="list">
            {inFlight.slice(0, 6).map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.patient_name}</strong>
                  <span className="muted small"> {item.ward_name} · {item.bed_label ?? 'no bed'}</span>
                </div>
                <span className={`chip ${item.state === 'READY_TO_DEPART' ? 'chip-good' : item.state === 'TASKS_PENDING' ? 'chip-warn' : 'chip-info'}`}>
                  {label(item.state)}
                </span>
              </li>
            ))}
            {inFlight.length === 0 && <li className="muted">No discharges in progress.</li>}
          </ul>
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>Bed pipeline</h2>
            <span className="muted">State distribution</span>
          </header>
          <ul className="list">
            {Object.entries(bedStates).map(([state, count]) => (
              <li key={state}>
                <span>{label(state)}</span>
                <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {analytics.expiringReservations.length > 0 && (
        <section className="panel">
          <header className="panel-head">
            <h2>Reservations expiring soon</h2>
            <span className="muted">Hold released automatically by the TTL worker</span>
          </header>
          <ul className="list">
            {analytics.expiringReservations.map((reservation) => (
              <li key={reservation.id}>
                <span>{reservation.ward_name} · bed {reservation.bed_label}</span>
                <span className="chip chip-warn">{new Date(reservation.expires_at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Kpi({ title, value, note, accent }: { title: string; value: string; note: string; accent?: boolean }): JSX.Element {
  return (
    <article className={`kpi ${accent ? 'kpi-accent' : ''}`}>
      <span className="kpi-title">{title}</span>
      <strong className="kpi-value">{value}</strong>
      <span className="kpi-note">{note}</span>
    </article>
  );
}
