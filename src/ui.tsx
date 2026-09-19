import type { ReactNode } from 'react';
import { STATUS } from './model';
import type { A } from './useAssessment';
import type { AssessmentStatus, ClaimStatus } from './types';

/**
 * The Argus mark: a circle (scope of observation) enclosing an eye (what was seen), with a single
 * point on the rim marking the captured moment. Strokes use currentColor so the mark inherits the
 * surrounding text colour in both the sidebar and the report header.
 */
export function ArgusMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth="2.6" />
      <path d="M3.6 24c7-8.4 13.8-12.6 20.4-12.6S37.4 15.6 44.4 24c-7 8.4-13.8 12.6-20.4 12.6S10.6 32.4 3.6 24Z" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
      <circle cx="24" cy="24" r="5.2" fill="currentColor" />
      <circle cx="24" cy="3" r="3.4" fill="currentColor" />
    </svg>
  );
}

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
    ['Session state', a.plan.length ? 'saved' : '…', a.plan.length > 0],
    ['Run reference', a.runId ? a.runId.slice(-10) : '…', Boolean(a.runId)],
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
