/**
 * Action-safety policy — private module.
 *
 * Enforced in code (server-side, on every execute call), never delegated to a prompt:
 *   SAFE     navigate, inspect, screenshot, synthetic data, logout
 *   REVIEW   changes state or submits data to another system → needs an explicit human decision
 *   BLOCKED  payments, destructive/mass operations, anything out of scope → never runs
 */
import type { Approval, PlanItem, Risk, TemplateId } from './_types';

const BLOCKED_RE =
  /\b(pay(ment)?s?|purchase|checkout|charge (a )?card|transfer funds?|withdraw|mass[- ]delet\w*|delete all|drop table|wipe|truncate|production data|bulk (delete|export))\b/i;
const REVIEW_RE =
  /\b(create (a |an )?(test )?(user|role|account)|role escalation|escalat\w+|change (permissions?|settings?)|modify (settings|roles?|permissions?)|invite|delete|disable|deactivate|external (workflow|webhook)|send (an? )?(email|message)|synthetic (sensitive )?data)\b/i;

const RANK: Record<Risk, number> = { SAFE: 0, REVIEW: 1, BLOCKED: 2 };
export const maxRisk = (a: Risk, b: Risk): Risk => (RANK[a] >= RANK[b] ? a : b);

export function classifyAction(description: string): Risk {
  if (BLOCKED_RE.test(description)) return 'BLOCKED';
  if (REVIEW_RE.test(description)) return 'REVIEW';
  return 'SAFE';
}

/** Baseline risk of each built-in test template. */
export function riskForTemplate(t: TemplateId): Risk {
  return t === 'ai_data_protection' ? 'REVIEW' : 'SAFE';
}

/** Server-side risk: never trust a risk value supplied by the client. */
export function effectiveRisk(item: Pick<PlanItem, 'template' | 'title' | 'claim' | 'hypothesis' | 'procedure'>): Risk {
  const text = [item.title, item.claim, item.hypothesis, ...(item.procedure ?? [])].join(' ');
  return maxRisk(riskForTemplate(item.template), classifyAction(text));
}

export type Gate = 'run' | 'ask' | 'skip' | 'blocked';

/** Decides whether a test may execute right now. */
export function gate(item: PlanItem, approvals: Record<string, Approval | undefined>): Gate {
  if (!item.enabled) return 'skip';
  const risk = effectiveRisk(item);
  if (risk === 'BLOCKED') return 'blocked';
  if (risk === 'REVIEW') {
    const a = approvals[item.id];
    if (!a) return 'ask';
    return a.decision === 'run' ? 'run' : 'skip';
  }
  return 'run';
}
