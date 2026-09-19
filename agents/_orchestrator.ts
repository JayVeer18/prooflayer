/**
 * ProofLayer orchestrator — private module.
 *
 * One orchestrator, clear phases:  PLAN → (human review) → EXECUTE → (human approval) → PROVE
 * Each call to /assess runs ONE segment and ends at the next human checkpoint. The sandbox browser
 * (one per conversation_id) keeps its state between segments.
 */
import { createDriver, type Driver } from './_driver';
import { buildClaims, extractClaims, templateFor } from './_claims';
import { llmJSON, modelName } from './_llm';
import { DEFAULT_AI_PAYLOAD, ensureLoggedIn, flagCon, flagNet, runTemplate, type Ctx } from './_tests';
import { now, pathOf, redact, withTimeout } from './_util';
import { effectiveRisk, gate } from './_policy';
import { transition, type AssessmentStatus } from './_state';
import type { Approval, Claim, ClaimStatus, ConEvt, Emit, Finding, NetEvt, PlanItem, Surface, TemplateId, TestStatus } from './_types';

export interface Io {
  context: any;
  emit: Emit;
  body: Record<string, any>;
}

const ORDER: Record<TemplateId, number> = {
  auth_session: 0,
  rbac_direct_nav: 1,
  ai_data_protection: 2,
  runtime_signals: 3,
  unverifiable: 4,
};

/* ─────────────────────────────── plan defaults ─────────────────────────────── */

export function defaults(claim: Claim): Omit<PlanItem, 'id' | 'claimId' | 'claim' | 'claimKey' | 'template' | 'enabled'> {
  switch (templateFor(claim.key)) {
    case 'rbac_direct_nav':
      return {
        title: 'Role boundary enforcement',
        hypothesis: 'A standard user cannot access administrative functionality.',
        expected: 'Standard user is denied (redirect, 401 or 403) on every privileged route.',
        rationale: 'Role-based access claims are testable by direct navigation and hidden-control discovery.',
        priority: 'high',
        procedure: [
          'Authenticate as a standard user',
          'Discover administrative routes (visible and hidden controls)',
          'Navigate directly to each privileged surface',
          'Observe the authorization response (redirect, 401/403, or rendered page)',
          'Capture evidence',
        ],
        risk: 'SAFE',
        requiresApproval: false,
      };
    case 'auth_session':
      return {
        title: 'Authentication & session behavior',
        hypothesis: 'Invalid credentials are rejected and protected pages require re-authentication after logout.',
        expected: 'Invalid login is rejected; a protected page redirects to sign-in after logout.',
        rationale: 'Session claims are testable through login, logout and protected-route requests.',
        priority: 'high',
        procedure: ['Submit an invalid password', 'Sign in with the provided credentials', 'Sign out', 'Request a protected page directly', 'Observe whether re-authentication is required'],
        risk: 'SAFE',
        requiresApproval: false,
      };
    case 'runtime_signals':
      return {
        title: 'Runtime hygiene (console & network)',
        hypothesis: 'Signing in does not expose credentials or tokens in the browser console or URLs.',
        expected: 'No credentials in console output or URLs; no uncaught errors or unexpected external calls.',
        rationale: 'Browser console and network traffic are directly observable.',
        priority: 'medium',
        procedure: ['Start from a signed-out browser', 'Sign in while capturing console and network activity', 'Inspect for credentials, errors and unexpected external calls'],
        risk: 'SAFE',
        requiresApproval: false,
      };
    case 'ai_data_protection':
      return {
        title: 'AI sensitive-data protection',
        hypothesis: 'Sensitive identifiers submitted to the AI assistant are masked before they are sent to the model.',
        expected: 'SSN, card number and email are masked in the outbound payload.',
        rationale: 'Submitting synthetic sensitive data is observable and safe, but it sends data to another system — so it needs your approval first.',
        priority: 'high',
        procedure: ['Open the AI assistant', 'Submit synthetic sensitive data (fake SSN, card number, email) — needs your approval', 'Inspect what is sent to the model'],
        risk: 'REVIEW',
        requiresApproval: true,
      };
    default:
      return {
        title: claim.key === 'audit' ? 'Audit trail (observability check)' : 'Documentation-backed claim',
        hypothesis: 'Assess whether this claim can be observed through the product interface.',
        expected: 'Claim is either verifiable through product behavior or explicitly reported as not verifiable.',
        rationale: 'Some claims cannot be proven from the outside; ProofLayer says so instead of guessing.',
        priority: 'low',
        procedure: ['Check whether the claim is observable through the product interface', 'If it is not, report NOT VERIFIED and recommend the evidence to request'],
        risk: 'SAFE',
        requiresApproval: false,
      };
  }
}

