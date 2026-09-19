/** Claim discovery + claim → test-template mapping. Deterministic on purpose. Private module. */
import type { Claim, ClaimKey, TemplateId } from './_types';

export const CLAIM_LIBRARY: Record<ClaimKey, string> = {
  rbac: 'Enterprise role-based access control',
  auth: 'Secure authentication and session management',
  runtime: 'No sensitive data is exposed in the browser',
  ai: 'Sensitive data is masked before it reaches the AI model',
  train: 'Customer data is never used to train external AI models',
  audit: 'Full audit trail of user and admin actions',
  other: 'Vendor claim',
};

export function claimKey(text: string): ClaimKey {
  const t = text.toLowerCase();
  if (/\btrain|retain|retention|data residency|encrypt(ed|ion)? at rest|soc ?2|iso ?27|hipaa|gdpr|certif/.test(t)) return 'train';
  if (/audit|activity log|full log/.test(t)) return 'audit';
  if (/(mask|redact|sensitive|pii|personal).*(model|\bai\b)|(\bai\b|model).*(mask|redact|sensitive|pii|govern)/.test(t)) return 'ai';
  if (/role|rbac|permission|access control|authori[sz]ed|admin/.test(t)) return 'rbac';
  if (/session|authenticat|log ?in|sign ?in|password|mfa|sso|logout|log out/.test(t)) return 'auth';
  if (/console|browser|client[- ]side|token|expos|leak/.test(t)) return 'runtime';
  return 'other';
}

export function templateFor(key: ClaimKey): TemplateId {
  switch (key) {
    case 'rbac':
      return 'rbac_direct_nav';
    case 'auth':
      return 'auth_session';
    case 'runtime':
      return 'runtime_signals';
    case 'ai':
      return 'ai_data_protection';
    default:
      return 'unverifiable';
  }
}

const CLAIMISH =
  /role-based|access control|authenticat|session|audit|sensitive|masked|redact|never used|train|encrypt|compliance|soc ?2|hipaa|gdpr|secure|only admin/i;

/** Pull claim-like sentences out of visible page copy. */
export function extractClaims(texts: string[]): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    for (const s of raw.split(/(?<=[.!?])\s+|\n+/)) {
      const t = s.trim().replace(/\s+/g, ' ');
      if (t.length < 25 || t.length > 220) continue;
      if (!CLAIMISH.test(t)) continue;
      if (/^(sign in|email|password|log ?out)/i.test(t)) continue;
      out.push(t);
    }
  }
  return out;
}

export function buildClaims(userClaims: string[], discovered: string[]): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const add = (text: string, source: Claim['source']) => {
    const key = claimKey(text);
    const dedupe = key === 'other' ? text.toLowerCase() : key;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    claims.push({ id: `c${claims.length + 1}`, key, text: text.replace(/\.$/, ''), source });
  };

  const provided = userClaims.map((c) => c.trim()).filter(Boolean);
  if (provided.length) provided.forEach((c) => add(c, 'vendor'));
  else discovered.forEach((c) => add(c, 'discovered'));

  // Baseline checks every assessment gets, even without vendor claims.
  if (!seen.has('auth')) add(CLAIM_LIBRARY.auth, 'baseline');
  if (!seen.has('runtime')) add(CLAIM_LIBRARY.runtime, 'baseline');
  return claims.slice(0, 8);
}
