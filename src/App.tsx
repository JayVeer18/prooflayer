import type { ReactNode } from 'react';
import Finding from './screens/Finding';
import Landing from './screens/Landing';
import Live from './screens/Live';
import NewAssessment from './screens/NewAssessment';
import { Assessments, Library, Settings } from './screens/Others';
import Plan from './screens/Plan';
import Report from './screens/Report';
import Results from './screens/Results';
import { ArgusMark, ThemeToggle } from './ui';
import { useAssessment, type A } from './useAssessment';
import type { Route } from './types';

const MAIN: Array<[Route, string, string]> = [
  ['landing', '⌂', 'Overview'],
  ['new', '＋', 'New Assessment'],
  ['assessments', '▣', 'Assessments'],
  ['library', '◇', 'Claim Library'],
  ['settings', '⚙', 'Settings'],
];

function Sidebar({ a }: { a: A }) {
  const item = (r: Route, icon: string, label: string, disabled = false) => (
    <button key={r + label} className={`nav ${a.route === r ? 'on' : ''}`} onClick={() => a.setRoute(r)} disabled={disabled} aria-current={a.route === r ? 'page' : undefined}>
      <i>{icon}</i>
      <span>{label}</span>
    </button>
  );
  return (
    <aside className="sidebar">
      <button className="brand" onClick={() => a.setRoute('landing')} aria-label="Argus — go to home">
        <span className="brand-top"><ArgusMark size={22} /><b>ARGUS</b></span>
        <span>Executable due diligence</span>
      </button>
      <nav>{MAIN.map(([r, i, l]) => item(r, i, l))}</nav>
      {a.hasSession && (
        <>
          <div className="nav-h">Active assessment</div>
          <nav>
            {item('live', '●', 'Live Execution')}
            {item('plan', '☰', 'Plan', a.plan.length === 0)}
            {item('results', '◧', 'Results', !a.done)}
            {item('finding', '◎', 'Evidence', a.findings.length === 0)}
            {item('report', '❒', 'Report', !a.done)}
          </nav>
        </>
      )}
      <div className="side-foot">
        <ThemeToggle />
        <span className="muted">Powered by Tencent EdgeOne Makers</span>
      </div>
    </aside>
  );
}

function Screen({ a }: { a: A }): ReactNode {
  switch (a.route) {
    case 'landing': return <Landing a={a} />;
    case 'new': return <NewAssessment a={a} />;
    case 'plan': return <Plan a={a} />;
    case 'live': return <Live a={a} />;
    case 'results': return <Results a={a} />;
    case 'finding': return <Finding a={a} />;
    case 'report': return <Report a={a} />;
    case 'assessments': return <Assessments a={a} />;
    case 'library': return <Library a={a} />;
    case 'settings': return <Settings a={a} />;
  }
}

export default function App() {
  const a = useAssessment();
  return (
    <div className="app">
      <Sidebar a={a} />
      <main className="main">
        <Screen a={a} />
      </main>
    </div>
  );
}
