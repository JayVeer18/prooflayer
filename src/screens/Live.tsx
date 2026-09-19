import { useEffect, useRef, useState } from 'react';
import { STATUS, hhmmss, pathOnly } from '../model';
import { Badge, BrowserFrame, PlatformStrip, Stepper } from '../ui';
import type { A } from '../useAssessment';

type Tab = 'activity' | 'network' | 'console' | 'claims' | 'evidence';

function HitlModal({ a }: { a: A }) {
  const h = a.hitl!;
  const [modify, setModify] = useState(false);
  const [payload, setPayload] = useState(h.defaultPayload ?? '');
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Human review required">
      <div className="modal">
        <div className="modal-h">
          <span className="eyebrow warn">Human review required</span>
          <span className={`risk r-${h.risk ?? 'REVIEW'}`}>{h.risk ?? 'REVIEW'}</span>
        </div>
        <p className="modal-lead">{h.body}</p>
        {h.procedure && (
          <div className="mini">
            <b>Planned action</b>
            <ol>{h.procedure.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
        )}
        <div className="mini"><b>Recommended safety</b><p>Synthetic values only — no real customer data leaves this session.</p></div>
        {modify && (
          <label className="mini">
            <b>Synthetic data to submit</b>
            <textarea rows={3} value={payload} onChange={(e) => setPayload(e.target.value)} />
          </label>
        )}
        <div className="next">
          <div><b>If you approve</b> {h.ifApproved}</div>
          <div><b>If you skip</b> {h.ifSkipped}</div>
        </div>
        {a.replay && <p className="fine left">Replay mode: the recorded outcome plays regardless of this choice.</p>}
        <div className="modal-actions">
          <button className="ghost" onClick={() => a.decide('skip')}>Skip</button>
          <button className="ghost" onClick={() => setModify((m) => !m)}>{modify ? 'Use default' : 'Modify'}</button>
          <button className="primary lg" onClick={() => a.decide('run', modify ? payload : undefined)}>Approve</button>
        </div>
      </div>
    </div>
  );
}

function ResultCard({ a }: { a: A }) {
  const f = a.resultCard!;
  const s = STATUS[f.status];
  const idx = a.plan.findIndex((p) => p.id === f.testId);
  return (
    <div className={`rcard tone-${s.tone}`} role="status">
      <div className="rc-h">TEST {idx >= 0 ? idx + 1 : ''} RESULT</div>
      <div className="rc-big">{s.headline}</div>
      <dl>
        <dt>Expected</dt><dd>{f.expected}</dd>
        <dt>Observed</dt><dd>{f.observed}</dd>
      </dl>
      <div className="rc-ev">
        <b>Evidence captured</b>
        <span>✓ Screenshot</span><span>✓ URL</span>
        {f.evidence.network.length > 0 && <span>✓ Network event</span>}
        <span>✓ Execution trace</span>
      </div>
      <div className="rc-actions">
        <button className="ghost sm" onClick={() => a.setResultCard(null)}>Continue</button>
        <button className="primary" onClick={() => { a.setResultCard(null); a.openFinding(f.id); }}>Inspect the proof →</button>
      </div>
    </div>
  );
}

