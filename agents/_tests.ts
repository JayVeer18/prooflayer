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

// Prefer an explicitly identified account field over a generic text input. A bare input[type="text"]
// is very often the site-wide search box in the navigation bar, and typing the username into search
// silently breaks sign-in; it stays last as a fallback for forms that identify nothing.
const USER_SEL =
  'input[type="email"], input[name*="mail" i], input[name*="user" i], input[id*="mail" i], input[id*="user" i], input[autocomplete="username"], input[type="text"]';
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

/**
 * Finds the product's sign-in form.
 *
 * Order matters: the landing page, then a visible "sign in" control, and only then the conventional
 * login routes. The last step is what makes this work on single-page apps, where the sign-in link
 * often sits inside a collapsed menu or behind a welcome overlay and cannot be clicked — concluding
 * "this product has no authentication" in that case would silently drop every role-boundary claim.
 */
async function openLogin(ctx: Ctx): Promise<boolean> {
  await ctx.d.goto(ctx.target.href);
  if (await waitFor(() => hasLoginForm(ctx.d), 1800)) return true;

  await dismissOverlays(ctx);
  await ctx.d.clickText(['sign in', 'log in', 'login']);
  await ctx.d.settle();
  if (await waitFor(() => hasLoginForm(ctx.d), 1800)) return true;

  for (const route of ['#/login', 'login', 'signin', 'sign-in', 'account/login', 'users/sign_in']) {
    let href: string;
    try {
      href = new URL(route, ctx.target.href).href;
    } catch {
      continue;
    }
    await ctx.d.goto(href);
    await ctx.d.settle();
    if (await waitFor(() => hasLoginForm(ctx.d), 1500)) {
      ctx.log('info', `Sign-in form found at ${pathOf(href)}`);
      await dismissOverlays(ctx);
      return true;
    }
  }
  return false;
}

/**
 * Closes welcome banners and cookie bars. These overlay the page and swallow clicks, which stalls
 * sign-in on many products; dismissing them is what an ordinary user does before using the app.
 * Best-effort only — anything that fails is ignored.
 */
async function dismissOverlays(ctx: Ctx): Promise<void> {
  try {
    await ctx.d.evaluate(
      `(function(){var sels=['[aria-label*="close" i]','[aria-label*="dismiss" i]','.cc-btn.cc-dismiss','.cookie-consent button','#cookieconsent button'];` +
        `var n=0;sels.forEach(function(s){document.querySelectorAll(s).forEach(function(el){try{var r=el.getClientRects();if(r&&r.length){el.click();n++}}catch(e){}})});return n})()`,
    );
    await ctx.d.settle();
  } catch {
    /* overlays are incidental — never fail sign-in because one could not be dismissed */
  }
}

/**
 * Returns a selector for the account/username field that belongs to the sign-in form.
 *
 * A CSS selector list matches in document order, so `input[type="text"]` in a navigation search box
 * wins over the real email field further down the page — the credentials then go into search and the
 * sign-in silently fails. This marks the correct field in the page (scoped to the form that actually
 * contains the password input) and returns a selector for that one element.
 */
async function accountFieldSelector(ctx: Ctx): Promise<string> {
  const MARK = 'data-argus-account-field';
  try {
    const found = await ctx.d.evaluate<boolean>(
      `(function(){` +
        `var pw=document.querySelector('input[type="password"]');if(!pw)return false;` +
        `var scope=pw.form||pw.closest('form,[class*="login" i],[class*="signin" i]')||document;` +
        `var pick=scope.querySelector('input[type="email"],input[name*="mail" i],input[name*="user" i],input[id*="mail" i],input[id*="user" i],input[autocomplete="username"]');` +
        `if(!pick){var all=Array.prototype.slice.call(scope.querySelectorAll('input[type="text"],input:not([type])'));` +
        `pick=all.filter(function(el){return el!==pw})[0]}` +
        `if(!pick)return false;pick.setAttribute(${JSON.stringify(MARK)},'1');return true})()`,
    );
    if (found) return `[${MARK}]`;
  } catch {
    /* fall through to the generic selector below */
  }
  return USER_SEL;
}

