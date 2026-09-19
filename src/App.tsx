import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newConversationId, runProbe, streamAssess } from './api';
import type { Approval, Claim, Complete, ConEvt, Finding, Hitl, LogLine, NetEvt, PlanItem, Shot, Surface, TraceStep } from './types';

type Screen = 'launch' | 'live' | 'plan' | 'report';
type Tab = 'activity' | 'network' | 'console' | 'claims' | 'evidence' | 'trace';

const STATUS_LABEL: Record<string, string> = {
  VERIFIED: 'Verified',
  CONTRADICTED: 'Contradicted',
  PARTIALLY_VERIFIED: 'Partially verified',
  NOT_VERIFIED: 'Not verified',
  NEEDS_HUMAN_REVIEW: 'Needs human review',
};
const hhmmss = (ts: string) => ts.slice(11, 19);
const pathOnly = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};

function Badge({ status }: { status: string }) {
  return <span className={`badge b-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('launch');
  const [tab, setTab] = useState<Tab>('activity');
  const cid = useRef(newConversationId());
  const findingsRef = useRef<Finding[]>([]);
  const approvalsRef = useRef<Record<string, Approval>>({});
  const pausedRef = useRef<{ reason: string; fromIndex?: number } | null>(null);
  const surfacesRef = useRef<Surface[]>([]);
  const planRef = useRef<PlanItem[]>([]);

  // Credentials live only in React memory — never localStorage, never logged.
  const [form, setForm] = useState({
    targetUrl: typeof location !== 'undefined' ? `${location.origin}/demo/` : '',
    username: 'buyer@acme-demo.test',
    password: 'Buyer#2026',
    claims: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [net, setNet] = useState<NetEvt[]>([]);
  const [con, setCon] = useState<ConEvt[]>([]);
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [shots, setShots] = useState<Record<string, Shot>>({});
  const [latest, setLatest] = useState('');
  const [live, setLive] = useState<{ url: string | null; mode: string } | null>(null);
  const [showLive, setShowLive] = useState(false);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [planSource, setPlanSource] = useState<{ source: string; model: string | null } | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [findings, setFindings] = useState<Finding[]>([]);
  const [hitl, setHitl] = useState<Hitl | null>(null);
  const [modify, setModify] = useState(false);
  const [payload, setPayload] = useState('');
  const [done, setDone] = useState<Complete | null>(null);
  const [probe, setProbe] = useState<any>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [logs]);

  const onEvent = useCallback((ev: string, d: any) => {
    switch (ev) {
      case 'phase':
        setPhase(d.label);
        break;
      case 'log':
        setLogs((l) => [...l, d]);
        break;
      case 'live':
        setLive(d);
        break;
      case 'screenshot':
        setShots((s) => ({ ...s, [d.id]: { id: d.id, label: d.label, route: d.route, ts: d.ts, src: `data:${d.mime};base64,${d.b64}` } }));
        setLatest(d.id);
        break;
      case 'surfaces':
        surfacesRef.current = d.items;
        setSurfaces(d.items);
        break;
      case 'claims':
        setClaims(d.items);
        break;
      case 'plan':
        planRef.current = d.items;
        setPlan(d.items);
        setPlanSource({ source: d.source, model: d.model });
        setScreen('plan');
        break;
      case 'net':
        setNet((n) => [...n, d]);
        break;
      case 'con':
        setCon((c) => [...c, d]);
        break;
      case 'trace':
        setTrace((t) => [...t, d]);
        break;
      case 'test':
        setTests((t) => ({ ...t, [d.id]: d.status }));
        break;
      case 'finding':
        findingsRef.current = [...findingsRef.current.filter((f) => f.id !== d.id), d];
        setFindings(findingsRef.current);
        break;
      case 'hitl':
        setHitl(d);
        setPayload(d.defaultPayload ?? '');
        setModify(false);
        break;
      case 'paused':
        pausedRef.current = d;
        break;
      case 'complete':
        setDone(d);
        setScreen('report');
        break;
      case 'error':
        setError(d.message);
        break;
    }
  }, []);

  const call = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError('');
      pausedRef.current = null;
      try {
        await streamAssess(cid.current, { ...body, targetUrl: form.targetUrl, username: form.username, password: form.password }, onEvent);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [form.targetUrl, form.username, form.password, onEvent],
  );

  const start = () => {
    cid.current = newConversationId();
    findingsRef.current = [];
    approvalsRef.current = {};
    setLogs([]);
    setNet([]);
    setCon([]);
    setTrace([]);
    setShots({});
    setFindings([]);
    setTests({});
    setDone(null);
    setHitl(null);
    setScreen('live');
    void call({ action: 'plan', claims: form.claims });
  };

  const execute = (fromIndex: number) => {
    setScreen('live');
    void call({
      action: 'execute',
      plan: planRef.current,
      surfaces: surfacesRef.current,
      fromIndex,
      findings: findingsRef.current,
      approvals: approvalsRef.current,
    });
  };

  const decide = (decision: 'run' | 'skip') => {
    if (!hitl) return;
    approvalsRef.current = { ...approvalsRef.current, [hitl.id]: { decision, payload: modify ? payload : undefined } };
    setHitl(null);
    execute(pausedRef.current?.fromIndex ?? 0);
  };

  const toggle = (id: string) => {
    planRef.current = planRef.current.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p));
    setPlan(planRef.current);
  };

  const shotFor = (f: Finding) => shots[f.evidence.screenshotIds[f.evidence.screenshotIds.length - 1]];
  const hero = useMemo(() => findings.find((f) => f.id === done?.heroId), [findings, done]);
  const current = shots[latest];

  /* ─────────────────────────────── screens ─────────────────────────────── */

  if (screen === 'launch') {
    return (
      <div className="launch">
        <div className="launch-card">
          <div className="wordmark">PROOFLAYER</div>
          <div className="eyebrow">Autonomous product assurance</div>
          <h1>
            Don’t ask if it’s enterprise-ready.
            <br />
            <em>Prove it.</em>
          </h1>
          <label>
            Product URL
            <input value={form.targetUrl} onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} />
          </label>
          <div className="row2">
            <label>
              Standard-user email
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />
            </label>
            <label>
              Password
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="off" />
            </label>
          </div>
          <label>
            Vendor claims to validate <span className="opt">optional — leave empty and ProofLayer finds them</span>
            <textarea rows={2} value={form.claims} onChange={(e) => setForm({ ...form, claims: e.target.value })} placeholder="One claim per line" />
          </label>
          <button className="primary" onClick={start} disabled={!form.targetUrl || !form.username || !form.password}>
            Run assessment
          </button>
          <div className="fine">Powered by Tencent EdgeOne Makers · Isolated browser assessment · Credentials stay in memory</div>
          <button
            className="link"
            onClick={async () => {
              setProbe({ running: true });
              try {
                setProbe(await runProbe(cid.current));
              } catch (e) {
                setProbe({ ok: false, error: String(e) });
              }
            }}
          >
            Run platform self-test
          </button>
          {probe && (
            <div className="probe">
              {probe.running ? (
                'Checking sandbox, browser, model, state…'
              ) : probe.error ? (
                probe.error
              ) : (
                <>
                  <b>{probe.ok ? '✓ All platform checks passed' : '⚠ Some checks failed'}</b> · driver: {probe.driverMode}
                  {probe.steps?.map((s: any) => (
                    <div key={s.name} className={s.ok ? 'ok' : 'bad'}>
                      {s.ok ? '✓' : '✗'} {s.name} <span>{s.detail}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (screen === 'plan') {
    return (
      <div className="page">
        <header className="bar">
          <span className="wordmark sm">PROOFLAYER</span>
          <span className="crumb">Assessment plan</span>
        </header>
        <main className="narrow">
          <div className="eyebrow">Discovered</div>
          <div className="chips">
            {surfaces
              .filter((s) => !s.hidden)
              .map((s) => (
                <span className="chip" key={s.path}>
                  ✓ {s.name || s.path}
                </span>
              ))}
            {surfaces
              .filter((s) => s.hidden)
              .map((s) => (
                <span className="chip warn" key={s.path} title="In the page source but hidden from this role">
                  ◐ {s.path} (hidden control)
                </span>
              ))}
          </div>
          <h2>Proposed validation</h2>
          <p className="muted">
            {claims.length} claims mapped to tests
            {planSource?.source === 'model' ? ` · drafted by ${planSource.model} on Makers Model Gateway` : ' · built-in templates (model unavailable)'}. Toggle anything you don’t want run.
          </p>
          <div className="plan">
            {plan.map((p, i) => (
              <label key={p.id} className={`plan-item ${p.enabled ? '' : 'off'}`}>
                <input type="checkbox" checked={p.enabled} onChange={() => toggle(p.id)} />
                <div>
                  <div className="pi-title">
                    {i + 1}. {p.title} <span className={`pri p-${p.priority}`}>{p.priority}</span>
                    {p.requiresApproval && <span className="pri ask">needs your approval</span>}
                  </div>
                  <div className="pi-claim">Claim: “{p.claim}”</div>
                  <div className="pi-line">
                    <b>Hypothesis</b> {p.hypothesis}
                  </div>
                  <div className="pi-line">
                    <b>Expected</b> {p.expected}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <div className="actions">
            <button className="ghost" onClick={() => setScreen('launch')}>
              Back
            </button>
            <button className="primary" onClick={() => execute(0)} disabled={busy || !plan.some((p) => p.enabled)}>
              Start assessment
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (screen === 'report') {
    const c = done?.counts ?? {};
    const heroShot = hero ? shotFor(hero) : undefined;
    return (
      <div className="page">
        <header className="bar">
          <span className="wordmark sm">PROOFLAYER</span>
          <span className="crumb">Assessment complete</span>
          <button className="ghost sm" onClick={() => setScreen('live')}>
            View live session
          </button>
        </header>
        <main className="wide">
          <div className="summary">
            <div>
              <div className="eyebrow">Assessment complete</div>
              <h2>{done?.total} claims evaluated</h2>
              <p className="narr">{done?.narrative}</p>
            </div>
            <div className="counts">
              {['VERIFIED', 'CONTRADICTED', 'PARTIALLY_VERIFIED', 'NOT_VERIFIED', 'NEEDS_HUMAN_REVIEW']
                .filter((k) => c[k])
                .map((k) => (
                  <div key={k} className={`count b-${k}`}>
                    <b>{c[k]}</b> {STATUS_LABEL[k]}
                  </div>
                ))}
            </div>
          </div>
          {hero && (
            <section className="hero">
              <div className="hero-l">
                <span className="sev">{hero.severity}</span>
                <h3>{hero.title}</h3>
                <dl>
                  <dt>Vendor claim</dt>
                  <dd>{hero.claim}</dd>
                  <dt>Expected</dt>
                  <dd>{hero.expected}</dd>
                  <dt>Observed</dt>
                  <dd>{hero.observed}</dd>
                  <dt>Evidence</dt>
                  <dd>
                    {hero.evidence.route} · {hhmmss(hero.evidence.timestamp)} UTC · trace {hero.evidence.traceRef}
                    {hero.evidence.network[0] && ` · ${hero.evidence.network[0].method} ${pathOnly(hero.evidence.network[0].url)} → ${hero.evidence.network[0].status}`}
                  </dd>
                </dl>
              </div>
              {heroShot && <img className="hero-shot" src={heroShot.src} alt="Evidence screenshot" />}
            </section>
          )}
          <h3 className="sect">All findings</h3>
          {findings.map((f) => (
            <details key={f.id} className="finding" open={f.id === hero?.id}>
              <summary>
                <Badge status={f.status} />
                <span className="ft">{f.title}</span>
                <span className="fc">“{f.claim}”</span>
              </summary>
              <div className="fbody">
                <div>
                  <b>Test</b> {f.test}
                </div>
                <div>
                  <b>Expected</b> {f.expected}
                </div>
                <div>
                  <b>Observed</b> {f.observed}
                </div>
                {f.recommendation && (
                  <div>
                    <b>Recommendation</b> {f.recommendation}
                  </div>
                )}
                <div className="muted">
                  Trace {f.evidence.traceRef} · {f.evidence.route || 'n/a'}
                </div>
                <div className="thumbs">
                  {f.evidence.screenshotIds.map(
                    (id) =>
                      shots[id] && (
                        <figure key={id}>
                          <img src={shots[id].src} alt={shots[id].label} />
                          <figcaption>{shots[id].label}</figcaption>
                        </figure>
                      ),
                  )}
                </div>
              </div>
            </details>
          ))}
          <div className="actions">
            <button className="ghost" onClick={() => setScreen('launch')}>
              New assessment
            </button>
          </div>
        </main>
      </div>
    );
  }

  // live
  const tabs: Array<[Tab, string]> = [
    ['activity', 'Activity'],
    ['network', `Network ${net.length}`],
    ['console', `Console ${con.length}`],
    ['claims', `Claims ${claims.length}`],
    ['evidence', `Evidence ${Object.keys(shots).length}`],
    ['trace', 'Trace'],
  ];
  return (
    <div className="page live">
      <header className="bar">
        <span className="wordmark sm">PROOFLAYER</span>
        <span className="crumb">
          {phase || 'Starting'}
          {busy && <i className="pulse" />}
        </span>
      </header>
      <div className="split">
        <section className="pane browser">
          <div className="pane-h">
            LIVE PRODUCT
            <span className="grow" />
            {live?.url && (
              <button className="ghost sm" onClick={() => setShowLive((v) => !v)}>
                {showLive ? 'Snapshots' : 'Live view'}
              </button>
            )}
            <span className="mode">{live?.mode ?? '…'}</span>
          </div>
          <div className="viewport">
            {showLive && live?.url ? (
              <iframe src={live.url} title="Live browser" />
            ) : current ? (
              <img src={current.src} alt={current.label} />
            ) : (
              <div className="empty">Starting isolated browser…</div>
            )}
            {current && !showLive && (
              <div className="cap">
                {current.label} · {current.route}
              </div>
            )}
          </div>
        </section>
        <aside className="pane side">
          <div className="pane-h">PROOFLAYER</div>
          <ul className="steps">
            {surfaces.length > 0 && <li className="done">{surfaces.filter((s) => !s.hidden).length} surfaces mapped</li>}
            {claims.length > 0 && <li className="done">{claims.length} claims identified</li>}
            {plan.length > 0 && <li className="done">{plan.filter((p) => p.enabled).length} tests approved</li>}
            {plan
              .filter((p) => tests[p.id])
              .map((p) => {
                const st = tests[p.id];
                const f = findings.find((x) => x.testId === p.id);
                return (
                  <li key={p.id} className={st === 'running' ? 'run' : 'done'}>
                    {p.title}
                    {f && (
                      <>
                        {' '}
                        <Badge status={f.status} />
                      </>
                    )}
                  </li>
                );
              })}
          </ul>
          {error && <div className="err">{error}</div>}
        </aside>
      </div>
      <section className="tabs">
        <nav>
          {tabs.map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </nav>
        <div className="tab-body">
          {tab === 'activity' && (
            <>
              {logs.map((l, i) => (
                <div key={i} className={`ln l-${l.level}`}>
                  <span>{hhmmss(l.ts)}</span>
                  {l.text}
                </div>
              ))}
              <div ref={logEnd} />
            </>
          )}
          {tab === 'network' &&
            net.map((n, i) => (
              <div key={i} className={`ln ${n.flag ? 'l-warn' : ''}`}>
                <span>{hhmmss(n.ts)}</span>
                {n.method} {pathOnly(n.url)} → <b>{n.status}</b> {n.flag && <em>[{n.flag}]</em>}
              </div>
            ))}
          {tab === 'console' &&
            (con.length ? (
              con.map((c, i) => (
                <div key={i} className={`ln ${c.flag ? 'l-warn' : ''}`}>
                  <span>{hhmmss(c.ts)}</span>[{c.type}] {c.text} {c.flag && <em>[{c.flag}]</em>}
                </div>
              ))
            ) : (
              <div className="muted">No console output captured yet.</div>
            ))}
          {tab === 'claims' &&
            claims.map((c) => {
              const f = findings.find((x) => x.claimId === c.id);
              return (
                <div key={c.id} className="ln">
                  <span>{c.source}</span>
                  {c.text} {f ? <Badge status={f.status} /> : <em>pending</em>}
                </div>
              );
            })}
          {tab === 'evidence' && (
            <div className="thumbs">
              {Object.values(shots).map((s) => (
                <figure key={s.id}>
                  <img
                    src={s.src}
                    alt={s.label}
                    onClick={() => {
                      setLatest(s.id);
                      setShowLive(false);
                    }}
                  />
                  <figcaption>{s.label}</figcaption>
                </figure>
              ))}
            </div>
          )}
          {tab === 'trace' &&
            trace.map((t) => (
              <div key={t.id} className="ln">
                <span>{t.kind}</span>
                {t.text}
              </div>
            ))}
        </div>
      </section>

      {hitl && (
        <div className="overlay">
          <div className="modal">
            <div className="eyebrow">ProofLayer needs your input</div>
            <p>{hitl.body}</p>
            <p className="muted">
              <b>Expected behavior:</b> {hitl.expected}
            </p>
            {modify && <textarea rows={4} value={payload} onChange={(e) => setPayload(e.target.value)} />}
            <div className="actions">
              <button className="ghost" onClick={() => decide('skip')}>
                Skip
              </button>
              <button className="ghost" onClick={() => setModify((m) => !m)}>
                {modify ? 'Use default' : 'Modify test'}
              </button>
              <button className="primary" onClick={() => decide('run')}>
                Run validation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
