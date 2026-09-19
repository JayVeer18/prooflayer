import type { ClaimStatus, Finding, StoredAssessment } from './types';

export type Tone = 'ok' | 'bad' | 'warn' | 'gray' | 'info';

/** Claim-level status model. There is deliberately no overall "score". */
export const STATUS: Record<ClaimStatus, { label: string; tone: Tone; headline: string; blurb: string }> = {
  UNTESTED: { label: 'Untested', tone: 'gray', headline: 'NOT YET TESTED', blurb: 'No test has been planned for this claim.' },
  PLANNED: { label: 'Planned', tone: 'gray', headline: 'PLANNED', blurb: 'A test is planned and waiting for approval.' },
  EXECUTING: { label: 'Testing', tone: 'info', headline: 'TESTING', blurb: 'ProofLayer is using the product right now.' },
  SUPPORTED: { label: 'Supported', tone: 'ok', headline: 'CLAIM SUPPORTED', blurb: 'The observed behavior matched the claim in this test.' },
  CONTRADICTED: { label: 'Contradicted', tone: 'bad', headline: 'CLAIM CONTRADICTED', blurb: 'The observed behavior contradicted the claim.' },
  PARTIALLY_VERIFIED: { label: 'Partially verified', tone: 'warn', headline: 'PARTIALLY VERIFIED', blurb: 'Part of the claim held; part did not.' },
  NOT_VERIFIED: { label: 'Not verified', tone: 'gray', headline: 'NOT VERIFIED', blurb: 'The available evidence does not establish this claim.' },
  INCONCLUSIVE: { label: 'Inconclusive', tone: 'info', headline: 'INCONCLUSIVE', blurb: 'The test could not be completed. No conclusion was made.' },
  NEEDS_HUMAN_REVIEW: { label: 'Needs human review', tone: 'info', headline: 'NEEDS HUMAN REVIEW', blurb: 'Judgment or more information is needed from a person.' },
};

export const STATUS_ORDER: ClaimStatus[] = ['CONTRADICTED', 'PARTIALLY_VERIFIED', 'INCONCLUSIVE', 'NEEDS_HUMAN_REVIEW', 'NOT_VERIFIED', 'SUPPORTED'];

/** Worst-case status wins when a claim has several tests. */
export function claimStatus(list: Finding[]): ClaimStatus {
  for (const s of STATUS_ORDER) if (list.some((f) => f.status === s)) return s;
  return 'UNTESTED';
}

export interface ClaimRow { claimId: string; claim: string; tests: Finding[]; status: ClaimStatus }

export function groupByClaim(findings: Finding[]): ClaimRow[] {
  const map = new Map<string, Finding[]>();
  for (const f of findings) map.set(f.claimId, [...(map.get(f.claimId) ?? []), f]);
  return [...map.entries()].map(([claimId, tests]) => ({ claimId, claim: tests[0].claim, tests, status: claimStatus(tests) }));
}

export const DEFAULT_CLAIMS = [
  'Enterprise-grade role-based access control',
  'Sensitive data is masked before it reaches the AI model',
  'Customer data is never used to train external AI models',
  'Full audit trail of user and admin actions',
];

export const CLAIM_TEMPLATES: Record<string, string[]> = {
  'Security & Access': ['Enterprise-grade role-based access control', 'Secure authentication and session management', 'Administrative features are restricted to administrators'],
  'Privacy & Data': ['Customer data is isolated between tenants', 'No sensitive data is exposed in the browser', 'Personal data is masked in logs'],
  'AI Governance': ['Sensitive data is masked before it reaches the AI model', 'Customer data is never used to train external AI models', 'Administrators control which AI features are enabled'],
  Compliance: ['Full audit trail of user and admin actions', 'SOC 2 controls are enforced in the product', 'Data retention settings are enforceable'],
  Custom: [],
};

const KEY = 'pl.assessments.v1';
/** Non-secret history only: no credentials, no screenshots. */
export function loadHistory(): StoredAssessment[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
export function saveHistory(entry: StoredAssessment): StoredAssessment[] {
  const all = [entry, ...loadHistory().filter((e) => e.id !== entry.id)].slice(0, 12);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable — history is a convenience only */
  }
  return all;
}

export const hhmmss = (ts: string) => (ts ? ts.slice(11, 19) : '');
export const pathOnly = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};
