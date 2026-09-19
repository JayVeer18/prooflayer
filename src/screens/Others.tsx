import { CLAIM_TEMPLATES, STATUS, STATUS_ORDER } from '../model';
import type { A } from '../useAssessment';

export function Assessments({ a }: { a: A }) {
  return (
    <div className="page-body narrow">
      <div className="eyebrow">History</div>
      <h2>Assessments</h2>
      <p className="muted">Summaries only. Credentials and screenshots are never stored.</p>
      {a.hasSession && !a.fromHistory && (
        <button className="acard current" onClick={() => a.setRoute(a.done ? 'results' : 'live')}>
          <b>Current session</b>
          <span>{a.status === 'FINDINGS' ? 'Complete' : a.status}</span>
          <span className="muted">{a.form.targetUrl}</span>
        </button>
      )}
      {a.history.length === 0 && !a.hasSession && (
        <div className="empty-state">
          <p>No assessments yet.</p>
          <button className="primary" onClick={() => a.setRoute('new')}>Start an Assessment</button>
        </div>
      )}
      {a.history.map((h) => (
        <button key={h.id} className="acard" onClick={() => a.openHistory(h)}>
          <b>{(() => { try { return new URL(h.target).host; } catch { return h.target; } })()}{h.replay ? ' · recorded run' : ''}</b>
          <span className="muted">{new Date(h.at).toLocaleString()}</span>
          <span className="counts inline">
            {STATUS_ORDER.filter((s) => h.counts[s]).map((s) => <span key={s} className={`count sm st-${STATUS[s].tone}`}><b>{h.counts[s]}</b> {STATUS[s].label}</span>)}
          </span>
        </button>
      ))}
    </div>
  );
}

export function Library({ a }: { a: A }) {
  return (
    <div className="page-body narrow">
      <div className="eyebrow">Claim library</div>
      <h2>Claim Library</h2>
      <p className="muted">Common vendor claims Argus can turn into executable tests. Add any of them to a new assessment.</p>
      <div className="libgrid">
        {Object.entries(CLAIM_TEMPLATES).filter(([, v]) => v.length).map(([cat, claims]) => (
          <section key={cat} className="libcard">
            <h3>{cat}</h3>
            <ul>{claims.map((c) => <li key={c}>{c}</li>)}</ul>
            <button className="ghost sm" onClick={() => { a.addClaims(claims); a.setRoute('new'); }}>Add to new assessment</button>
          </section>
        ))}
      </div>
    </div>
  );
}

const POLICY: Array<[string, string, string]> = [
  ['SAFE', 'Runs automatically', 'Navigate, inspect, take screenshots, use synthetic data, log out.'],
  ['REVIEW', 'Waits for your decision', 'Changes settings or roles, creates accounts, submits data to another system, triggers external workflows.'],
  ['BLOCKED', 'Never runs', 'Payments, destructive or mass operations, anything outside the assessment scope.'],
];

export function Settings({ a }: { a: A }) {
  const p = a.probe;
  return (
    <div className="page-body narrow">
      <div className="eyebrow">Settings</div>
      <h2>Settings</h2>

      <section className="setcard">
        <h3>Action safety policy</h3>
        <p className="muted">Enforced in code on every run — the model cannot bypass it.</p>
        <table className="rtable static">
          <tbody>{POLICY.map(([k, t, d]) => <tr key={k}><td><span className={`risk r-${k}`}>{k}</span></td><td><b>{t}</b><br /><span className="muted">{d}</span></td></tr>)}</tbody>
        </table>
      </section>

      <section className="setcard">
        <h3>Data handling</h3>
        <ul className="plainlist">
          <li>Credentials exist only in memory for the session. They are never written to storage, logs, URLs, evidence or model prompts.</li>
          <li>Credential-like values in console output and URLs are masked before display.</li>
          <li>The model writes plan wording and summaries. Verdicts come from deterministic checks on observed evidence.</li>
        </ul>
      </section>

      <section className="setcard">
        <h3>Platform self-test</h3>
        <p className="muted">Checks the EdgeOne Makers capabilities Argus depends on.</p>
        <button className="ghost" onClick={a.runSelfTest} disabled={p?.running}>{p?.running ? 'Checking…' : 'Run self-test'}</button>
        {p && !p.running && (
          <div className="probe">
            {p.error ? p.error : (
              <>
                <b>{p.ok ? '✓ All platform checks passed' : '⚠ Some checks failed'}</b> · browser driver: {p.driverMode}
                {p.steps?.map((s: any) => <div key={s.name} className={s.ok ? 'ok' : 'bad'}>{s.ok ? '✓' : '✗'} {s.name} <span>{s.detail}</span></div>)}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
