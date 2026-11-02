import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="DischargeLoop home">
          <span className="brand-mark" aria-hidden="true">↻</span>
          <span>Discharge<span className="brand-accent">Loop</span></span>
        </a>
        <span className="site-label">Hospital operations</span>
      </header>
      <section className="welcome" aria-labelledby="welcome-title">
        <p className="eyebrow">DISCHARGE COORDINATION</p>
        <h1 id="welcome-title">A clearer path from discharge to bed-ready.</h1>
        <p className="intro">Coordinate each handoff with clear ownership and verified bed status.</p>
        <div className="empty-state" role="status">
          <span className="empty-icon" aria-hidden="true">↗</span>
          <div>
            <strong>Workspace setup is underway</strong>
            <p>This installation has no patient, bed, or demo records.</p>
          </div>
        </div>
      </section>
      <footer>DischargeLoop · Local hospital deployment</footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
