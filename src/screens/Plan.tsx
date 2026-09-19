import { useState } from 'react';
import { Badge, Stepper } from '../ui';
import type { A } from '../useAssessment';

const RISK_LABEL: Record<string, string> = { SAFE: 'Safe', REVIEW: 'Needs your approval', BLOCKED: 'Blocked by policy' };

export default function Plan({ a }: { a: A }) {
  const [edit, setEdit] = useState(false);
  const enabled = a.plan.filter((p) => p.enabled).length;
  // Progressive disclosure: open the headline test (RBAC) only; the rest stay collapsed.
  const firstOpen = a.plan.find((p) => p.template === 'rbac_direct_nav')?.id ?? a.plan[0]?.id;

  return (
    <div className="page-body narrow">
      <Stepper status={a.status} />
      <div className="eyebrow">Assessment plan</div>
      <h2>Assessment Plan</h2>
      <p className="muted">
        We’ve converted your vendor claims into executable validation tests.{' '}
        {a.planSource?.source === 'model' ? `Wording drafted by ${a.planSource.model}.` : 'Built-in templates (model unavailable).'} Nothing runs until you approve.
      </p>

      <div className="chips">
        {a.surfaces.filter((s) => !s.hidden).map((s) => <span className="chip" key={s.path}>✓ {s.name || s.path}</span>)}
        {a.surfaces.filter((s) => s.hidden).map((s) => (
          <span className="chip warn" key={s.path} title="Present in the page source but hidden from this role">◐ {s.path} · hidden control</span>
        ))}
      </div>

      <div className="plan-head">
        <b>{enabled} tests</b> for {a.claims.length} claims
      </div>

      <div className="plan">
        {a.plan.map((p, i) => (
          <details key={p.id} className={`pitem ${p.enabled ? '' : 'off'}`} open={p.id === firstOpen}>
            <summary>
              {edit && <input type="checkbox" checked={p.enabled} onClick={(e) => e.stopPropagation()} onChange={() => a.toggle(p.id)} aria-label={`Include ${p.title}`} />}
              <span className="pn">{i + 1}</span>
              <span className="pt">{p.title}</span>
              <span className="pc">“{p.claim}”</span>
              <span className={`risk r-${p.risk}`}>{RISK_LABEL[p.risk]}</span>
              <Badge status="PLANNED" />
            </summary>
            <div className="pbody">
              <div className="chain">
                <div><b>Vendor claim</b><p>{p.claim}</p></div>
                <div><b>Test hypothesis</b><p>{p.hypothesis}</p></div>
                <div>
                  <b>Planned actions</b>
                  <ol>{p.procedure.map((s) => <li key={s}>{s}</li>)}</ol>
                </div>
                <div><b>Expected result</b><p>{p.expected}</p></div>
              </div>
              <p className="why">{p.rationale}</p>
            </div>
          </details>
        ))}
      </div>

      <div className="actions">
        <button className="ghost" onClick={() => a.setRoute('new')}>Back</button>
        <button className="ghost" onClick={() => setEdit((e) => !e)}>{edit ? 'Done editing' : 'Edit Plan'}</button>
        <button className="primary lg" disabled={a.busy || enabled === 0} onClick={a.startExecution}>
          Start Execution →
        </button>
      </div>
    </div>
  );
}
