/** Shared types for the ProofLayer orchestrator (private module — not a route). */

export type ClaimStatus =
  | 'VERIFIED'
  | 'CONTRADICTED'
  | 'PARTIALLY_VERIFIED'
  | 'NOT_VERIFIED'
  | 'NEEDS_HUMAN_REVIEW';

export type TestStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'SKIPPED' | 'BLOCKED';
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type TemplateId =
  | 'auth_session'
  | 'rbac_direct_nav'
  | 'runtime_signals'
  | 'ai_data_protection'
  | 'unverifiable';

export type ClaimKey = 'rbac' | 'auth' | 'runtime' | 'ai' | 'train' | 'audit' | 'other';

export interface Claim {
  id: string;
  key: ClaimKey;
  text: string;
  source: 'vendor' | 'discovered' | 'baseline';
}

export interface Surface {
  name: string;
  path: string;
  title?: string;
  /** Link exists in the DOM but is not visible to the current role. */
  hidden?: boolean;
}

export interface PlanItem {
  id: string;
  claimId: string;
  claim: string;
  claimKey: ClaimKey;
  template: TemplateId;
  title: string;
  hypothesis: string;
  expected: string;
  rationale: string;
  priority: 'high' | 'medium' | 'low';
  requiresApproval: boolean;
  enabled: boolean;
}

export interface NetEvt {
  ts: string;
  method: string;
  url: string;
  status: number | null;
  kind: string;
  flag?: string;
}

export interface ConEvt {
  ts: string;
  type: string;
  text: string;
  flag?: string;
}

export interface Evidence {
  screenshotIds: string[];
  route: string;
  timestamp: string;
  network: NetEvt[];
  console: ConEvt[];
  traceRef: string;
}

export interface Finding {
  id: string;
  testId: string;
  claimId: string;
  claim: string;
  title: string;
  status: ClaimStatus;
  testStatus: TestStatus;
  severity: Severity;
  expected: string;
  observed: string;
  test: string;
  evidence: Evidence;
  recommendation?: string;
}

export interface Approval {
  decision: 'run' | 'skip';
  payload?: string;
}

export type Emit = (event: string, data: unknown) => void;