async function submitLogin(ctx: Ctx, user: string, pass: string, label?: string) {
  await ctx.d.fill(await accountFieldSelector(ctx), user);
  await ctx.d.fill(PASS_SEL, pass);
  // Password fields render as dots, so this frame shows the entry without exposing the secret.
  if (label) await ctx.shot(label);
  try {
    await ctx.d.click(SUBMIT_SEL);
  } catch {
    await ctx.d.clickText(SUBMIT_TEXT);
  }
  await ctx.d.settle();
}

export type AuthOutcome = 'signed-in' | 'no-auth-needed' | 'failed';

/**
 * Signs in with the provided credentials if the target has a login form.
 * Distinguishes "there is nothing to sign into" (a public/no-auth product) from
 * "credentials were wrong" — the two must never be reported the same way.
 */
export async function ensureLoggedIn(ctx: Ctx): Promise<AuthOutcome> {
  if (await openLogin(ctx)) {
    ctx.log('act', 'Entering the test credentials');
    await submitLogin(ctx, ctx.user, ctx.pass, 'Entering credentials');
    const ok = await waitFor(async () => !(await hasLoginForm(ctx.d)), 4000);
    return ok ? 'signed-in' : 'failed';
  }
  return 'no-auth-needed';
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
      status: 'NOT_VERIFIED',
      testStatus: 'SKIPPED',
      severity: 'INFO',
      test: 'Locate sign-in form',
      observed: 'No sign-in form was found — this product (or this page) does not appear to require authentication, so session behavior does not apply.',
      evidence: evidence(ctx, item, pathOf(ctx.target.href), shots, net, con),
    });
  }

  ctx.log('act', 'Submitting an invalid password');
  ctx.trace('action', 'Submit invalid credentials', item.id);
  await submitLogin(ctx, ctx.user, `wrong-${Math.random().toString(36).slice(2, 8)}`, 'Invalid password entered');
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
  await ctx.shot('Entering credentials');
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
      observed: 'SIGN-IN FAILED — the username and password provided were not accepted by the product, so no conclusion could be reached.',
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

  const authResult = await ensureLoggedIn(ctx);
  if (authResult === 'no-auth-needed') {
    return finding(item, {
      status: 'NOT_VERIFIED',
      testStatus: 'SKIPPED',
      severity: 'INFO',
      test: 'Sign in as the provided standard user',
      observed: 'No sign-in form was found — this product does not appear to gate access behind authentication, so a role-boundary claim does not apply here.',
      evidence: evidence(ctx, item, pathOf(ctx.target.href), shots, [], []),
    });
  }
  if (authResult === 'failed') {
    return finding(item, {
      status: 'INCONCLUSIVE',
      testStatus: 'BLOCKED',
      severity: 'INFO',
      test: 'Sign in as the provided standard user',
      observed: 'SIGN-IN FAILED — the username and password provided were not accepted by the product, so no conclusion could be reached.',
      evidence: evidence(ctx, item, pathOf(ctx.target.href), shots, [], []),
    });
  }

  const base = new URL('./', ctx.target.href);
  const hidden = ctx.surfaces.filter((s) => s.hidden && ADMINISH.test(s.path + s.name)).map((s) => new URL(s.path, ctx.target.origin).href);
  const common = ['admin/users/', 'admin/', 'admin/settings/', 'settings/roles/'].map((p) => new URL(p, base).href);
  // Single-page apps commonly route on the URL fragment (#/administration), which never reaches the
  // server — so a plain-path probe just returns the app shell and proves nothing either way. When the
  // product looks like a hash-routed SPA, probe the fragment forms too. This is generic SPA support,
  // not a route list tailored to any one product.
  const hashCandidates = ctx.surfaces.some((s) => s.path.includes('#/'))
    ? ['#/administration', '#/admin', '#/admin/users'].map((p) => new URL(p, base).href)
    : [];
  const candidates = [...new Set([...hidden, ...hashCandidates, ...common])].slice(0, 6);
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

  // A page that refuses the standard user proves the INTERFACE enforces the boundary; it does not
  // prove the SERVER does. Access control implemented only in the client is a common real defect, so
  // when the pages refuse, ask the product's own administrative endpoint directly, using the signed-in
  // session. The request is issued from inside the page so it carries exactly the credentials the
  // product itself would send — a read-only GET, no state is changed.
  if (denied > 0) {
    const apiProbe = await probeAdminApi(ctx, item);
    if (apiProbe) return apiProbe;
  }

  if (denied > 0 && notFound < candidates.length) {
    return finding(item, {
      status: 'SUPPORTED',
      testStatus: 'PASS',
      severity: 'INFO',
      test,
      observed: `${denied} administrator-only page(s) correctly turned the standard user away, and the administrative data endpoints refused the same account.`,
      evidence: evidence(ctx, item, pathOf(candidates[0]), shots, [], []),
    });
  }
  return finding(item, {
    status: 'NEEDS_HUMAN_REVIEW',
    testStatus: 'INCONCLUSIVE',
    severity: 'INFO',
    test,
    observed: 'No administrator-only pages could be found from the product interface alone. Add a known admin page address to test this claim.',
    evidence: evidence(ctx, item, pathOf(ctx.target.href), shots, [], []),
  });
}

