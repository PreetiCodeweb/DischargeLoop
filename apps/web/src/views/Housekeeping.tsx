import { useState } from 'react';
import { ApiError, request, type Session } from '../api';
import { label, timeAgo, usePolling } from '../lib';
import type { CleaningJob } from '../types';

export function Housekeeping({ session }: { session: Session }): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, error: loadError, refresh } = usePolling(() => request<CleaningJob[]>('/cleaning'), 5000);

  const act = async (id: string, action: 'accept' | 'verify') => {
    setBusy(id + action);
    setError(null);
    try {
      await request(`/cleaning/${id}/${action}`, { method: 'POST' });
      refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <p className="alert">{loadError}</p>;

  const jobs = data ?? [];
  const open = jobs.filter((job) => job.status === 'OPEN');
  const accepted = jobs.filter((job) => job.status === 'ACCEPTED');

  return (
    <div className="stack">
      <section className="panel">
        <header className="panel-head">
          <h2>Housekeeping queue</h2>
          <span className="muted">{open.length} to accept · {accepted.length} awaiting verification</span>
        </header>
        <p className="muted small">
          Signed in as {session.actor.name}. Verification must be done by a second person — the bed manager signs in
          separately to release the bed.
        </p>
        {error && <p className="alert">{error}</p>}
        {jobs.length === 0 && <p className="muted">No dirty beds. Everything is clean.</p>}
        <div className="bed-grid">
          {jobs.map((job) => (
            <article key={job.id} className="bed-tile bed-cleaning">
              <header>
                <strong>{job.bed_label}</strong>
                <span className={`chip chip-${job.status === 'ACCEPTED' ? 'warn' : 'info'}`}>{label(job.status)}</span>
              </header>
              <p className="bed-patient">{job.ward_name}</p>
              <footer>
                <span className="muted small">requested {timeAgo(job.requested_at)}</span>
                <span className="bed-actions">
                  {job.status === 'OPEN' && (
                    <button className="link" disabled={busy !== null} onClick={() => void act(job.id, 'accept')}>
                      Accept job
                    </button>
                  )}
                  {job.status === 'ACCEPTED' && (
                    <button className="link" disabled={busy !== null} onClick={() => void act(job.id, 'verify')}>
                      Verify clean
                    </button>
                  )}
                </span>
              </footer>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
