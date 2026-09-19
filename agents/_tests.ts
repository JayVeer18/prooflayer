/**
 * Verifiers — private module.
 *
 * Each verifier turns a claim's hypothesis into browser actions, observes the result,
 * and returns a Finding whose status is decided by deterministic rules over the evidence.
 * (The LLM never picks the verdict.)
 */
import type { Driver } from './_driver';
import { hasCredentialMaterial, now, pathOf, redact, sleep } from './_util';
import type {
  Approval,
  ClaimStatus,
  ConEvt,
  Emit,
  Evidence,
  Finding,
  NetEvt,
  PlanItem,
  Severity,
  Surface,
  TestStatus,
} from './_types';

export interface Ctx {
  d: Driver;
  /** Every trace step emitted so far (used to link findings to actions/observations). */
  traceLog: Array<{ id: string; kind: string; ref?: string }>;
  target: URL;
  user: string;
  pass: string;
  emit: Emit;
  runId: string;
  surfaces: Surface[];
  secrets: string[];
  log(level: 'info' | 'ok' | 'warn' | 'act', text: string): void;
  trace(kind: 'claim' | 'hypothesis' | 'action' | 'observation' | 'evidence' | 'finding', text: string, ref?: string): void;
  shot(label: string): Promise<string>;
  flush(): Promise<{ console: ConEvt[]; network: NetEvt[] }>;
}

const USER_SEL =
  'input[type="email"], input[name*="mail" i], input[name*="user" i], input[id*="mail" i], input[id*="user" i], input[type="text"]';
const PASS_SEL = 'input[type="password"]';
const SUBMIT_SEL = 'button[type="submit"], input[type="submit"]';
const SUBMIT_TEXT = ['sign in', 'log in', 'login', 'continue', 'submit'];

/* ─────────────────────────────── observation flags ─────────────────────────────── */

export function flagCon(e: ConEvt): string | undefined {
  if (hasCredentialMaterial(e.text)) return 'credential-material';
  if (e.type === 'pageerror') return 'uncaught-error';
  if (/\b(debug|stack ?trace|internal error)\b/i.test(e.text)) return 'debug-output';
  return undefined;
}

export function flagNet(e: NetEvt, targetHost: string): string | undefined {
  if (/[?&](token|access_token|api_?key|password|secret)=/i.test(e.url)) return 'secret-in-url';
  if (e.status !== null && e.status >= 500) return '5xx';
  try {
    const h = new URL(e.url).host;
    if (h !== targetHost && !/fonts\.(googleapis|gstatic)\.com$/.test(h)) return 'external-domain';
  } catch {
    /* ignore */
  }
  if (e.status !== null && e.status >= 400) return '4xx';
  return undefined;
}

/* ─────────────────────────────────── helpers ─────────────────────────────────── */

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* page mid-navigation */
    }
    await sleep(250);
  }
  return false;
}

export async function hasLoginForm(d: Driver): Promise<boolean> {
  return Boolean(await d.evaluate<boolean>(`!!document.querySelector('input[type="password"]')`));
}

async function openLogin(ctx: Ctx): Promise<boolean> {
  await ctx.d.goto(ctx.target.href);
  if (await waitFor(() => hasLoginForm(ctx.d), 1800)) return true;
  await ctx.d.clickText(['sign in', 'log in', 'login']);
  await ctx.d.settle();
  return waitFor(() => hasLoginForm(ctx.d), 1800);
}

async function submitLogin(ctx: Ctx, user: string, pass: string) {
  await ctx.d.fill(USER_SEL, user);
  await ctx.d.fill(PASS_SEL, pass);
  try {
    await ctx.d.click(SUBMIT_SEL);
  } catch {
    await ctx.d.clickText(SUBMIT_TEXT);
  }
  await ctx.d.settle();
}

/** Signs in with the provided credentials if the browser isn't already signed in. */
export async function ensureLoggedIn(ctx: Ctx): Promise<boolean> {
  if (await openLogin(ctx)) {
    await submitLogin(ctx, ctx.user, ctx.pass);
    return waitFor(async () => !(await hasLoginForm(ctx.d)), 4000);
  }
  return true;
}