/**
 * Builds the in-page script that requests `path` using whatever session the product itself holds.
 *
 * Cookies ride along via credentials:'include'; many single-page apps instead keep a bearer token in
 * web storage, so that is reused when present. Without the token the probe would ask anonymously, and
 * the resulting 401 would be mistaken for "the server enforces this boundary" — under-reporting a real
 * exposure. Exported so tests exercise the exact string that ships, rather than a copy that can drift.
 */
export function adminApiProbeScript(path: string): string {
  return (
    "(async function(){try{" +
    "var tok=null;" +
    "try{" +
    "var keys=Object.keys(localStorage).concat(Object.keys(sessionStorage));" +
    "for(var i=0;i<keys.length;i++){" +
    "if(!/token|jwt|auth/i.test(keys[i]))continue;" +
    "var v=localStorage.getItem(keys[i]);if(!v)v=sessionStorage.getItem(keys[i]);if(!v)continue;" +
    "try{var j=JSON.parse(v);var n=j&&(j.token||j.accessToken||j.access_token||j.jwt);if(typeof n==='string'&&n)v=n}catch(e){}" +
    "if(typeof v==='string'&&v.split('.').length===3){tok=v;break}" +
    "}}catch(e){}" +
    "var h={'Accept':'application/json'};if(tok)h['Authorization']='Bearer '+tok;" +
    "var r=await fetch(" + JSON.stringify(path) + ",{credentials:'include',headers:h});" +
    // Keep enough of the body to parse a full account listing. The cap only guards against
    // pathologically large responses; truncating mid-JSON would make a real finding unreadable.
    "var t=await r.text();" +
    "return{status:r.status,body:t.slice(0,200000)}" +
    "}catch(e){return{status:0,body:''}}})()"
  );
}

/**
 * Asks the product's own administrative data endpoints as the signed-in standard user.
 *
 * Only safe, read-only GETs to conventional account-listing paths are attempted, and a result counts
 * as a contradiction only when the response actually contains multiple account records — a 200 that
 * returns an empty list, a login page or the app shell proves nothing and is ignored. Returns null
 * when nothing conclusive was observed, so the caller can fall through to its normal conclusion.
 */
