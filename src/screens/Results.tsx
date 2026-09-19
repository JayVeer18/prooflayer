import { STATUS, STATUS_ORDER, groupByClaim } from '../model';
import { Badge, Stepper } from '../ui';
import type { A } from '../useAssessment';

export default function Results({ a }: { a: A }) {
  if (!a.done) {
    return (
      <div className="page-body narrow">
        <h2>Results</h2>
        <p className="muted">No completed assessment yet. Start one to see claim-level results here.</p>
        <button className="primary" onClick={() => a.setRoute('new')}>Start an Assessment</button>
      </div>
    );
  }
  const rows = groupByClaim(a.findings).sort((x, y) => STATUS_ORDER.indexOf(x.status) - STATUS_ORDER.indexOf(y.status));
  const heroShot = a.hero ? a.shots[a.hero.evidence.screenshotIds[a.hero.evidence.screenshotIds.length - 1]] : undefined;

  return (
    <div className="page-body wide">
      <Stepper status="FINDINGS" />
      <div className="eyebrow">Assessment complete</div>
      <div className="res-head">
        <h2>{a.done.total} claims evaluated</h2>
        <div className="counts">
          {STATUS_ORDER.filter((s) => a.done!.counts[s]).map((s) => (
            <span key={s} className={`count st-${STATUS[s].tone}`}><b>{a.done!.counts[s]}</b> {STATUS[s].label}</span>
          ))}
        </div>
      </div>
      <p className="narr">{a.done.narrative}</p>
      {a.fromHistory && <p className="fine left">Stored summary from an earlier session — screenshots are not kept after a session ends.</p>}

      {a.hero && (
        <section className="herocard">
          <div>
            <span className="sev">{a.hero.severity}</span>
            <h3>{STATUS[a.hero.status].headline}</h3>
            <dl>
              <dt>Vendor claim</dt><dd>{a.hero.claim}</dd>
              <dt>Expected</dt><dd>{a.hero.expected}</dd>
              <dt>Observed</dt><dd>{a.hero.observed}</dd>
            </dl>
            <button className="primary" onClick={() => a.openFinding(a.hero!.id)}>Inspect the proof →</button>
          </div>
          {heroShot && <img src={heroShot.src} alt="Evidence screenshot" />}
        </section>
      )}

      <h3 className="sect">Claim-level results</h3>
      <table className="rtable">
        <thead><tr><th>Claim</th><th>Tests</th><th>Result</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.claimId} onClick={() => a.openFinding(r.tests[0].id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && a.openFinding(r.tests[0].id)}>
              <td>{r.claim}</td>
              <td>{r.tests.length}</td>
              <td><Badge status={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine left">Claim-level results only. Argus does not compute an overall security score and does not call a product “safe” or “unsafe”.</p>

      <div className="actions">
        <button className="ghost" onClick={() => a.setRoute('new')}>New assessment</button>
        <button className="primary" onClick={() => a.setRoute('report')}>View report</button>
      </div>
    </div>
  );
}
