import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newConversationId, runProbe, streamAssess } from './api';
import { DEFAULT_CLAIMS, DEMO_TARGET, loadHistory, saveHistory } from './model';
import { streamReplay } from './replay';
import type {
  Approval, AssessmentStatus, Claim, Complete, ConEvt, Finding, Hitl, LogLine, NetEvt, PlanItem,
  Route, Shot, StoredAssessment, Surface, TraceStep,
} from './types';

export function useAssessment() {
  const [route, setRoute] = useState<Route>('landing');
  const cid = useRef(newConversationId());
  const findingsRef = useRef<Finding[]>([]);
  const approvalsRef = useRef<Record<string, Approval>>({});
  const pausedRef = useRef<{ reason: string; fromIndex?: number } | null>(null);
  const surfacesRef = useRef<Surface[]>([]);
  const planRef = useRef<PlanItem[]>([]);
  const replayRef = useRef(false);

  // Credentials live only in React memory — never localStorage, never logged.
  // The defaults point at our own OWASP Juice Shop instance, signed in as a standard "customer"
  // account with no administrative rights — the role the role-boundary claim is about.
  const [form, setForm] = useState({
    targetUrl: DEMO_TARGET.url,
    username: DEMO_TARGET.username,
    password: DEMO_TARGET.password,
    claims: DEFAULT_CLAIMS.join('\n'),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; kind?: string } | null>(null);
  const [status, setStatus] = useState<AssessmentStatus | null>(null);
  const [phase, setPhase] = useState('');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [net, setNet] = useState<NetEvt[]>([]);
  const [con, setCon] = useState<ConEvt[]>([]);
  const [trace, setTrace] = useState<TraceStep[]>([]);
  const [shots, setShots] = useState<Record<string, Shot>>({});
  const [latest, setLatest] = useState('');
  const [lastEvidence, setLastEvidence] = useState('');
  const [live, setLive] = useState<{ url: string | null; mode: string } | null>(null);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [planSource, setPlanSource] = useState<{ source: string; model: string | null } | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [findings, setFindings] = useState<Finding[]>([]);
  const [hitl, setHitl] = useState<Hitl | null>(null);
  const [done, setDone] = useState<Complete | null>(null);
  const [replay, setReplay] = useState(false);
  const [resultCard, setResultCard] = useState<Finding | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [history, setHistory] = useState<StoredAssessment[]>(() => loadHistory());
  const [fromHistory, setFromHistory] = useState(false);
  const [startedAt, setStartedAt] = useState('');
  const [probe, setProbe] = useState<any>(null);
  const seenHero = useRef(false);
  const evTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(evTimer.current), []);

  const onEvent = useCallback((ev: string, d: any) => {
    switch (ev) {
      case 'status': setStatus(d.status); break;
      case 'phase': setPhase(d.label); break;
      case 'log': setLogs((l) => [...l, d]); break;
      case 'live': setLive(d); break;
      case 'screenshot':
        setShots((s) => ({ ...s, [d.id]: { id: d.id, label: d.label, route: d.route, ts: d.ts, src: `data:${d.mime};base64,${d.b64}` } }));
        setLatest(d.id);
        setLastEvidence(d.label);
        window.clearTimeout(evTimer.current);
        evTimer.current = window.setTimeout(() => setLastEvidence(''), 2600);
        break;
      case 'surfaces': surfacesRef.current = d.items; setSurfaces(d.items); break;
      case 'claims': setClaims(d.items); break;
      case 'plan':
        planRef.current = d.items;
        setPlan(d.items);
        setPlanSource({ source: d.source, model: d.model });
        setRoute('plan');
        break;
      case 'net': setNet((n) => [...n, d]); break;
      case 'con': setCon((c) => [...c, d]); break;
      case 'trace': setTrace((t) => [...t, d]); break;
      case 'test': setTests((t) => ({ ...t, [d.id]: d.status })); break;
      case 'finding':
        findingsRef.current = [...findingsRef.current.filter((f) => f.id !== d.id), d];
        setFindings(findingsRef.current);
        // The peak moment: the first contradiction gets the stage.
        if (d.status === 'CONTRADICTED' && d.severity === 'HIGH' && !seenHero.current) {
          seenHero.current = true;
          setResultCard(d);
        }
        break;
      case 'hitl': setHitl(d); break;
      case 'paused': pausedRef.current = d; break;
      case 'complete': setDone(d); break;
      case 'error': setError({ message: d.message, kind: d.kind }); break;
    }
  }, []);

  const call = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      pausedRef.current = null;
      try {
        if (replayRef.current) await streamReplay(body, onEvent);
        else await streamAssess(cid.current, { ...body, targetUrl: form.targetUrl, username: form.username, password: form.password }, onEvent);
      } catch (e) {
        setError({ message: e instanceof Error ? e.message : String(e) });
      } finally {
        setBusy(false);
      }
    },
    [form.targetUrl, form.username, form.password, onEvent],
  );

  /** Persist a non-secret summary once an assessment completes. */
  useEffect(() => {
    if (!done || fromHistory) return;
    const entry: StoredAssessment = {
      id: cid.current, at: new Date().toISOString(), target: form.targetUrl, replay, counts: done.counts,
      narrative: done.narrative, total: done.total, heroId: done.heroId, findings: findingsRef.current,
    };
    setHistory(saveHistory(entry));
    setRoute('results');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const reset = () => {
    findingsRef.current = [];
    approvalsRef.current = {};
    seenHero.current = false;
    setLogs([]); setNet([]); setCon([]); setTrace([]); setShots({}); setFindings([]); setTests({});
    setDone(null); setHitl(null); setResultCard(null); setError(null); setPlan([]); setClaims([]); setSurfaces([]);
    setStatus('DISCOVERY'); setFromHistory(false); setSelected(''); setLive(null); setLatest('');
  };

  const generatePlan = (asReplay = false) => {
    replayRef.current = asReplay;
    setReplay(asReplay);
    cid.current = newConversationId();
    setStartedAt(new Date().toISOString());
    reset();
    setRoute('live');
    void call({ action: 'plan', claims: asReplay ? '' : form.claims });
  };

  const execute = (fromIndex: number) => {
    setRoute('live');
    setStatus('EXECUTION');
    void call({
      action: 'execute', plan: planRef.current, surfaces: surfacesRef.current, fromIndex,
      findings: findingsRef.current, approvals: approvalsRef.current,
    });
  };

  const startExecution = () => execute(0);

  const decide = (decision: 'run' | 'skip', payload?: string) => {
    if (!hitl) return;
    approvalsRef.current = { ...approvalsRef.current, [hitl.id]: { decision, payload } };
    setHitl(null);
    execute(pausedRef.current?.fromIndex ?? 0);
  };

  const toggle = (id: string) => {
    planRef.current = planRef.current.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p));
    setPlan(planRef.current);
  };

  const openFinding = (id: string) => {
    setSelected(id);
    setRoute('finding');
  };

  const openHistory = (e: StoredAssessment) => {
    reset();
    findingsRef.current = e.findings;
    setFindings(e.findings);
    setDone({ counts: e.counts, narrative: e.narrative, source: 'stored', total: e.total, heroId: e.heroId });
    setReplay(e.replay);
    setForm((f) => ({ ...f, targetUrl: e.target }));
    setStatus('FINDINGS');
    setFromHistory(true);
    setRoute('results');
  };

  const addClaims = (list: string[]) => {
    setForm((f) => {
      const have = new Set(f.claims.split('\n').map((c) => c.trim().toLowerCase()));
      const add = list.filter((c) => !have.has(c.toLowerCase()));
      return { ...f, claims: [f.claims.trim(), ...add].filter(Boolean).join('\n') };
    });
  };

  const runSelfTest = async () => {
    setProbe({ running: true });
    try {
      setProbe(await runProbe(cid.current));
    } catch (e) {
      setProbe({ ok: false, error: String(e) });
    }
  };

  const hero = useMemo(() => findings.find((f) => f.id === done?.heroId), [findings, done]);
  const active = route !== 'landing' && route !== 'new' && route !== 'assessments' && route !== 'library' && route !== 'settings';
  const hasSession = status !== null;
  const runId = findings[0]?.evidence.traceRef.split('#')[0];

  return {
    route, setRoute, form, setForm, busy, error, status, phase, logs, net, con, trace, shots, latest, setLatest,
    lastEvidence, live, surfaces, claims, plan, planSource, tests, findings, hitl, done, replay, resultCard,
    setResultCard, selected, history, fromHistory, startedAt, probe, hero, active, hasSession, runId,
    generatePlan, startExecution, decide, toggle, openFinding, openHistory, addClaims, runSelfTest,
  };
}

export type A = ReturnType<typeof useAssessment>;
