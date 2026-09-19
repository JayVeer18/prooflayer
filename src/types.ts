export type ClaimStatus =
  | 'UNTESTED'
  | 'PLANNED'
  | 'EXECUTING'
  | 'SUPPORTED'
  | 'CONTRADICTED'
  | 'PARTIALLY_VERIFIED'
  | 'NOT_VERIFIED'
  | 'INCONCLUSIVE'
  | 'NEEDS_HUMAN_REVIEW';
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type Risk = 'SAFE' | 'REVIEW' | 'BLOCKED';
export type AssessmentStatus = 'DISCOVERY' | 'PLAN' | 'APPROVAL' | 'EXECUTION' | 'PAUSED' | 'FINDINGS' | 'FAILED';

export interface Surface { name: string; path: string; title?: string; hidden?: boolean }
export interface Claim { id: string; key: string; text: string; source: 'vendor' | 'discovered' | 'baseline' }
export interface PlanItem {
  id: string; claimId: string; claim: string; claimKey: string; template: string; title: string;
  hypothesis: string; expected: string; rationale: string; priority: 'high' | 'medium' | 'low';
  procedure: string[]; risk: Risk; requiresApproval: boolean; enabled: boolean;
}
export interface NetEvt { ts: string; method: string; url: string; status: number | null; kind: string; flag?: string }
export interface ConEvt { ts: string; type: string; text: string; flag?: string }
export interface Evidence { screenshotIds: string[]; route: string; timestamp: string; network: NetEvt[]; console: ConEvt[]; traceRef: string }
export interface Finding {
  id: string; testId: string; claimId: string; claim: string; title: string; status: ClaimStatus; testStatus: string;
  severity: Severity; expected: string; observed: string; test: string; evidence: Evidence; recommendation?: string;
  hypothesisId: string; actionIds: string[]; observationIds: string[]; evidenceIds: string[];
  approval?: { decision: 'run' | 'skip'; at: string; modified: boolean };
}
export interface Shot { id: string; label: string; route: string; ts: string; src: string }
export interface LogLine { ts: string; level: 'info' | 'ok' | 'warn' | 'act'; text: string }
export interface TraceStep { id: string; kind: string; text: string; ts: string; ref?: string }
/**
 * A risk-aware interruption object, not a binary permission prompt. The extra fields carry the
 * approval anatomy the design spec requires: what could change, what is known vs uncertain, and
 * the safest non-destructive alternative — so the reviewer can judge the action before it runs.
 * All are optional: the orchestrator fills what it can establish and the modal omits the rest
 * rather than inventing reassurance it cannot support.
 */
export interface Hitl {
  id: string; kind: string; title: string; body: string; expected?: string; defaultPayload?: string;
  risk?: Risk; procedure?: string[]; ifApproved?: string; ifSkipped?: string;
  /** Why this action advances the current hypothesis. */
  why?: string;
  /** Side effects and reversibility, in the product's own terms. */
  couldChange?: string;
  /** Established facts about the action's blast radius. */
  known?: string[];
  /** What the agent cannot establish before acting. */
  uncertain?: string[];
  /** The non-destructive alternative, offered first. */
  safestOption?: string;
}
export interface Complete { counts: Record<string, number>; narrative: string; source: string; total: number; heroId: string | null }
export interface Approval { decision: 'run' | 'skip'; payload?: string }

export type Route = 'landing' | 'new' | 'plan' | 'live' | 'results' | 'finding' | 'report' | 'assessments' | 'library' | 'settings';

export interface StoredAssessment {
  id: string; at: string; target: string; replay: boolean; counts: Record<string, number>; narrative: string;
  total: number; heroId: string | null; findings: Finding[];
}
