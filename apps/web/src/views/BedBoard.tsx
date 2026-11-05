import { useState } from 'react';
import { ApiError, request, type Session } from '../api';
import { label, timeAgo, usePolling } from '../lib';
import type { Bed, Encounter, Ward } from '../types';

const ALL = 'ALL';

export function BedBoard({ session, onOpenDischarge }: { session: Session; onOpenDischarge: () => void }): JSX.Element {
  const [wardId, setWardId] = useState(ALL);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const query = wardId === ALL ? '' : `?wardId=${wardId}`;
  const { data, error: loadError, refresh } = usePolling(async () => {
    const [beds, wards, encounters] = await Promise.all([
      request<Bed[]>(`/beds${query}`),
      request<Ward[]>('/wards'),
      request<Encounter[]>('/encounters?status=ADMITTED'),
    ]);
    return { beds, wards, encounters };
  }, 6000);

  const act = async (key: string, path: string, method = 'POST') => {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await request(path, { method });
      setNote('Bed updated.');
      refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <p className="alert">{loadError}</p>;
  if (!data) return <p className="muted">Loading bed board…</p>;

  const byBed = new Map(data.encounters.filter((item) => item.bed_id).map((item) => [item.bed_id as string, item]));
  const wards = data.wards.filter((ward) => wardId === ALL || ward.id === wardId);

  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head">
          <h2>Bed board</h2>
          <select value={wardId} onChange={(event) => setWardId(event.target.value)}>
            <option value={ALL}>All wards</option>
            {data.wards.map((ward) => (
              <option key={ward.id} value={ward.id}>{ward.name}</option>
            ))}
          </select>
        </header>
        {error && <p className="alert">{error}</p>}
        {note && <p className="ok">{note}</p>}
        {wards.map((ward) => {
          const beds = data.beds.filter((bed) => bed.ward_id === ward.id);
          return (
            <div key={ward.id} className="ward-block">
              <h3>
                {ward.name} <span className="muted small">{ward.available} available · {ward.occupied} occupied · {ward.cleaning} cleaning</span>
              </h3>
              <div className="bed-grid">
                {beds.map((bed) => {
                  const encounter = byBed.get(bed.id);
                  return (
                    <article key={bed.id} className={`bed-tile bed-${bed.state.toLowerCase()}`}>
                      <header>
                        <strong>{bed.label}</strong>
                        <span className={`chip chip-${bed.state === 'AVAILABLE' ? 'good' : bed.state === 'OCCUPIED' ? 'info' : bed.state === 'CLEANING' || bed.state === 'RESERVED' ? 'warn' : 'bad'}`}>
                          {label(bed.state)}
                        </span>
                      </header>
                      <p className="bed-patient">
                        {encounter ? encounter.patient_name : bed.state === 'CLEANING' ? 'Awaiting housekeeping' : '—'}
                      </p>
                      <footer>
                        <span className="muted small">{timeAgo(bed.updated_at)}</span>
                        <span className="bed-actions">
                          {encounter && (
                            <button className="link" onClick={onOpenDischarge}>
                              {encounter.discharge_state ? label(encounter.discharge_state) : 'Start discharge'}
                            </button>
                          )}
                          {bed.state === 'AVAILABLE' && (
                            <button
                              className="link"
                              disabled={busy === bed.id}
                              onClick={() => void act(bed.id, `/beds/${bed.id}/block`)}
                            >
                              Block
                            </button>
                          )}
                          {bed.state === 'BLOCKED' && (
                            <button
                              className="link"
                              disabled={busy === bed.id}
                              onClick={() => void act(bed.id, `/beds/${bed.id}/unblock`)}
                            >
                              Unblock
                            </button>
                          )}
                          {bed.state === 'AVAILABLE' && (
                            <button
                              className="link"
                              disabled={busy === bed.id}
                              onClick={() => void act(bed.id, `/beds/${bed.id}/maintenance`)}
                            >
                              Maintenance
                            </button>
                          )}
                          {bed.state === 'MAINTENANCE' && (
                            <button
                              className="link"
                              disabled={busy === bed.id}
                              onClick={() => void act(bed.id, `/beds/${bed.id}/maintenance/complete`)}
                            >
                              Complete
                            </button>
                          )}
                        </span>
                      </footer>
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}
        <p className="muted small">Signed in as {session.actor.name} · ward scope: {session.actor.wardIds.length} wards</p>
      </section>
    </div>
  );
}
