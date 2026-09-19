/**
 * Assessment state machine — private module.
 *   DISCOVERY → PLAN → APPROVAL → EXECUTION → FINDINGS
 * (EXECUTION may pause for a human decision and resume; any state may end in FAILED.)
 */
export type AssessmentStatus = 'DISCOVERY' | 'PLAN' | 'APPROVAL' | 'EXECUTION' | 'PAUSED' | 'FINDINGS' | 'FAILED';

const NEXT: Record<AssessmentStatus, AssessmentStatus[]> = {
  DISCOVERY: ['PLAN', 'FAILED'],
  PLAN: ['APPROVAL', 'FAILED'],
  APPROVAL: ['EXECUTION', 'PLAN', 'FAILED'],
  EXECUTION: ['PAUSED', 'FINDINGS', 'FAILED'],
  PAUSED: ['EXECUTION', 'FAILED'],
  FINDINGS: [],
  FAILED: [],
};

export const canTransition = (from: AssessmentStatus, to: AssessmentStatus) => NEXT[from].includes(to);

export function transition(from: AssessmentStatus, to: AssessmentStatus): AssessmentStatus {
  if (!canTransition(from, to)) throw new Error(`Illegal assessment transition ${from} → ${to}`);
  return to;
}
