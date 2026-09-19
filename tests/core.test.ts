/**
 * Core behaviour tests — run with `npm test`.
 * Uses a scripted FakeDriver, so no real browser is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Driver } from '../agents/_driver';
import { buildClaims, claimKey, templateFor } from '../agents/_claims';
import { defaults, linkFinding } from '../agents/_orchestrator';
import { effectiveRisk, gate } from '../agents/_policy';
import { canTransition, transition } from '../agents/_state';
import { authSession, rbacDirectNav, unverifiable, type Ctx } from '../agents/_tests';
import type { NetEvt, PlanItem } from '../agents/_types';

/* ───────────────────────────── scripted fake browser ───────────────────────────── */

class FakeDriver implements Driver {
  readonly mode = 'fake';
  readonly liveUrl = undefined;
  private loggedIn = false;
  private pass = '';
  private pending: NetEvt[] = [];
  private cur = { url: '', status: 200, title: '', text: '', loginForm: false, rows: 0 };

  constructor(private cfg: { adminAccessible: boolean; goodPass: string; loginWorks?: boolean; noAuth?: boolean }) {}

  private pageFor(u: URL) {
    const login = { url: '/demo/login/', status: 200, title: 'Sign in', text: 'Sign in', loginForm: true, rows: 0 };
    const p = u.pathname;
    // A product with no authentication at all: every page renders directly, there is never a login form.
    if (this.cfg.noAuth) {
      if (/admin\/users/.test(p)) {
        if (!this.cfg.adminAccessible) return { url: p, status: 404, title: 'Not found', text: 'Page not found', loginForm: false, rows: 0 };
        return { url: p, status: 200, title: 'User Management', text: 'User Management — administrators only', loginForm: false, rows: 4 };
      }
      if (p === '/demo/' || p === '/demo/login/') return { url: '/demo/dashboard/', status: 200, title: 'Dashboard', text: 'Dashboard', loginForm: false, rows: 0 };
      return { url: p, status: 200, title: 'Page', text: 'Page', loginForm: false, rows: 0 };
    }
    if (p === '/demo/' || p === '/demo/login/') return this.loggedIn ? { ...login, url: '/demo/dashboard/', title: 'Dashboard', text: 'Dashboard', loginForm: false } : login;
    if (!this.loggedIn) return login;
    if (/admin\/users/.test(p)) {
      if (!this.cfg.adminAccessible) return login;
      this.pending.push({ ts: '', method: 'GET', url: 'https://x.test/demo/api/users.json', status: 200, kind: 'fetch' });
      return { url: p, status: 200, title: 'User Management', text: 'User Management — administrators only', loginForm: false, rows: 4 };
    }
    return { url: p, status: 200, title: 'Page', text: 'Page', loginForm: false, rows: 0 };
  }

  async goto(url: string) {
    this.cur = this.pageFor(new URL(url));
    return { url: new URL(this.cur.url, 'https://x.test').href, status: this.cur.status, title: this.cur.title };
  }
  async fill(selector: string, text: string) {
    if (selector.includes('password')) this.pass = text;
  }
  async click() {
    if (this.cfg.loginWorks !== false && this.pass === this.cfg.goodPass) {
      this.loggedIn = true;
      this.cur = this.pageFor(new URL('https://x.test/demo/'));
    }
  }
  async clickText(texts: string[]) {
    if (texts.some((t) => /log ?out|sign out/.test(t))) {
      this.loggedIn = false;
      this.cur = this.pageFor(new URL('https://x.test/demo/'));
      return true;
    }
    return false;
  }
  async evaluate<T>(script: string): Promise<T> {
    if (script.includes('input[type="password"]')) return this.cur.loginForm as T;
    if (script.includes('tbody tr')) return this.cur.rows as T;
    if (script.includes('invalid|incorrect')) return (this.cur.loginForm ? 'Invalid email or password.' : '') as T;
    return '' as T;
  }
  async screenshot() {
    return { b64: 'x', mime: 'image/png' };
  }
  async url() {
    return new URL(this.cur.url, 'https://x.test').href;
  }
  async text() {
    return this.cur.text;
  }
  async title() {
    return this.cur.title;
  }
  async settle() {}
  async resetSession() {
    this.loggedIn = false;
  }
  async drain() {
    const network = this.pending;
    this.pending = [];
    return { console: [], network };
  }
  async close() {}
}