export default function Live({ a }: { a: A }) {
  const [tab, setTab] = useState<Tab>('activity');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [a.logs, tab]);

  const cur = a.shots[a.latest];
  const running = a.plan.find((p) => a.tests[p.id] === 'running');
  const finished = a.plan.filter((p) => a.tests[p.id] && a.tests[p.id] !== 'running').length;
  const enabled = a.plan.filter((p) => p.enabled).length;
  const actions = a.logs.filter((l) => l.level !== 'info' || /^Test \d/.test(l.text)).slice(-14);
  const tabs: Array<[Tab, string]> = [
    ['activity', 'Activity'], ['network', `Network ${a.net.length}`], ['console', `Console ${a.con.length}`],
    ['claims', `Claims ${a.claims.length}`], ['evidence', `Evidence ${Object.keys(a.shots).length}`],
  ];

  return (
    <div className="live">
      <div className="live-top">
        <div className="live-title">
          <span className="eyebrow">Assessment</span>
          <b>{a.phase || 'Starting'}</b>
          {a.busy && <span className={`livechip ${a.replay ? 'rep' : ''}`}><i />{a.replay ? 'REPLAY' : 'LIVE'}</span>}
        </div>
        <Stepper status={a.status} />
      </div>
      <PlatformStrip a={a} />

      <div className="livegrid">
        <section className="browser-col" aria-label="Live target">
          <BrowserFrame
            url={cur ? `${a.replay ? 'acmedesk.demo' : new URL(a.form.targetUrl || location.href, location.href).host}${cur.route}` : ''}
            badge={running ? <span className="nowtest">Testing: {running.title}</span> : undefined}
          >
            {cur ? <img src={cur.src} alt={cur.label} /> : <div className="empty">Launching isolated browser…</div>}
            {a.lastEvidence && <div className="evpill">● Evidence captured · {a.lastEvidence}</div>}
            {a.resultCard && <ResultCard a={a} />}
          </BrowserFrame>
        </section>

        <aside className="actions-col">
          <div className="pane-h">AGENT ACTIONS</div>
          {enabled > 0 && (
            <div className="progress" aria-label="Progress">
              <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.round((finished / enabled) * 100)}%` }} /></div>
              <span>{finished} of {enabled} tests complete</span>
            </div>
          )}
          <ul className="alist">
            {actions.map((l, i) => (
              <li key={i} className={`al-${l.level}`}>
                <i>{l.level === 'act' ? '→' : l.level === 'warn' ? '!' : '✓'}</i>
                {l.text}
              </li>
            ))}
            {a.busy && <li className="al-think"><i>…</i>Working</li>}
          </ul>
          {a.error && (
            <div className="err">
              <b>{a.error.kind === 'auth' ? 'Authentication failed' : 'The assessment could not continue'}</b>
              <p>{a.error.message}</p>
              <div className="err-actions">
                <button className="ghost sm" onClick={() => a.setRoute('new')}>Back to setup</button>
                {!a.replay && <button className="ghost sm" onClick={() => a.generatePlan(true)}>Play recorded run instead</button>}
              </div>
            </div>
          )}
        </aside>
      </div>

      <section className="tabs">
        <nav>
          {tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </nav>
        <div className="tab-body">
          {tab === 'activity' && <>{a.logs.map((l, i) => <div key={i} className={`ln l-${l.level}`}><span>{hhmmss(l.ts)}</span>{l.text}</div>)}<div ref={end} /></>}
          {tab === 'network' && (a.net.length ? a.net.map((n, i) => <div key={i} className={`ln ${n.flag ? 'l-warn' : ''}`}><span>{hhmmss(n.ts)}</span>{n.method} {pathOnly(n.url)} → <b>{n.status}</b> {n.flag && <em>[{n.flag}]</em>}</div>) : <div className="muted">No requests captured yet.</div>)}
          {tab === 'console' && (a.con.length ? a.con.map((c, i) => <div key={i} className={`ln ${c.flag ? 'l-warn' : ''}`}><span>{hhmmss(c.ts)}</span>[{c.type}] {c.text} {c.flag && <em>[{c.flag}]</em>}</div>) : <div className="muted">No console output captured yet.</div>)}
          {tab === 'claims' && a.claims.map((c) => {
            const f = a.findings.find((x) => x.claimId === c.id);
            return <div key={c.id} className="ln"><span>{c.source}</span>{c.text} {f ? <Badge status={f.status} /> : <em>pending</em>}</div>;
          })}
          {tab === 'evidence' && (
            <div className="thumbs">
              {Object.values(a.shots).map((s) => (
                <figure key={s.id}><img src={s.src} alt={s.label} onClick={() => a.setLatest(s.id)} /><figcaption>{s.label}</figcaption></figure>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Peak-End: the contradiction gets the stage first; the approval prompt waits until it is dismissed. */}
      {a.hitl && !a.resultCard && <HitlModal a={a} />}
    </div>
  );
}
