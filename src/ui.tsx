import type { ReactNode } from 'react';
import { STATUS } from './model';
import type { A } from './useAssessment';
import type { AssessmentStatus, ClaimStatus } from './types';

export function Badge({ status }: { status: ClaimStatus }) {
  const s = STATUS[status];
  return <span className={`st st-${s.tone}`}>{s.label}</span>;
}

const STEPS = ['Discover', 'Plan', 'Approve', 'Execute', 'Prove'];
const STEP_INDEX: Partial<Record<AssessmentStatus, number>> = { DISCOVERY: 0, PLAN: 1, APPROVAL: 2, EXECUTION: 3, PAUSED: 3, FINDINGS: 5 };

/** Goal-gradient: always show where you are in PLAN → EXECUTE → PROVE. */
export function Stepper({ status }: { status: AssessmentStatus | null }) {
  const idx = status ? (STEP_INDEX[status] ?? 0) : 0;
  return (
    <ol className="stepper" aria-label="Assessment progress">
      {STEPS.map((s, i) => (
        <li key={s} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
          <i>{i < idx ? '✓' : i + 1}</i>
          {s}
        </li>
      ))}
    </ol>
  );
}

export function PlatformStrip({ a }: { a: A }) {
  const chips: Array<[string, string, boolean]> = [
    ['Agent runtime', a.replay ? 'recorded run' : 'Makers', true],
    ['Sandbox browser', a.live?.mode ?? '…', Boolean(a.live)],
    ['Model gateway', a.planSource?.model ?? 'plan templates', Boolean(a.planSource?.model)],
    ['Session state', a.plan.length ? 'checkpointed' : '…', a.plan.length > 0],
    ['Tracing', a.runId ? a.runId.slice(-10) : '…', Boolean(a.runId)],
  ];
  return (
    <div className="strip" title="Live values from this assessment">
      <span className="strip-l">TENCENT EDGEONE MAKERS</span>
      {chips.map(([k, v, on]) => (
        <span key={k} className={`sc ${on ? 'on' : ''}`}>
          <i />
          {k} <b>{v}</b>
        </span>
      ))}
    </div>
  );
}

export function BrowserFrame({ url, children, badge }: { url: string; children: ReactNode; badge?: ReactNode }) {
  return (
    <div className="bframe">
      <div className="bchrome">
        <span className="dots"><i /><i /><i /></span>
        <span className="burl">
          <span className="lock">●</span>
          {url || 'about:blank'}
        </span>
        {badge}
      </div>
      <div className="bview">{children}</div>
    </div>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="notice">{children}</div>;
}