function mkCtx(d: FakeDriver, creds: { user: string; pass: string } = { user: 'buyer@x.test', pass: d['cfg'].goodPass }): Ctx {
  const traceLog: Ctx['traceLog'] = [];
  let n = 0;
  return {
    d,
    traceLog,
    target: new URL('https://x.test/demo/'),
    user: creds.user,
    pass: creds.pass,
    emit: () => {},
    runId: 'run-1',
    surfaces: [{ name: 'Admin', path: '/demo/admin/users/', hidden: true }],
    secrets: [],
    log: () => {},
    trace: (kind, _text, ref) => void traceLog.push({ id: `${kind}-${++n}`, kind, ref }),
    shot: async () => `shot-${++n}`,
    flush: async () => d.drain(),
  };
}

const rbacItem = (): PlanItem => {
  const claim = buildClaims(['Enterprise-grade role-based access control'], [])[0];
  return { id: 't1', claimId: claim.id, claim: claim.text, claimKey: claim.key, template: templateFor(claim.key), enabled: true, ...defaults(claim) };
};

/* ───────────────────────────── 1. claim conversion ───────────────────────────── */

test('claim → hypothesis: an RBAC claim becomes an executable hypothesis with a procedure', () => {
  assert.equal(claimKey('Enterprise-grade role-based access control.'), 'rbac');
  assert.equal(templateFor('rbac'), 'rbac_direct_nav');
  const item = rbacItem();
  assert.match(item.hypothesis, /standard user cannot access administrative/i);
  assert.ok(item.procedure.length >= 4);
  assert.ok(item.procedure.some((s) => /navigate directly/i.test(s)));
  assert.match(item.expected, /denied/i);
  assert.equal(item.risk, 'SAFE');
});

test('claim conversion: data-usage commitments map to a documentation-only test, never a browser test', () => {
  assert.equal(templateFor(claimKey('Customer data is never used to train external AI models')), 'unverifiable');
});

/* ───────────────────────────── 2. result classification ───────────────────────────── */

