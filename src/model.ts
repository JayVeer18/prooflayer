import type { ClaimStatus, Finding, StoredAssessment } from './types';

export type Tone = 'ok' | 'bad' | 'warn' | 'gray' | 'info';

/** Claim-level status model. There is deliberately no overall "score". */
export const STATUS: Record<ClaimStatus, { label: string; tone: Tone; headline: string; blurb: string }> = {
  UNTESTED: { label: 'Untested', tone: 'gray', headline: 'NOT YET TESTED', blurb: 'No test has been planned for this claim.' },
  PLANNED: { label: 'Planned', tone: 'gray', headline: 'PLANNED', blurb: 'A test is planned and waiting for approval.' },
  EXECUTING: { label: 'Testing', tone: 'info', headline: 'TESTING', blurb: 'Argus is using the product right now.' },
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

/**
 * The demo target: our own deployed instance of OWASP Juice Shop, a widely-known, deliberately
 * vulnerable application maintained by OWASP for exactly this kind of known-answer testing. The
 * account below is a standard "customer" registration with no administrative rights — it is not a
 * privileged account, and it is not a real person's credentials.
 */
export const DEMO_TARGET = {
  url: 'https://juice-shop-production-4c88.up.railway.app/',
  username: 'argus.test@example.com',
  password: 'ArgusTest1!',
  name: 'OWASP Juice Shop',
};

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

/**
 * Plain-language vocabulary. The reader is a functional buyer — procurement, risk, GRC — not an
 * engineer, so the interface never shows raw protocol vocabulary where a plain phrase is just as
 * exact. The underlying values are unchanged and still visible in the exported report.
 */
export const STEP_KIND: Record<string, string> = {
  claim: 'Claim',
  hypothesis: 'Check',
  action: 'Did',
  observation: 'Saw',
  evidence: 'Captured',
  finding: 'Concluded',
};

/** Turns an HTTP status into what it means for the person reading the finding. */
export function describeStatus(status: number | null): string {
  if (status === null) return 'no response';
  if (status === 401 || status === 403) return `access denied (${status})`;
  if (status === 404) return `page not found (${status})`;
  if (status >= 500) return `product error (${status})`;
  if (status >= 300 && status < 400) return `sent elsewhere (${status})`;
  if (status >= 200 && status < 300) return `page loaded (${status})`;
  return String(status);
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
