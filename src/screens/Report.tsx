import { STATUS, groupByClaim, hhmmss } from '../model';
import { Badge } from '../ui';
import type { A } from '../useAssessment';

function download(a: A) {
  const body = {
    tool: 'ProofLayer',
    type: 'Evidence-backed behavioral assessment (not a certification)',
    generatedAt: new Date().toISOString(),
    product: a.form.targetUrl,
    summary: a.done?.narrative,
    counts: a.done?.counts,
    findings: a.findings,
    executionTrace: a.trace,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
  const el = document.createElement('a');
  el.href = url;
  el.download = 'prooflayer-assessment.json';
  el.click();
  URL.revokeObjectURL(url);
}

export default function Report({ a }: { a: A }) {
  if (!a.done) {
    return (
      <div className="page-body narrow">
        <h2>Report</h2>
        <p className="muted">The report is available once an assessment completes.</p>
      </div>
    );
  }
  const rows = groupByClaim(a.findings);
  const unverified = a.findings.filter((f) => ['NOT_VERIFIED', 'INCONCLUSIVE', 'NEEDS_HUMAN_REVIEW'].includes(f.status));
  const approvals = a.findings.filter((f) => f.approval);
  let host = a.form.targetUrl;
  try { host = new URL(a.form.targetUrl).host; } catch { /* keep raw */ }

  return (
    <div className="page-body report">
      <div className="report-bar no-print">
        <button className="link" onClick={() => a.setRoute('results')}>← Results</button>
        <span className="grow" />
        <button className="ghost" onClick={() => window.print()}>Print / Save as PDF</button>
        <button className="primary" onClick={() => download(a)}>Export Assessment</button>
      </div>

      <div className="eyebrow">Assessment report</div>
      <h2>Evidence-backed behavioral assessment</h2>
      <p className="fine left">This is not a certification. It records what ProofLayer observed while using the product on the date below.</p>

      <dl className="rmeta">
        <dt>Product</dt><dd>{host}{a.replay ? ' · recorded run of the demo target' : ''}</dd>
        <dt>Assessment date</dt><dd>{new Date(a.startedAt || Date.now()).toUTCString()}</dd>
        <dt>Claims evaluated</dt><dd>{rows.length}</dd>
        <dt>Tests performed</dt><dd>{a.findings.filter((f) => f.testStatus !== 'SKIPPED').length}</dd>
      </dl>

      <h3 className="sect">Summary</h3>
      <p className="narr">{a.done.narrative}</p>

      <h3 className="sect">Findings</h3>
      {a.findings.map((f) => {
        const shot = a.shots[f.evidence.screenshotIds[f.evidence.screenshotIds.length - 1]];
        return (
          <article key={f.id} className="rfind">
            <header><Badge status={f.status} /><b>{f.title}</b><span className="muted">“{f.claim}”</span></header>
            <p><b>Expected</b> {f.expected}</p>
            <p><b>Observed</b> {f.observed}</p>
            <p className="fine left">Evidence: {f.evidence.route || 'n/a'} · {hhmmss(f.evidence.timestamp)} UTC · trace {f.evidence.traceRef} · {STATUS[f.status].blurb}</p>
            {shot && <img src={shot.src} alt={shot.label} />}
          </article>
        );
      })}

      <h3 className="sect">Human approvals</h3>
      <ul className="plainlist">
        <li>The assessment plan was reviewed and approved before any test ran.</li>
        {approvals.map((f) => <li key={f.id}>{f.title}: {f.approval!.decision === 'run' ? 'approved' : 'skipped'}{f.approval!.modified ? ' with a modified test' : ''} at {hhmmss(f.approval!.at)} UTC.</li>)}
      </ul>

      <h3 className="sect">Unverified claims</h3>
      {unverified.length ? (
        <ul className="plainlist">
          {unverified.map((f) => <li key={f.id}><b>{f.claim}</b> — {STATUS[f.status].label}. {f.recommendation ?? f.observed}</li>)}
        </ul>
      ) : <p className="muted">None.</p>}

      {a.trace.length > 0 && (
        <>
          <h3 className="sect">Execution trace</h3>
          <div className="tracebox">{a.trace.map((t) => <div key={t.id} className={`ln tk-${t.kind}`}><span>{t.kind}</span>{t.text}</div>)}</div>
        </>
      )}
    </div>
  );
}
