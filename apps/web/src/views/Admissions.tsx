import { useState } from 'react';
import { ApiError, request } from '../api';
import { usePolling } from '../lib';
import type { Bed, Encounter } from '../types';

export function Admissions(): JSX.Element {
  const [name, setName] = useState('');
  const [sex, setSex] = useState('female');
  const [bedId, setBedId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, error: loadError, refresh } = usePolling(async () => {
    const [beds, encounters] = await Promise.all([
      request<Bed[]>('/beds?state=AVAILABLE'),
      request<Encounter[]>('/encounters?status=EXPECTED'),
    ]);
    return { beds, encounters };
  }, 8000);

  const admit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !bedId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const bed = data?.beds.find((item) => item.id === bedId);
      const patient = await request<{ patientId: string }>('/patients', {
        method: 'POST',
        body: { displayName: name.trim(), sex },
      });
      const encounter = await request<{ encounterId: string }>('/encounters', {
        method: 'POST',
        body: { patientId: patient.patientId, wardId: bed?.ward_id },
      });
      const reservation = await request<{ reservationId: string }>('/reservations', {
        method: 'POST',
        body: { bedId },
      });
      await request(`/reservations/${reservation.reservationId}/confirm`, {
        method: 'POST',
        body: { encounterId: encounter.encounterId },
      });
      setResult(`${name.trim()} admitted to bed ${bed?.label ?? ''} (${bed?.ward_name ?? ''}).`);
      setName('');
      setBedId('');
      refresh();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Admission failed');
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <p className="alert">{loadError}</p>;

  return (
    <div className="split">
      <section className="panel">
        <header className="panel-head">
          <h2>Admit a patient</h2>
          <span className="muted">Reserves the bed, confirms the admission</span>
        </header>
        {error && <p className="alert">{error}</p>}
        {result && <p className="ok">{result}</p>}
        <form className="form" onSubmit={admit}>
          <label>
            Patient name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Anika Roy" />
          </label>
          <label>
            Sex
            <select value={sex} onChange={(event) => setSex(event.target.value)}>
              <option value="female">female</option>
              <option value="male">male</option>
              <option value="other">other</option>
            </select>
          </label>
          <label>
            Available bed
            <select value={bedId} onChange={(event) => setBedId(event.target.value)}>
              <option value="">Select a bed…</option>
              {(data?.beds ?? []).map((bed) => (
                <option key={bed.id} value={bed.id}>{bed.ward_name} · {bed.label}</option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={busy}>{busy ? 'Admitting…' : 'Admit patient'}</button>
        </form>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Expected arrivals</h2>
          <span className="muted">Encounters waiting for a bed</span>
        </header>
        <ul className="list">
          {(data?.encounters ?? []).map((encounter) => (
            <li key={encounter.id}>
              <span>{encounter.patient_name}<span className="muted small"> {encounter.ward_name}</span></span>
              <span className="chip chip-neutral">expected</span>
            </li>
          ))}
          {(data?.encounters ?? []).length === 0 && <li className="muted">No expected arrivals.</li>}
        </ul>
      </section>
    </div>
  );
}