/* ─────────────────────────────────── context ─────────────────────────────────── */

function parseTarget(body: Record<string, any>): { target: URL; user: string; pass: string } {
  let target: URL;
  try {
    target = new URL(String(body.targetUrl ?? ''));
  } catch {
    throw new Error('A valid product URL is required (include https://).');
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error('Only http(s) product URLs are supported.');
  const user = String(body.username ?? '');
  const pass = String(body.password ?? '');
  // Credentials are optional: not every product requires authentication. If only one of the two
  // is given, that is a mistake worth surfacing rather than silently treating as "no auth".
  if ((user && !pass) || (pass && !user)) throw new Error('Provide both a username and a password, or leave both empty for a product that needs no sign-in.');
  return { target, user, pass };
}

function buildCtx(io: Io, d: Driver, target: URL, user: string, pass: string, surfaces: Surface[]): Ctx {
  const secrets = [pass];
  let n = 0;
  let s = 0;
  const runId = String(io.context.runId ?? io.context.conversation_id ?? `run-${Date.now().toString(36)}`);
  const PREFIX: Record<string, string> = { claim: 'clm', hypothesis: 'hyp', action: 'act', observation: 'obs', evidence: 'evd', finding: 'fnd' };
  const ctx: Ctx = {
    d,
    traceLog: [],
    target,
    user,
    pass,
    emit: io.emit,
    runId,
    surfaces,
    secrets,
    log: (level, text) => io.emit('log', { ts: now(), level, text: redact(text, secrets) }),
    trace: (kind, text, ref) => {
      const id = `${PREFIX[kind] ?? 'trc'}-${++n}`;
      ctx.traceLog.push({ id, kind, ref });
      io.emit('trace', { id, kind, text: redact(text, secrets), ts: now(), ref });
    },
    shot: async (label) => {
      try {
        const sh = await d.screenshot();
        const id = `s${Date.now().toString(36)}${s++}`;
        io.emit('screenshot', { id, label, route: pathOf(await d.url()), ts: now(), mime: sh.mime, b64: sh.b64 });
        return id;
      } catch (e) {
        ctx.log('warn', `Screenshot failed: ${(e as Error).message}`);
        return '';
      }
    },
    flush: async () => {
      const raw = await d.drain();
      const network: NetEvt[] = raw.network.map((e) => ({ ...e, url: redact(e.url, secrets), flag: flagNet(e, target.host) }));
      const con: ConEvt[] = raw.console.map((e) => ({ ...e, flag: flagCon(e), text: redact(e.text, secrets) }));
      network.forEach((e) => io.emit('net', e));
      con.forEach((e) => io.emit('con', e));
      return { console: con, network };
    },
  };
  return ctx;
}

async function persist(io: Io, snapshot: unknown) {
  try {
    await io.context.store?.state?.set?.('prooflayer.session', JSON.stringify(snapshot));
  } catch {
    /* best-effort */
  }
}

/** Attach the reasoning chain (claim → hypothesis → actions → observations → evidence) to a finding. */
export function linkFinding(ctx: Pick<Ctx, 'traceLog'>, item: PlanItem, f: Finding, approval?: Approval): Finding {
  const ids = (kind: string) => ctx.traceLog.filter((t) => t.ref === item.id && t.kind === kind).map((t) => t.id);
  const ev = f.evidence;
  return {
    ...f,
    hypothesisId: `h-${item.id}`,
    actionIds: ids('action'),
    observationIds: ids('observation'),
    evidenceIds: [
      ...ev.screenshotIds,
      ...(ev.route ? [`${f.id}:url`] : []),
      ...(ev.network.length ? [`${f.id}:net`] : []),
      ...(ev.console.length ? [`${f.id}:con`] : []),
      `${f.id}:trace`,
    ],
    approval: approval ? { decision: approval.decision, at: now(), modified: Boolean(approval.payload) } : undefined,
  };
}

/** A finding for a test that did not run (skipped, blocked by policy, or could not complete). */
function withoutRun(ctx: Ctx, item: PlanItem, status: ClaimStatus, testStatus: TestStatus, observed: string, approval?: Approval): Finding {
  return linkFinding(
    ctx,
    item,
    {
      id: `f-${item.id}`,
      testId: item.id,
      claimId: item.claimId,
      claim: item.claim,
      title: item.title,
      status,
      testStatus,
      severity: 'INFO',
      expected: item.expected,
      observed,
      test: item.hypothesis,
      evidence: { screenshotIds: [], route: '', timestamp: now(), network: [], console: [], traceRef: `${ctx.runId}#${item.id}` },
      hypothesisId: '',
      actionIds: [],
      observationIds: [],
      evidenceIds: [],
    },
    approval,
  );
}

/* ───────────────────────────────── PLAN phase ───────────────────────────────── */

export async function runPlan(io: Io): Promise<void> {
  const { emit, context } = io;
  const { target, user, pass } = parseTarget(io.body);
  const env = (context.env ?? {}) as Record<string, string | undefined>;
  const log = (level: 'info' | 'ok' | 'warn' | 'act', text: string) => emit('log', { ts: now(), level, text: redact(text, [pass]) });

  let st: AssessmentStatus = 'DISCOVERY';
  emit('status', { status: st });
  emit('phase', { phase: 'authenticate', label: 'Authenticating' });
  log('info', `Opening isolated browser for ${target.host}`);
  const d = await createDriver(context, (l, t) => log(l, t));
  try {
    emit('live', { url: d.liveUrl ?? null, mode: d.mode });
    const ctx = buildCtx(io, d, target, user, pass, []);

    await d.resetSession();
    await d.goto(target.href);
    const texts: string[] = [];
    texts.push(await d.text());
    await ctx.shot('Target loaded');

    log('act', user ? 'Signing in with the provided test credentials' : 'Checking whether the product requires authentication');
    const authOutcome = await ensureLoggedIn(ctx);
    let requiresAuth = true;
    if (authOutcome === 'no-auth-needed') {
      requiresAuth = false;
      log('ok', 'No sign-in form was found — this product does not appear to require authentication');
    } else if (authOutcome === 'failed') {
      emit('error', { kind: 'auth', message: 'AUTHENTICATION FAILED — ProofLayer could not establish the supplied test credentials. No assessment conclusion was made.' });
      return;
    } else {
      await ctx.shot('Signed in');
      log('ok', 'Signed in — credentials are held in memory for this run only');
    }
    await ctx.flush();

    /* ── discover ── */
    emit('phase', { phase: 'discover', label: 'Mapping product surfaces' });
    const links = await d.evaluate<Array<{ text: string; href: string; hidden: boolean }>>(`(function(){var out=[];document.querySelectorAll('a[href]').forEach(function(a){var h=a.getAttribute('href');if(!h||h[0]==='#'||/^(mailto|tel|javascript):/i.test(h))return;var r=a.getClientRects();var cs=getComputedStyle(a);var hid=!(r&&r.length)||cs.visibility==='hidden'||cs.display==='none';out.push({text:(a.innerText||a.textContent||'').trim(),href:a.href,hidden:hid});});return out;})()`);
    const seen = new Set<string>();
    const surfaces: Surface[] = [];
    for (const l of links) {
      let u: URL;
      try {
        u = new URL(l.href);
      } catch {
        continue;
      }
      if (u.origin !== target.origin || seen.has(u.pathname)) continue;
      seen.add(u.pathname);
      surfaces.push({ name: l.text || u.pathname, path: u.pathname, hidden: l.hidden });
    }

    let visited = 0;
    for (const s of surfaces.filter((x) => !x.hidden).slice(0, 6)) {
      log('act', `Visiting ${s.path}`);
      const r = await d.goto(new URL(s.path, target.origin).href);
      s.title = r.title;
      texts.push(await d.text());
      if (visited++ < 4) await ctx.shot(s.name || s.path);
      await ctx.flush();
    }
    const hidden = surfaces.filter((s) => s.hidden);
    if (hidden.length) log('warn', `${hidden.length} control(s) in the page source are hidden from this role: ${hidden.map((h) => h.path).join(', ')}`);
    log('ok', `${surfaces.length - hidden.length} surfaces mapped`);
    emit('surfaces', { items: surfaces });

    /* ── claims ── */
    emit('phase', { phase: 'plan', label: 'Interpreting claims & drafting plan' });
    const userClaims = String(io.body.claims ?? '')
      .split('\n')
      .map((c) => c.trim())
      .filter(Boolean);
    const claims = buildClaims(userClaims, extractClaims(texts));
    log('ok', `${claims.length} claims to validate (${claims.filter((c) => c.source !== 'baseline').length} from the vendor, ${claims.filter((c) => c.source === 'baseline').length} baseline)`);
    emit('claims', { items: claims });

    /* ── plan ── */
    const AUTH_DEPENDENT: TemplateId[] = ['auth_session', 'rbac_direct_nav'];
    let items: PlanItem[] = claims
      .map((c, i) => ({
        id: `t${i + 1}`,
        claimId: c.id,
        claim: c.text,
        claimKey: c.key,
        template: templateFor(c.key),
        enabled: true,
        ...defaults(c),
      }))
      .filter((it) => requiresAuth || !AUTH_DEPENDENT.includes(it.template));
    if (!requiresAuth) {
      const dropped = claims.length - items.length;
      if (dropped > 0) log('info', `${dropped} claim(s) about login/role boundaries were left out of the plan — this product does not require authentication`);
    }
    items.sort((a, b) => ORDER[a.template] - ORDER[b.template]);

    const llm = await llmJSON<{ items: Array<Partial<PlanItem> & { claimId: string }> }>(
      env,
      'You are the planning module of ProofLayer, a buyer-side product-assurance assistant. Reply with ONLY a JSON object.',
      JSON.stringify({
        task: 'For each claim write concise externally-testable wording. Return {"items":[{"claimId","title","hypothesis","expected","rationale"}]}. title<=7 words, hypothesis/expected one sentence each, rationale<=14 words. Do not add or remove claims.',
        surfaces: surfaces.filter((s) => !s.hidden).map((s) => s.name || s.path),
        claims: items.map((i) => ({ claimId: i.claimId, claim: i.claim, testType: i.template })),
      }),
    );
    if (llm.ok && Array.isArray(llm.data?.items)) {
      for (const g of llm.data!.items) {
        const it = items.find((x) => x.claimId === g.claimId);
        if (!it) continue;
        const pick = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
        it.title = pick(g.title, 70) ?? it.title;
        it.hypothesis = pick(g.hypothesis, 220) ?? it.hypothesis;
        it.expected = pick(g.expected, 220) ?? it.expected;
        it.rationale = pick(g.rationale, 120) ?? it.rationale;
      }
      log('ok', `Plan drafted by ${llm.model} via Makers Model Gateway (${llm.ms} ms)`);
    } else {
      log('warn', `Model Gateway unavailable (${llm.error}); using built-in plan templates`);
    }
    // Risk is derived from the final text in code — never from a model or client-supplied value.
    for (const it of items) {
      it.risk = effectiveRisk(it);
      it.requiresApproval = it.risk === 'REVIEW';
    }
    st = transition(st, 'PLAN');
    emit('status', { status: st });
    emit('plan', { items, source: llm.ok ? 'model' : 'fallback', model: llm.ok ? llm.model : null });
    st = transition(st, 'APPROVAL');
    emit('status', { status: st });
    emit('paused', { reason: 'plan_review' });
    await persist(io, { phase: 'plan_review', surfaces, claims, plan: items, updatedAt: now() });
  } finally {
    await d.close();
  }
}

/* ─────────────────────────────── EXECUTE / PROVE phase ─────────────────────────────── */

const COUNT_KEYS = ['SUPPORTED', 'CONTRADICTED', 'PARTIALLY_VERIFIED', 'NOT_VERIFIED', 'INCONCLUSIVE', 'NEEDS_HUMAN_REVIEW'] as const;

export async function runExecute(io: Io): Promise<void> {
  const { emit, context } = io;
  const { target, user, pass } = parseTarget(io.body);
  const env = (context.env ?? {}) as Record<string, string | undefined>;
  const plan = (Array.isArray(io.body.plan) ? io.body.plan : []) as PlanItem[];
  const surfaces = (Array.isArray(io.body.surfaces) ? io.body.surfaces : []) as Surface[];
  const findings = (Array.isArray(io.body.findings) ? io.body.findings : []) as Finding[];
  const approvals = (io.body.approvals ?? {}) as Record<string, Approval>;
  const from = Math.max(0, Number(io.body.fromIndex) || 0);
  if (!plan.length) throw new Error('No plan to execute.');

  emit('phase', { phase: 'execute', label: 'Executing assessment' });
  const d = await createDriver(context, (l, t) => emit('log', { ts: now(), level: l, text: t }));
  try {
    emit('live', { url: d.liveUrl ?? null, mode: d.mode });
    const ctx = buildCtx(io, d, target, user, pass, surfaces);

    let st: AssessmentStatus = from > 0 ? 'PAUSED' : 'APPROVAL';
    st = transition(st, 'EXECUTION');
    emit('status', { status: st });

    for (let i = from; i < plan.length; i++) {
      const item = plan[i];
      const g = gate(item, approvals); // policy is enforced here, server-side, on every call

      if (g === 'skip' || g === 'blocked') {
        const f =
          g === 'blocked'
            ? withoutRun(ctx, item, 'NEEDS_HUMAN_REVIEW', 'BLOCKED', 'Blocked by the ProofLayer safety policy: payments, destructive or mass operations, and anything outside the assessment scope are never executed.')
            : withoutRun(ctx, item, 'NOT_VERIFIED', 'SKIPPED', item.enabled ? 'The reviewer chose not to run this validation, so the claim remains unverified.' : 'Removed from the plan by the reviewer.', approvals[item.id]);
        findings.push(f);
        emit('test', { id: item.id, status: f.testStatus, title: item.title });
        emit('finding', f);
        continue;
      }

      if (g === 'ask') {
        emit('hitl', {
          id: item.id,
          kind: 'test_approval',
          title: 'Human review required',
          risk: effectiveRisk(item),
          body: `The next test submits synthetic sensitive data (a fake SSN, card number and email) to the product's AI assistant, to check what is sent to the model. Claim: “${item.claim}”.`,
          procedure: item.procedure,
          expected: item.expected,
          ifApproved: 'ProofLayer submits the synthetic data, observes the outbound payload and records the result.',
          ifSkipped: 'The claim stays NOT VERIFIED and nothing is submitted.',
          defaultPayload: DEFAULT_AI_PAYLOAD,
        });
        st = transition(st, 'PAUSED');
        emit('status', { status: st });
        emit('paused', { reason: 'test_approval', fromIndex: i, testId: item.id });
        await persist(io, { phase: 'awaiting_approval', testId: item.id, fromIndex: i, findings: findings.length, updatedAt: now() });
        return;
      }

      emit('test', { id: item.id, status: 'running', title: item.title });
      ctx.log('info', `Test ${i + 1}/${plan.length}: ${item.title}`);
      ctx.trace('claim', item.claim, item.id);
      let f: Finding;
      try {
        f = await withTimeout(runTemplate(ctx, item, approvals[item.id]), 90000, item.title);
      } catch (e) {
        const msg = redact(String((e as Error)?.message ?? e), [pass]);
        ctx.log('warn', `Test could not complete: ${msg}`);
        f = withoutRun(ctx, item, 'INCONCLUSIVE', 'BLOCKED', `The validation could not be completed (${msg}). No conclusion was made about the vendor claim.`);
      }
      f = linkFinding(ctx, item, f, approvals[item.id]);
      findings.push(f);
      ctx.trace('finding', `${f.status} — ${f.observed.slice(0, 140)}`, item.id);
      emit('test', { id: item.id, status: f.testStatus, title: item.title });
      emit('finding', f);
      ctx.log(f.status === 'CONTRADICTED' ? 'warn' : 'ok', `${item.title}: ${f.status.replace(/_/g, ' ')}`);
    }

    /* ── prove ── */
    st = transition(st, 'FINDINGS');
    emit('status', { status: st });
    emit('phase', { phase: 'prove', label: 'Compiling evidence-backed report' });
    const counts: Record<string, number> = {};
    for (const k of COUNT_KEYS) counts[k] = findings.filter((f) => f.status === k).length;
    const hero = findings.find((f) => f.status === 'CONTRADICTED' && f.severity === 'HIGH') ?? findings.find((f) => f.status === 'CONTRADICTED');

    let narrative =
      `${findings.length} vendor claims were evaluated against observed product behavior: ` +
      `${counts.SUPPORTED} supported, ${counts.CONTRADICTED} contradicted, ${counts.PARTIALLY_VERIFIED} partially verified, ${counts.NOT_VERIFIED} not verifiable from the outside.` +
      (hero ? ` Most important: “${hero.claim}” was contradicted — ${hero.observed}` : '');
    let source: 'model' | 'fallback' = 'fallback';
    const llm = await llmJSON<{ summary: string }>(
      env,
      'You write the executive summary of a buyer-side product assurance report. Reply with ONLY {"summary": "..."}. 3 sentences max, plain and factual. Never invent evidence.',
      JSON.stringify(findings.map((f) => ({ claim: f.claim, status: f.status, severity: f.severity, observed: redact(f.observed, [pass]).slice(0, 220) }))),
      15000,
    );
    if (llm.ok && typeof llm.data?.summary === 'string' && llm.data.summary.length > 20) {
      narrative = llm.data.summary.slice(0, 700);
      source = 'model';
      emit('log', { ts: now(), level: 'ok', text: `Summary written by ${modelName(env)} (${llm.ms} ms)` });
    }
    emit('complete', { counts, narrative, source, total: findings.length, heroId: hero?.id ?? null });
    await persist(io, { phase: 'complete', counts, findings: findings.map((f) => ({ id: f.id, status: f.status })), updatedAt: now() });
  } finally {
    await d.close();
  }
}
