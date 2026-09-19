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
import type { Approval, Claim, ConEvt, Emit, Finding, NetEvt, PlanItem, Surface, TemplateId } from './_types';

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

function defaults(claim: Claim): Omit<PlanItem, 'id' | 'claimId' | 'claim' | 'claimKey' | 'template' | 'enabled'> {
  switch (templateFor(claim.key)) {
    case 'rbac_direct_nav':
      return {
        title: 'Role boundary enforcement',
        hypothesis: 'A standard user cannot open administrative pages by navigating to them directly.',
        expected: 'Standard user is denied (redirect, 401 or 403) on every privileged route.',
        rationale: 'Role-based access claims are testable by direct navigation and hidden-control discovery.',
        priority: 'high',
        requiresApproval: false,
      };
    case 'auth_session':
      return {
        title: 'Authentication & session behavior',
        hypothesis: 'Invalid credentials are rejected and protected pages require re-authentication after logout.',
        expected: 'Invalid login is rejected; a protected page redirects to sign-in after logout.',
        rationale: 'Session claims are testable through login, logout and protected-route requests.',
        priority: 'high',
        requiresApproval: false,
      };
    case 'runtime_signals':
      return {
        title: 'Runtime hygiene (console & network)',
        hypothesis: 'Signing in does not expose credentials or tokens in the browser console or URLs.',
        expected: 'No credentials in console output or URLs; no uncaught errors or unexpected external calls.',
        rationale: 'Browser console and network traffic are directly observable.',
        priority: 'medium',
        requiresApproval: false,
      };
    case 'ai_data_protection':
      return {
        title: 'AI sensitive-data protection',
        hypothesis: 'Sensitive identifiers submitted to the AI assistant are masked before they are sent to the model.',
        expected: 'SSN, card number and email are masked in the outbound payload.',
        rationale: 'Submitting synthetic sensitive data is a safe, observable test — it needs your approval first.',
        priority: 'high',
        requiresApproval: true,
      };
    default:
      return {
        title: claim.key === 'audit' ? 'Audit trail (observability check)' : 'Documentation-backed claim',
        hypothesis: 'Assess whether this claim can be observed through the product interface.',
        expected: 'Claim is either verifiable through product behavior or explicitly reported as not verifiable.',
        rationale: 'Some claims cannot be proven from the outside; ProofLayer says so instead of guessing.',
        priority: 'low',
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
  if (!user || !pass) throw new Error('Test credentials are required.');
  return { target, user, pass };
}

function buildCtx(io: Io, d: Driver, target: URL, user: string, pass: string, surfaces: Surface[]): Ctx {
  const secrets = [pass];
  let n = 0;
  let s = 0;
  const runId = String(io.context.runId ?? io.context.conversation_id ?? `run-${Date.now().toString(36)}`);
  const ctx: Ctx = {
    d,
    target,
    user,
    pass,
    emit: io.emit,
    runId,
    surfaces,
    secrets,
    log: (level, text) => io.emit('log', { ts: now(), level, text: redact(text, secrets) }),
    trace: (kind, text, ref) => io.emit('trace', { id: `t${++n}`, kind, text: redact(text, secrets), ts: now(), ref }),
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

/* ───────────────────────────────── PLAN phase ───────────────────────────────── */

export async function runPlan(io: Io): Promise<void> {
  const { emit, context } = io;
  const { target, user, pass } = parseTarget(io.body);
  const env = (context.env ?? {}) as Record<string, string | undefined>;
  const log = (level: 'info' | 'ok' | 'warn' | 'act', text: string) => emit('log', { ts: now(), level, text: redact(text, [pass]) });

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

    log('act', 'Signing in with the provided test credentials');
    const ok = await ensureLoggedIn(ctx);
    if (!ok) {
      emit('error', { message: 'Sign-in failed with the provided credentials. Check the username and password and try again.' });
      return;
    }
    await ctx.shot('Signed in');
    log('ok', 'Signed in — credentials are held in memory for this run only');
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
    let items: PlanItem[] = claims.map((c, i) => ({
      id: `t${i + 1}`,
      claimId: c.id,
      claim: c.text,
      claimKey: c.key,
      template: templateFor(c.key),
      enabled: true,
      ...defaults(c),
    }));
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
    emit('plan', { items, source: llm.ok ? 'model' : 'fallback', model: llm.ok ? llm.model : null });
    emit('paused', { reason: 'plan_review' });
    await persist(io, { phase: 'plan_review', surfaces, claims, plan: items, updatedAt: now() });
  } finally {
    await d.close();
  }
}

/* ─────────────────────────────── EXECUTE / PROVE phase ─────────────────────────────── */

const COUNT_KEYS = ['VERIFIED', 'CONTRADICTED', 'PARTIALLY_VERIFIED', 'NOT_VERIFIED', 'NEEDS_HUMAN_REVIEW'] as const;

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

    for (let i = from; i < plan.length; i++) {
      const item = plan[i];
      if (!item.enabled) {
        const f: Finding = {
          id: `f-${item.id}`, testId: item.id, claimId: item.claimId, claim: item.claim, title: item.title,
          status: 'NOT_VERIFIED', testStatus: 'SKIPPED', severity: 'INFO', expected: item.expected,
          observed: 'Removed from the plan by the reviewer.', test: 'Skipped by reviewer',
          evidence: { screenshotIds: [], route: '', timestamp: now(), network: [], console: [], traceRef: `${ctx.runId}#${item.id}` },
        };
        findings.push(f);
        emit('test', { id: item.id, status: 'SKIPPED', title: item.title });
        emit('finding', f);
        continue;
      }

      if (item.requiresApproval && !approvals[item.id]) {
        emit('hitl', {
          id: item.id,
          kind: 'test_approval',
          title: 'ProofLayer needs your input',
          body: `I found an AI data-protection claim: “${item.claim}”. I can validate it by submitting synthetic sensitive data (a fake SSN, card number and email) to the AI assistant and checking what is sent to the model.`,
          expected: item.expected,
          defaultPayload: DEFAULT_AI_PAYLOAD,
        });
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
        f = {
          id: `f-${item.id}`, testId: item.id, claimId: item.claimId, claim: item.claim, title: item.title,
          status: 'NEEDS_HUMAN_REVIEW', testStatus: 'BLOCKED', severity: 'INFO', expected: item.expected,
          observed: `The test could not complete: ${msg}`, test: item.hypothesis,
          evidence: { screenshotIds: [], route: '', timestamp: now(), network: [], console: [], traceRef: `${ctx.runId}#${item.id}` },
        };
      }
      findings.push(f);
      ctx.trace('finding', `${f.status} — ${f.observed.slice(0, 140)}`, item.id);
      emit('test', { id: item.id, status: f.testStatus, title: item.title });
      emit('finding', f);
      ctx.log(f.status === 'CONTRADICTED' ? 'warn' : 'ok', `${item.title}: ${f.status.replace(/_/g, ' ')}`);
    }

    /* ── prove ── */
    emit('phase', { phase: 'prove', label: 'Compiling evidence-backed report' });
    const counts: Record<string, number> = {};
    for (const k of COUNT_KEYS) counts[k] = findings.filter((f) => f.status === k).length;
    const hero = findings.find((f) => f.status === 'CONTRADICTED' && f.severity === 'HIGH') ?? findings.find((f) => f.status === 'CONTRADICTED');

    let narrative =
      `${findings.length} vendor claims were evaluated against observed product behavior: ` +
      `${counts.VERIFIED} verified, ${counts.CONTRADICTED} contradicted, ${counts.PARTIALLY_VERIFIED} partially verified, ${counts.NOT_VERIFIED} not verifiable from the outside.` +
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