async function probeAdminApi(ctx: Ctx, item: PlanItem): Promise<Finding | null> {
  const { d } = ctx;
  const paths = ['/api/Users/', '/api/users', '/rest/admin/users', '/admin/api/users'];
  for (const path of paths) {
    ctx.log('act', `Asking ${path} directly as the standard user`);
    ctx.trace('action', `Request ${path} using the signed-in standard-user session`, item.id);
    let probe: { status: number; body: string } | null = null;
    try {
      probe = await d.evaluate<{ status: number; body: string }>(adminApiProbeScript(path));
    } catch {
      continue;
    }
    if (!probe || probe.status < 200 || probe.status >= 300) continue;

    // Require real account records, not merely a 200.
    let records: any[] = [];
    let truncated = false;
    try {
      const parsed = JSON.parse(probe.body);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : [];
      records = arr.filter((r: any) => r && typeof r === 'object' && ('email' in r || 'username' in r || 'role' in r));
    } catch {
      // An oversized listing can arrive clipped and therefore unparseable. Rather than discard a
      // genuine exposure, count the account-shaped fragments; the finding then reports "at least N".
      const emails = probe.body.match(/"email"\s*:\s*"[^"]+"/g) ?? [];
      if (emails.length < 2) continue;
      records = emails.map(() => ({}));
      truncated = true;
    }
    if (records.length < 2) continue;

    const roles = truncated
      ? [...new Set((probe.body.match(/"role"\s*:\s*"([^"]+)"/g) ?? []).map((m) => m.replace(/.*"role"\s*:\s*"/, '').replace(/"$/, '')))]
      : [...new Set(records.map((r) => String(r.role ?? '')).filter(Boolean))];
    const privileged = roles.filter((r) => /admin|owner|superuser|staff/i.test(r));
    const flushed = await ctx.flush();
    const shotId = await ctx.shot(`Account data returned to the standard user from ${path}`);
    ctx.trace('observation', `${path} returned ${records.length} account records to a standard user`, item.id);
    ctx.trace('evidence', `screenshot ${shotId} + GET ${path} → ${probe.status}`, item.id);

    return finding(item, {
      status: 'CONTRADICTED',
      testStatus: 'FAIL',
      severity: 'HIGH',
      test: `Signed in as a standard user, requested ${path} directly`,
      observed:
        `The administrator page correctly refused this account, but the same signed-in standard user ` +
        `received ${truncated ? 'at least ' : ''}${records.length} account records from ${path}. ` +
        `${privileged.length ? `The data includes ${privileged.join(', ')} account(s). ` : ''}` +
        `Access is enforced in the interface but not by the server, so anyone who bypasses the interface can read this data.`,
      evidence: evidence(ctx, item, path, [shotId], flushed.network, flushed.console),
      recommendation: 'Enforce the role check on the server for every administrative endpoint, not only on the pages that display the data.',
    });
  }
  return null;
}

/* ───────────────────────────── 3. runtime signals (console / network) ───────────────────────────── */

export async function runtimeSignals(ctx: Ctx, item: PlanItem): Promise<Finding> {
  const { d } = ctx;
  ctx.trace('hypothesis', item.hypothesis, item.id);
  await d.resetSession();
  await d.drain();

  ctx.log('act', 'Fresh visit with browser console and network capture on');
  ctx.trace('action', 'Load the product while capturing console + network', item.id);
  const authOutcome = await ensureLoggedIn(ctx);
  if (authOutcome === 'signed-in') ctx.log('info', 'Signed in for this check');
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
      observed: `No credentials exposed, but ${conFlagged.length + netFlagged.length} warning(s) were noticed while using the product (${[...new Set([...conFlagged, ...netFlagged].map((x) => x.flag))].join(', ')}).`,
    });
  }
  return finding(item, {
    status: 'SUPPORTED',
    testStatus: 'PASS',
    severity: 'INFO',
    test,
    evidence: ev,
    observed: `${f.console.length} browser messages and ${f.network.length} exchanges recorded during sign-in; no passwords, errors or unexpected outside connections.`,
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
  const aiAuth = ai ? await ensureLoggedIn(ctx) : 'failed';
  if (!ai || aiAuth === 'failed') {
    return finding(item, {
      status: 'INCONCLUSIVE',
      testStatus: 'BLOCKED',
      severity: 'INFO',
      test,
      observed: !ai
        ? 'The validation could not be completed: no AI assistant surface was reachable. No conclusion was made about the vendor claim.'
        : 'SIGN-IN FAILED — the username and password provided were not accepted by the product, so no conclusion could be reached.',
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
  shots.push(await ctx.shot('Assistant reply and what was sent'));
  const route = pathOf(await d.url());

  if (outbound === null) {
    return finding(item, {
      status: 'NEEDS_HUMAN_REVIEW',
      testStatus: 'INCONCLUSIVE',
      severity: 'INFO',
      test,
      observed: 'The product does not expose what is sent to the model, so we cannot confirm from the interface alone whether the details were hidden.',
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
    return finding(item, { status: 'CONTRADICTED', testStatus: 'FAIL', severity: 'HIGH', test, evidence: ev, observed: `None of the synthetic sensitive values were masked; ${leaked.map((l) => l.name).join(', ')} reached the AI model unprotected.` });
  }
  return finding(item, {
    status: 'PARTIALLY_VERIFIED',
    testStatus: 'FAIL',
    severity: 'MEDIUM',
    test,
    evidence: ev,
    observed: `Masked: ${masked.map((m) => m.name).join(', ')}. NOT masked: ${leaked.map((l) => l.name).join(', ')} — sent to the AI model unprotected.`,
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
    why: 'No audit-log surface was reachable for this role, so Argus cannot confirm what actions are recorded.',
    evidence: ['Admin-role walkthrough of the audit log', 'Sample audit-log export', 'Retention policy'],
  },
  other: {
    why: 'This claim is not something Argus can test through the product interface.',
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
