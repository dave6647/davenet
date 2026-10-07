import { useState } from 'react';
import { api } from './api.ts';
import { useAction, Badge } from './components/ui.tsx';
import { NewJobDialog } from './pages/Jobs.tsx';
import { useApi, useLiveStatus } from './live.ts';
import { MetaProvider } from './meta.tsx';
import { useRoute } from './router.ts';
import { Dashboard } from './pages/Dashboard.tsx';
import { Organisation } from './pages/Organisation.tsx';
import { AgentPage } from './pages/AgentPage.tsx';
import { Providers } from './pages/Providers.tsx';
import { ProviderPage } from './pages/ProviderPage.tsx';
import { Jobs } from './pages/Jobs.tsx';
import { JobPage } from './pages/JobPage.tsx';
import { Opportunities } from './pages/Opportunities.tsx';
import { OpportunityPage } from './pages/OpportunityPage.tsx';
import { Approvals } from './pages/Approvals.tsx';
import { Finance } from './pages/Finance.tsx';
import { Portfolio } from './pages/Portfolio.tsx';
import { Triggers } from './pages/Triggers.tsx';
import { Memory } from './pages/Memory.tsx';
import { Audit } from './pages/Audit.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

interface EngineState {
  paused: boolean;
  running: number;
  max_concurrent: number;
  pending_approvals: number;
}

const NAV: { path: string; label: string; match: string[] }[] = [
  { path: '/', label: 'Übersicht', match: [''] },
  { path: '/organisation', label: 'Organisation', match: ['organisation', 'agents'] },
  { path: '/providers', label: 'Provider & Modelle', match: ['providers'] },
  { path: '/jobs', label: 'Jobs', match: ['jobs'] },
  { path: '/opportunities', label: 'Opportunities', match: ['opportunities'] },
  { path: '/approvals', label: 'Freigaben', match: ['approvals'] },
  { path: '/portfolio', label: 'Portfolio & Erträge', match: ['portfolio'] },
  { path: '/finance', label: 'Kosten & Kontingente', match: ['finance'] },
  { path: '/triggers', label: 'Trigger', match: ['triggers'] },
  { path: '/memory', label: 'Gedächtnis', match: ['memory'] },
  { path: '/audit', label: 'Audit-Log', match: ['audit'] },
  { path: '/settings', label: 'Einstellungen', match: ['settings'] },
];

function Shell() {
  const route = useRoute();
  const engine = useApi<EngineState>('/api/engine', ['job', 'approval', 'settings']);
  const live = useLiveStatus();
  const { run, busy } = useAction();
  const [directive, setDirective] = useState(false);
  const section = route.parts[0] ?? '';

  const toggleEngine = () =>
    run(async () => {
      await api.post(engine.data?.paused ? '/api/engine/resume' : '/api/engine/pause');
      engine.reload();
    }, engine.data?.paused ? 'Engine läuft wieder' : 'Engine pausiert');

  let page;
  switch (section) {
    case '':
      page = <Dashboard />;
      break;
    case 'organisation':
      page = <Organisation />;
      break;
    case 'agents':
      page = <AgentPage id={route.parts[1]} />;
      break;
    case 'providers':
      page = route.parts[1] ? <ProviderPage id={route.parts[1]} /> : <Providers />;
      break;
    case 'jobs':
      page = route.parts[1] ? <JobPage id={Number(route.parts[1])} /> : <Jobs />;
      break;
    case 'opportunities':
      page = route.parts[1] ? <OpportunityPage id={route.parts[1]} /> : <Opportunities />;
      break;
    case 'approvals':
      page = <Approvals />;
      break;
    case 'finance':
      page = <Finance />;
      break;
    case 'portfolio':
      page = <Portfolio />;
      break;
    case 'triggers':
      page = <Triggers />;
      break;
    case 'memory':
      page = <Memory />;
      break;
    case 'audit':
      page = <Audit />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    default:
      page = <div className="empty">Seite nicht gefunden</div>;
  }

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-logo">D</span> Davenet
        </div>
        {NAV.map((n, i) => (
          <div key={n.path}>
            {(i === 3 || i === 7 || i === 9) && <div className="nav-sep" />}
            <a href={`#${n.path}`} className={`nav-item ${n.match.includes(section) ? 'active' : ''}`}>
              {n.label}
              {n.path === '/approvals' && engine.data?.pending_approvals ? <span className="nav-count">{engine.data.pending_approvals}</span> : null}
            </a>
          </div>
        ))}
      </nav>
      <div className="main">
        <header className="topbar">
          <span className={`dot ${live ? 'ok' : 'err'}`} title={live ? 'Live-Verbindung aktiv' : 'Keine Live-Verbindung'} />
          {engine.data && (
            <>
              {engine.data.paused ? <Badge kind="warn">Engine pausiert</Badge> : <Badge kind="ok">Engine aktiv</Badge>}
              <span className="muted small">
                {engine.data.running} von {engine.data.max_concurrent} Jobs laufen
              </span>
            </>
          )}
          <div className="spacer" />
          <button onClick={() => setDirective(true)} className="primary">
            Auftrag erteilen
          </button>
          <button onClick={toggleEngine} disabled={busy || !engine.data}>
            {engine.data?.paused ? 'Engine fortsetzen' : 'Engine pausieren'}
          </button>
        </header>
        <main className="content">{page}</main>
      </div>
      {directive && <NewJobDialog initialType="owner_directive" onClose={() => setDirective(false)} />}
    </div>
  );
}

export function App() {
  return (
    <MetaProvider>
      <Shell />
    </MetaProvider>
  );
}
