import { useState } from 'react';
import { readSession, writeSession, type Session } from './api';
import { Login } from './views/Login';
import { Dashboard } from './views/Dashboard';
import { BedBoard } from './views/BedBoard';
import { Discharges } from './views/Discharges';
import { Tasks } from './views/Tasks';
import { Housekeeping } from './views/Housekeeping';
import { Audit } from './views/Audit';
import { Admissions } from './views/Admissions';

type Page = 'dashboard' | 'beds' | 'discharges' | 'tasks' | 'housekeeping' | 'admissions' | 'audit';

const PAGES: Array<{ key: Page; text: string }> = [
  { key: 'dashboard', text: 'Overview' },
  { key: 'beds', text: 'Bed board' },
  { key: 'discharges', text: 'Discharges' },
  { key: 'tasks', text: 'Tasks' },
  { key: 'housekeeping', text: 'Housekeeping' },
  { key: 'admissions', text: 'Admissions' },
  { key: 'audit', text: 'Audit' },
];

export default function App(): JSX.Element {
  const [session, setSession] = useState<Session | null>(() => readSession());
  const [page, setPage] = useState<Page>('dashboard');

  if (!session) {
    return (
      <Login
        onSession={(next) => {
          setSession(next);
          setPage('dashboard');
        }}
      />
    );
  }

  const signOut = () => {
    writeSession(null);
    setSession(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); setPage('dashboard'); }}>
          <span className="brand-mark" aria-hidden="true">↻</span>
          <span>Discharge<span className="brand-accent">Loop</span></span>
        </a>
        <nav className="nav">
          {PAGES.map((item) => (
            <button
              key={item.key}
              className={page === item.key ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(item.key)}
            >
              {item.text}
            </button>
          ))}
        </nav>
        <div className="user">
          <span>{session.actor.name}</span>
          <span className="chip chip-ghost">{session.actor.roles.join(', ')}</span>
          <button className="link" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <main className="content">
        {page === 'dashboard' && <Dashboard />}
        {page === 'beds' && <BedBoard session={session} onOpenDischarge={() => setPage('discharges')} />}
        {page === 'discharges' && <Discharges session={session} />}
        {page === 'tasks' && <Tasks session={session} />}
        {page === 'housekeeping' && <Housekeeping session={session} />}
        {page === 'admissions' && <Admissions />}
        {page === 'audit' && <Audit />}
      </main>

      <footer className="footer">
        DischargeLoop · local-first discharge coordination · demo session as {session.persona}
      </footer>
    </div>
  );
}