function evidence(ctx: Ctx, item: PlanItem, route: string, shots: string[], net: NetEvt[], con: ConEvt[]): Evidence {
  return {
    screenshotIds: shots.filter(Boolean),
    route,
    timestamp: now(),
    network: net.slice(0, 8),
    console: con.slice(0, 8),
    traceRef: `${ctx.runId}#${item.id}`,
  };
}

function finding(
  item: PlanItem,
  p: {
    status: ClaimStatus;
    testStatus: TestStatus;
    severity: Severity;
    test: string;
    observed: string;
    evidence: Evidence;
    recommendation?: string;
  },
): Finding {
  return {
    id: `f-${item.id}`,
    testId: item.id,
    claimId: item.claimId,
    claim: item.claim,
    title: item.title,
    status: p.status,
    testStatus: p.testStatus,
    severity: p.severity,
    expected: item.expected,
    observed: p.observed,
    test: p.test,
    evidence: p.evidence,
    recommendation: p.recommendation,
    hypothesisId: `h-${item.id}`,
    actionIds: [],
    observationIds: [],
    evidenceIds: [],
  };
}

/* ───────────────────────────── 1. authentication & session ───────────────────────────── */

export async function authSession(ctx: Ctx, item: PlanItem): Promise<Finding> {
  const { d } = ctx;
  const shots: string[] = [];
  const net: NetEvt[] = [];
  const con: ConEvt[] = [];
  const grab = async () => {
    const f = await ctx.flush();
    net.push(...f.network);
    con.push(...f.console);
  };

  ctx.trace('hypothesis', item.hypothesis, item.id);
  await d.resetSession();
  await d.drain();

  ctx.log('act', 'Opening the sign-in page');
  if (!(await openLogin(ctx))) {
    return finding(item, {
      status: 'INCONCLUSIVE',
      testStatus: 'BLOCKED',
      severity: 'INFO',
      test: 'Locate sign-in form',
      observed: 'The validation could not be completed: no sign-in form was found at the provided URL. No conclusion was made about the vendor claim.',
      evidence: evidence(ctx, item, pathOf(ctx.target.href), shots, net, con),
    });
  }

  ctx.log('act', 'Submitting an invalid password');
  ctx.trace('action', 'Submit invalid credentials', item.id);
  await submitLogin(ctx, ctx.user, `wrong-${Math.random().toString(36).slice(2, 8)}`);
  const stillOnLogin = await hasLoginForm(d);
  const errText = await d.evaluate<string>(
    `(function(){var t=(document.body?document.body.innerText:'');var m=t.match(/[^\\n]*(invalid|incorrect|wrong|failed|denied|not recogni)[^\\n]*/i);return m?m[0].trim():''})()`,
  );
  shots.push(await ctx.shot('Invalid credentials'));
  await grab();
  ctx.trace('observation', stillOnLogin ? `Rejected${errText ? `: “${errText}”` : ''}` : 'Invalid credentials were ACCEPTED', item.id);

  ctx.log('act', 'Signing in with the provided credentials');
  await d.fill(PASS_SEL, ctx.pass);
  await d.fill(USER_SEL, ctx.user);
  try {
    await d.click(SUBMIT_SEL);
  } catch {
    await d.clickText(SUBMIT_TEXT);
  }
  await d.settle();
  const loggedIn = await waitFor(async () => !(await hasLoginForm(d)), 4000);
  const landing = await d.url();
  shots.push(await ctx.shot('Signed in'));
  await grab();

  if (!loggedIn) {
    return finding(item, {
      status: 'INCONCLUSIVE',
      testStatus: 'BLOCKED',
      severity: 'INFO',
      test: 'Sign in with provided credentials',
      observed: 'AUTHENTICATION FAILED — ProofLayer could not establish the supplied test credentials. No assessment conclusion was made.',
      evidence: evidence(ctx, item, pathOf(landing), shots, net, con),
      recommendation: 'Confirm the test credentials are valid and re-run.',
    });
  }

  ctx.log('act', 'Signing out, then requesting a protected page directly');
  ctx.trace('action', 'Sign out → navigate to previously authenticated page', item.id);
  const clicked = await d.clickText(['log out', 'logout', 'sign out']);
  await d.settle();
  await d.goto(landing);
  const blocked = await waitFor(() => hasLoginForm(d), 2500);
  shots.push(await ctx.shot('Protected page after sign-out'));
  await grab();
  ctx.trace('observation', blocked ? 'Protected page redirected to sign-in after logout' : 'Protected page STILL rendered after logout', item.id);

  const ev = evidence(ctx, item, pathOf(landing), shots, net, con);
  const test = 'Invalid login → valid login → logout → direct request to a protected page';
  if (!stillOnLogin) {
    return finding(item, { status: 'CONTRADICTED', testStatus: 'FAIL', severity: 'HIGH', test, evidence: ev, observed: 'An invalid password was accepted and the user was signed in.' });
  }
  if (clicked && !blocked) {
    return finding(item, { status: 'CONTRADICTED', testStatus: 'FAIL', severity: 'HIGH', test, evidence: ev, observed: `After logout, ${pathOf(landing)} still rendered without re-authentication.` });
  }
  return finding(item, {
    status: 'SUPPORTED',
    testStatus: 'PASS',
    severity: 'INFO',
    test,
    evidence: ev,
    observed: `Invalid password rejected${errText ? ` (“${errText}”)` : ''}; valid login succeeded; after logout, ${pathOf(landing)} redirected back to sign-in.`,
  });
}

