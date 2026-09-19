export type ClaimStatus = 'VERIFIED' | 'CONTRADICTED' | 'PARTIALLY_VERIFIED' | 'NOT_VERIFIED' | 'NEEDS_HUMAN_REVIEW';
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface Surface { name: string; path: string; title?: string; hidden?: boolean }
export interface Claim { id: string; key: string; text: string; source: 'vendor' | 'discovered' | 'baseline' }
export interface PlanItem {
  id: string; claimId: string; claim: string; claimKey: string; template: string; title: string;
  hypothesis: string; expected: string; rationale: string; priority: 'high' | 'medium' | 'low';
  requiresApproval: boolean; enabled: boolean;
}
export interface NetEvt { ts: string; method: string; url: string; status: number | null; kind: string; flag?: string }
export interface ConEvt { ts: string; type: string; text: string; flag?: string }
export interface Evidence { screenshotIds: string[]; route: string; timestamp: string; network: NetEvt[]; console: ConEvt[]; traceRef: string }
export interface Finding {
  id: string; testId: string; claimId: string; claim: string; title: string; status: ClaimStatus; testStatus: string;
  severity: Severity; expected: string; observed: string; test: string; evidence: Evidence; recommendation?: string;
}
export interface Shot { id: string; label: string; route: string; ts: string; src: string }
export interface LogLine { ts: string; level: 'info' | 'ok' | 'warn' | 'act'; text: string }
export interface TraceStep { id: string; kind: string; text: string; ts: string; ref?: string }
export interface Hitl { id: string; kind: string; title: string; body: string; expected?: string; defaultPayload?: string }
export interface Complete { counts: Record<string, number>; narrative: string; source: string; total: number; heroId: string | null }
export interface Approval { decision: 'run' | 'skip'; payload?: string }
