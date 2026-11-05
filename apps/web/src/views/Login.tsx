import { useEffect, useState } from 'react';
import { ApiError, signIn, type Session } from '../api';
import type { Persona } from '../types';

const ROLE_HINT: Record<string, string> = {
  admin: 'Hospital operations · full visibility',
  admission: 'Front desk · admit and assign beds',
  clinical: 'Doctor · medical clearance and lab tasks',
  coordinator: 'Discharge coordinator · runs the loop',
  housekeeping: 'Housekeeping · accepts bed cleans',
  bed_manager: 'Bed manager · verifies clean beds',
  pharmacy: 'Pharmacy · medication reconciliation',
  billing: 'Billing · insurance clearance',
  transport: 'Transport · departure booking',
  auditor: 'Auditor · read-only trail',
};

export function Login({ onSession }: { onSession: (session: Session) => void }): JSX.Element {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/dev/personas')
      .then(async (response) => {
        if (!response.ok) throw new Error('Development sign-in is not enabled on the API.');
        return response.json() as Promise<{ personas: Persona[] }>;
      })
      .then((body) => setPersonas(body.personas))
      .catch((caught: Error) => setError(caught.message));
  }, []);

  const start = async (persona: Persona) => {
    setBusy(persona.key);
    setError(null);
    try {
      onSession(await signIn(persona.key));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in');
      setBusy(null);
    }
  };

  return (
    <div className="login">
      <div className="login-brand">
        <span className="brand-mark" aria-hidden="true">↻</span>
        <span>Discharge<span className="brand-accent">Loop</span></span>
      </div>
      <h1>Sign in to the hospital workspace</h1>
      <p className="muted">
        Choose a role to start a local demo session. Each role only sees the handoffs it owns.
      </p>
      {error && <p className="alert">{error}</p>}
      <div className="persona-grid">
        {personas.map((persona) => (
          <button
            key={persona.key}
            className="persona-card"
            onClick={() => void start(persona)}
            disabled={busy !== null}
          >
            <span className="persona-avatar">{persona.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
            <span className="persona-name">{persona.name}</span>
            <span className="persona-role">{ROLE_HINT[persona.key] ?? persona.roles.join(' · ')}</span>
            <span className="persona-key">{busy === persona.key ? 'Signing in…' : persona.key}</span>
          </button>
        ))}
        {personas.length === 0 && !error && <p className="muted">Loading roles…</p>}
      </div>
    </div>
  );
}