/* ───────────────────────────── 2. role boundary (RBAC) ───────────────────────────── */

const ADMINISH = /admin|manage|users|roles|permissions|billing|settings/i;

export async function rbacDirectNav(ctx: Ctx, item: PlanItem): Promise<Finding> {
  const { d } = ctx;
  const shots: string[] = [];
  ctx.trace('hypothesis', item.hypothesis, item.id);

  if (!(await ensureLoggedIn(ctx))) {
    return finding(item, {
      status: 'INCONCLUSIVE',
      testStatus: 'BLOCKED',
      severity: 'INFO',
      test: 'Sign in as the provided standard user',
      observed: 'AUTHENTICATION FAILED — ProofLayer could not establish the supplied test credentials. No assessment conclusion was made.',
      evidence: evidence(ctx, item, pathOf(ctx.target.href), shots, [], []),
    });
  }

  const base = new URL('./', ctx.target.href);
  const hidden = ctx.surfaces.filter((s) => s.hidden && ADMINISH.test(s.path + s.name)).map((s) => new URL(s.path, ctx.target.origin).href);
  const common = ['admin/users/', 'admin/', 'admin/settings/', 'settings/roles/'].map((p) => new URL(p, base).href);
  const candidates = [...new Set([...hidden, ...common])].slice(0, 5);
  ctx.log('info', `Probing ${candidates.length} privileged routes as the standard user${hidden.length ? ` (${hidden.length} found hidden in the DOM)` : ''}`);

  let denied = 0;
  let notFound = 0;
  for (const url of candidates) {
    ctx.log('act', `GET ${pathOf(url)} as standard user`);
    ctx.trace('action', `Navigate directly to ${pathOf(url)}`, item.id);
    await d.drain();
    const res = await d.goto(url);
    const text = (await d.text()).slice(0, 1500);
    const finalUrl = new URL(res.url || url);
    const flushed = await ctx.flush();

    const isDenied =
      /login|signin|sign-in|denied|forbidden|unauthori[sz]ed|403/i.test(finalUrl.pathname) ||
      res.status === 401 ||
      res.status === 403 ||
      /access denied|forbidden|not authori[sz]ed|do(?:n't| not) have permission|\b403\b/i.test(text.slice(0, 600)) ||
      (await hasLoginForm(d));
    const isMissing = res.status === 404 || /page not found|\b404\b/i.test(`${res.title} ${text.slice(0, 200)}`);

    if (isDenied) {
      denied++;
      ctx.trace('observation', `${pathOf(url)} → denied`, item.id);
      continue;
    }
    if (isMissing) {
      notFound++;
      continue;
    }

    // A 200 alone proves nothing (single-page apps often serve the same shell for every path).
    // Only count it as privileged access if the page looks administrative or calls a privileged API.
    const privilegedApi = flushed.network.some((n) => n.kind !== 'document' && (n.status ?? 0) < 300 && /user|admin|role/i.test(n.url));
    if (!ADMINISH.test(`${res.title} ${text.slice(0, 500)}`) && !privilegedApi) {
      notFound++;
      ctx.trace('observation', `${pathOf(url)} returned a generic page — not treated as administrative access`, item.id);
      continue;
    }

    // The page rendered for a standard user.
    const rows = Number(await d.evaluate<number>(`document.querySelectorAll('tbody tr, [role="row"]').length`)) || 0;
    const shotId = await ctx.shot(`Standard user reached ${pathOf(finalUrl.href)}`);
    shots.push(shotId);
    const api = flushed.network.find((n) => n.kind !== 'document' && (n.status ?? 0) < 300 && /user|admin|role/i.test(n.url));
    ctx.trace('observation', `${pathOf(finalUrl.href)} rendered “${res.title}” (HTTP ${res.status ?? '200'})`, item.id);
    ctx.trace('evidence', `screenshot ${shotId}${api ? ` + ${api.method} ${pathOf(api.url)} → ${api.status}` : ''}`, item.id);

    return finding(item, {
      status: 'CONTRADICTED',
      testStatus: 'FAIL',
      severity: 'HIGH',
      test: `Signed in as a standard user, navigated directly to ${pathOf(finalUrl.href)}`,
      observed:
        `Standard user opened ${pathOf(finalUrl.href)} directly (HTTP ${res.status ?? 200}). ` +
        `Page “${res.title || 'untitled'}” rendered${rows ? ` with ${rows} rows of account data` : ''}` +
        `${api ? `; ${api.method} ${pathOf(api.url)} returned ${api.status}` : ''}. ` +
        `The navigation link was only hidden in the UI — access was not enforced.`,
      evidence: evidence(ctx, item, pathOf(finalUrl.href), shots, flushed.network, flushed.console),
      recommendation: 'Enforce role checks server-side on privileged routes and their APIs; hiding links is not access control.',
    });
  }

  const test = `Signed in as a standard user, navigated directly to ${candidates.length} privileged routes`;
  if (denied > 0 && notFound < candidates.length) {
    return finding(item, {
      status: 'SUPPORTED',
      testStatus: 'PASS',
      severity: 'INFO',
      test,
      observed: `${denied} privileged route(s) denied the standard user (redirect or 401/403); none rendered.`,
      evidence: evidence(ctx, item, pathOf(candidates[0]), shots, [], []),
    });
  }
  return finding(item, {
    status: 'NEEDS_HUMAN_REVIEW',
    testStatus: 'INCONCLUSIVE',
    severity: 'INFO',
    test,
    observed: 'No privileged routes could be identified from the UI alone. Provide a known admin URL to test.',
    evidence: evidence(ctx, item, pathOf(ctx.target.href), shots, [], []),
  });
}

/* ───────────────────────────── 3. runtime signals (console / network) ───────────────────────────── */

export async function runtimeSignals(ctx: Ctx, item: PlanItem): Promise<Finding> {
  const { d } = ctx;
  ctx.trace('hypothesis', item.hypothesis, item.id);
  await d.resetSession();
  await d.drain();

  ctx.log('act', 'Fresh sign-in with browser console and network capture on');
  ctx.trace('action', 'Sign in while capturing console + network', item.id);
  await ensureLoggedIn(ctx);
  await d.settle();
  const f = await ctx.flush();
  const shotId = await ctx.shot('Runtime capture after sign-in');

  const conFlagged = f.console.filter((c) => c.flag);
  const netFlagged = f.network.filter((n) => n.flag && n.flag !== '4xx');
  const cred = conFlagged.filter((c) => c.flag === 'credential-material').length + netFlagged.filter((n) => n.flag === 'secret-in-url').length;
  const test = 'Sign in and inspect browser console + network for sensitive data, errors and unexpected calls';
  const ev = evidence(ctx, item, pathOf(await d.url()), [shotId], f.network, conFlagged.length ? conFlagged : f.console);
  ctx.trace('observation', `${f.console.length} console events, ${f.network.length} requests; ${cred} credential exposure(s)`, item.id);

  if (cred > 0) {
    const first = conFlagged.find((c) => c.flag === 'credential-material');
    return finding(item, {
      status: 'CONTRADICTED',
      testStatus: 'FAIL',
      severity: 'MEDIUM',
      test,
      evidence: ev,
      observed:
        `Credential material was exposed in the browser at sign-in` +
        `${first ? `: console.${first.type} → “${first.text.slice(0, 90)}”` : ''}. ` +
        `Any script or browser extension on the page can read it.`,
      recommendation: 'Remove debug logging of tokens and never place secrets in URLs or console output.',
    });
  }
  if (conFlagged.length || netFlagged.length) {
    return finding(item, {
      status: 'PARTIALLY_VERIFIED',
      testStatus: 'FAIL',
      severity: 'LOW',
      test,
      evidence: ev,
      observed: `No credentials exposed, but ${conFlagged.length + netFlagged.length} runtime warning(s) were observed (${[...new Set([...conFlagged, ...netFlagged].map((x) => x.flag))].join(', ')}).`,
    });
  }
  return finding(item, {
    status: 'SUPPORTED',
    testStatus: 'PASS',
    severity: 'INFO',
    test,
    evidence: ev,
    observed: `${f.console.length} console events and ${f.network.length} requests observed during sign-in; no credentials, errors or unexpected external calls.`,
  });
}

/* ───────────────────────────── 4. AI sensitive-data protection ───────────────────────────── */

export const DEFAULT_AI_PAYLOAD =
  'Please draft a refund reply for customer John Smith. His SSN is 123-45-6789, card 4111 1111 1111 1111, email john.smith@example.com.';

const PII: Array<{ name: string; re: RegExp }> = [
  { name: 'SSN', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'Payment card', re: /\b(?:\d[ -]?){13,16}\b/ },
  { name: 'Email', re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
];

export async function aiDataProtection(ctx: Ctx, item: PlanItem, approval?: Approval): Promise<Finding> {
  const { d } = ctx;
  const shots: string[] = [];
  ctx.trace('hypothesis', item.hypothesis, item.id);
  const test = 'Submitted synthetic sensitive data (SSN, card, email) to the AI assistant and inspected what was sent to the model';

  if (approval?.decision === 'skip') {
    return finding(item, {
      status: 'NOT_VERIFIED',
      testStatus: 'SKIPPED',
      severity: 'INFO',
      test: 'Skipped by reviewer',
      observed: 'The reviewer chose not to run this validation, so the claim remains unverified.',
      evidence: evidence(ctx, item, '', shots, [], []),
    });
  }

  const ai = ctx.surfaces.find((s) => !s.hidden && /\bai\b|assistant|copilot|govern/i.test(`${s.name} ${s.path}`));
  if (!ai || !(await ensureLoggedIn(ctx))) {
    return finding(item, {
      status: 'INCONCLUSIVE',
      testStatus: 'BLOCKED',
      severity: 'INFO',
      test,
      observed: 'The validation could not be completed: no AI assistant surface was reachable. No conclusion was made about the vendor claim.',
      evidence: evidence(ctx, item, '', shots, [], []),
    });
  }

  const payload = (approval?.payload || DEFAULT_AI_PAYLOAD).slice(0, 600);
  ctx.log('act', `Opening ${ai.name} and submitting synthetic sensitive data`);
  ctx.trace('action', 'Submit synthetic PII to the AI assistant', item.id);
  await d.goto(new URL(ai.path, ctx.target.origin).href);
  await d.drain();
  await d.fill('textarea, input[type="text"]', payload);
  shots.push(await ctx.shot('Synthetic data entered'));
  try {
    await d.click(SUBMIT_SEL);
  } catch {
    await d.clickText(['send', 'ask', 'submit']);
  }
  await d.settle();
  const f = await ctx.flush();

  // Several elements may match (headings, wrappers). Take the one with the most text, and treat a
  // near-empty result as "not observable" — never as "everything was masked".
  const outboundRaw = await d.evaluate<string | null>(
    `(function(){var els=document.querySelectorAll('[data-testid*="payload" i],[id*="payload" i],[data-testid*="model-input" i],[id*="model-input" i]');var best=null;els.forEach(function(el){var t=(el.innerText||el.textContent||'').trim();if(best===null||t.length>best.length)best=t;});return best})()`,
  );
  const outbound = outboundRaw !== null && outboundRaw.length >= 12 ? outboundRaw : null;
  shots.push(await ctx.shot('Assistant response and outbound payload'));
  const route = pathOf(await d.url());

  if (outbound === null) {
    return finding(item, {
      status: 'NEEDS_HUMAN_REVIEW',
      testStatus: 'INCONCLUSIVE',
      severity: 'INFO',
      test,
      observed: 'The product does not expose what is sent to the model, so masking cannot be confirmed from the UI alone.',
      evidence: evidence(ctx, item, route, shots, f.network, f.console),
      recommendation: 'Request model-gateway request logs or architecture documentation from the vendor.',
    });
  }

  const present = PII.filter((p) => p.re.test(payload));
  const leaked = present.filter((p) => p.re.test(outbound));
  const masked = present.filter((p) => !p.re.test(outbound));
  ctx.trace('observation', `Masked: ${masked.map((m) => m.name).join(', ') || 'none'} · Not masked: ${leaked.map((m) => m.name).join(', ') || 'none'}`, item.id);
  const ev = evidence(ctx, item, route, shots, f.network, f.console);

  if (leaked.length === 0) {
    return finding(item, { status: 'SUPPORTED', testStatus: 'PASS', severity: 'INFO', test, evidence: ev, observed: `All ${present.length} synthetic sensitive values were masked before reaching the model.` });
  }
  if (masked.length === 0) {
    return finding(item, { status: 'CONTRADICTED', testStatus: 'FAIL', severity: 'HIGH', test, evidence: ev, observed: `None of the synthetic sensitive values were masked; ${leaked.map((l) => l.name).join(', ')} reached the model in clear text.` });
  }
  return finding(item, {
    status: 'PARTIALLY_VERIFIED',
    testStatus: 'FAIL',
    severity: 'MEDIUM',
    test,
    evidence: ev,
    observed: `Masked: ${masked.map((m) => m.name).join(', ')}. NOT masked: ${leaked.map((l) => l.name).join(', ')} — sent to the model in clear text.`,
    recommendation: 'Extend the redaction rules to cover all regulated identifiers (SSN/national ID, health and financial data).',
  });
}

/* ───────────────────────────── 5. claims that cannot be externally proven ───────────────────────────── */

const UNVERIFIABLE: Record<string, { why: string; evidence: string[] }> = {
  train: {
    why: 'Data-usage commitments such as “never used to train external models” cannot be proven through observable application behavior alone.',
    evidence: ['Vendor architecture documentation', 'Data-processing agreement', 'Model-provider data policy'],
  },
  audit: {
    why: 'No audit-log surface was reachable for this role, so ProofLayer cannot confirm what actions are recorded.',
    evidence: ['Admin-role walkthrough of the audit log', 'Sample audit-log export', 'Retention policy'],
  },
  other: {
    why: 'This claim is not something ProofLayer can test through the product interface.',
    evidence: ['Vendor documentation', 'Independent audit report'],
  },
};

export function unverifiable(ctx: Ctx, item: PlanItem): Finding {
  const u = UNVERIFIABLE[item.claimKey] ?? UNVERIFIABLE.other;
  ctx.trace('hypothesis', item.hypothesis, item.id);
  ctx.trace('observation', 'Not externally observable — reporting honestly instead of guessing', item.id);
  return finding(item, {
    status: 'NOT_VERIFIED',
    testStatus: 'INCONCLUSIVE',
    severity: 'INFO',
    test: 'Assess whether the claim is externally observable',
    observed: u.why,
    evidence: evidence(ctx, item, '', [], [], []),
    recommendation: `Recommended evidence: ${u.evidence.join(' · ')}`,
  });
}

/* ─────────────────────────────────── dispatcher ─────────────────────────────────── */

export async function runTemplate(ctx: Ctx, item: PlanItem, approval?: Approval): Promise<Finding> {
  switch (item.template) {
    case 'auth_session':
      return authSession(ctx, item);
    case 'rbac_direct_nav':
      return rbacDirectNav(ctx, item);
    case 'runtime_signals':
      return runtimeSignals(ctx, item);
    case 'ai_data_protection':
      return aiDataProtection(ctx, item, approval);
    default:
      return unverifiable(ctx, item);
  }
}

export { redact };