test('classification: expected denied + observed allowed → CONTRADICTED (HIGH)', async () => {
  const d = new FakeDriver({ adminAccessible: true, goodPass: 'good' });
  const f = await rbacDirectNav(mkCtx(d), rbacItem());
  assert.equal(f.status, 'CONTRADICTED');
  assert.equal(f.severity, 'HIGH');
  assert.match(f.observed, /\/demo\/admin\/users\//);
  assert.ok(f.evidence.network.some((n) => n.status === 200));
});

test('classification: expected denied + observed denied → SUPPORTED', async () => {
  const d = new FakeDriver({ adminAccessible: false, goodPass: 'good' });
  const f = await rbacDirectNav(mkCtx(d), rbacItem());
  assert.equal(f.status, 'SUPPORTED');
});

test('classification: session behaviour is SUPPORTED when logout invalidates the session', async () => {
  const d = new FakeDriver({ adminAccessible: false, goodPass: 'good' });
  const item = { ...rbacItem(), id: 't2', template: 'auth_session' as const };
  const f = await authSession(mkCtx(d), item);
  assert.equal(f.status, 'SUPPORTED');
});

test('failure behaviour: bad credentials → INCONCLUSIVE with an explicit "no conclusion" statement', async () => {
  const d = new FakeDriver({ adminAccessible: true, goodPass: 'good', loginWorks: false });
  const item = { ...rbacItem(), id: 't2', template: 'auth_session' as const };
  const f = await authSession(mkCtx(d), item);
  assert.equal(f.status, 'INCONCLUSIVE');
  assert.match(f.observed, /AUTHENTICATION FAILED/);
  assert.match(f.observed, /No assessment conclusion was made/);
});

test('honesty: an unverifiable claim is NOT_VERIFIED with recommended evidence, never a guess', () => {
  const claim = buildClaims(['Customer data is never used to train external AI models'], [])[0];
  const item: PlanItem = { id: 't9', claimId: claim.id, claim: claim.text, claimKey: claim.key, template: 'unverifiable', enabled: true, ...defaults(claim) };
  const f = unverifiable(mkCtx(new FakeDriver({ adminAccessible: false, goodPass: 'good' })), item);
  assert.equal(f.status, 'NOT_VERIFIED');
  assert.match(f.recommendation ?? '', /Data-processing agreement/);
});

/* ───────────────────────────── 3. human-in-the-loop ───────────────────────────── */

const aiItem = (): PlanItem => {
  const claim = buildClaims(['Sensitive data is masked before it reaches the AI model'], [])[0];
  return { id: 't4', claimId: claim.id, claim: claim.text, claimKey: claim.key, template: 'ai_data_protection', enabled: true, ...defaults(claim) };
};

test('HITL: a REVIEW action cannot execute before approval', () => {
  assert.equal(gate(aiItem(), {}), 'ask');
  assert.equal(gate(aiItem(), { t4: { decision: 'run' } }), 'run');
  assert.equal(gate(aiItem(), { t4: { decision: 'skip' } }), 'skip');
});

test('HITL: a client cannot downgrade risk to bypass approval', () => {
  const tampered = { ...aiItem(), risk: 'SAFE' as const, requiresApproval: false };
  assert.equal(effectiveRisk(tampered), 'REVIEW');
  assert.equal(gate(tampered, {}), 'ask');
});

test('safety: BLOCKED actions never run, even when approved', () => {
  const evil: PlanItem = { ...rbacItem(), id: 't7', hypothesis: 'Complete a payment with the saved card', procedure: ['Click checkout and pay'] };
  assert.equal(gate(evil, { t7: { decision: 'run' } }), 'blocked');
});

test('safety: removing a test from the plan skips it', () => {
  assert.equal(gate({ ...rbacItem(), enabled: false }, {}), 'skip');
});

/* ───────────────────────────── 4. evidence linkage ───────────────────────────── */

test('evidence: a finding references its hypothesis, actions, observations and evidence', async () => {
  const d = new FakeDriver({ adminAccessible: true, goodPass: 'good' });
  const ctx = mkCtx(d);
  const item = rbacItem();
  const raw = await rbacDirectNav(ctx, item);
  const f = linkFinding(ctx, item, raw);
  assert.equal(f.hypothesisId, 'h-t1');
  assert.ok(f.actionIds.length >= 1, 'has action ids');
  assert.ok(f.observationIds.length >= 1, 'has observation ids');
  assert.ok(f.evidence.screenshotIds.length >= 1, 'has a screenshot');
  for (const id of f.evidence.screenshotIds) assert.ok(f.evidenceIds.includes(id));
  assert.ok(f.evidenceIds.includes(`${f.id}:trace`));
  assert.match(f.evidence.traceRef, /^run-1#t1$/);
});

/* ───────────────────────────── 5. assessment state ───────────────────────────── */

test('state: DISCOVERY → PLAN → APPROVAL → EXECUTION → FINDINGS, with pause/resume', () => {
  let s = transition('DISCOVERY', 'PLAN');
  s = transition(s, 'APPROVAL');
  s = transition(s, 'EXECUTION');
  s = transition(s, 'PAUSED');
  s = transition(s, 'EXECUTION');
  s = transition(s, 'FINDINGS');
  assert.equal(s, 'FINDINGS');
  assert.equal(canTransition('FINDINGS', 'EXECUTION'), false);
});

test('state: execution cannot start before the plan is approved', () => {
  assert.throws(() => transition('PLAN', 'EXECUTION'), /Illegal assessment transition/);
});

/* ───────────────────────────── 6. optional authentication ───────────────────────────── */

test('optional auth: a product with no login form is NOT_VERIFIED/SKIPPED for session claims, not INCONCLUSIVE', async () => {
  const d = new FakeDriver({ adminAccessible: false, goodPass: 'good', noAuth: true });
  const item = { ...rbacItem(), id: 't2', template: 'auth_session' as const };
  const f = await authSession(mkCtx(d, { user: '', pass: '' }), item);
  assert.equal(f.status, 'NOT_VERIFIED');
  assert.equal(f.testStatus, 'SKIPPED');
  assert.doesNotMatch(f.observed, /AUTHENTICATION FAILED/);
  assert.match(f.observed, /does not appear to require authentication|no sign-in form/i);
});

test('optional auth: an RBAC claim on a no-auth product is skipped as not applicable, never reported as a failed login', async () => {
  const d = new FakeDriver({ adminAccessible: true, goodPass: 'good', noAuth: true });
  const f = await rbacDirectNav(mkCtx(d, { user: '', pass: '' }), rbacItem());
  assert.equal(f.status, 'NOT_VERIFIED');
  assert.equal(f.testStatus, 'SKIPPED');
  assert.doesNotMatch(f.observed, /AUTHENTICATION FAILED/);
});

test('optional auth: wrong credentials on a product that DOES have a login form still fail honestly', async () => {
  const d = new FakeDriver({ adminAccessible: false, goodPass: 'good', loginWorks: false });
  const item = { ...rbacItem(), id: 't2', template: 'auth_session' as const };
  const f = await authSession(mkCtx(d, { user: 'buyer@x.test', pass: 'wrong' }), item);
  assert.equal(f.status, 'INCONCLUSIVE');
  assert.match(f.observed, /AUTHENTICATION FAILED/);
});
