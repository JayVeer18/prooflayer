import { useEffect, useRef, useState } from 'react';
import { STATUS, describeStatus, hhmmss, pathOnly } from '../model';
import { Badge, BrowserFrame, PlatformStrip, Stepper } from '../ui';
import type { A } from '../useAssessment';

type Tab = 'activity' | 'network' | 'console' | 'claims' | 'evidence';

/**
 * Approval is an interruption object, not an Allow/Deny prompt: it states what will happen, why,
 * what could change, and what remains uncertain, then offers the safest option first. Nothing here
 * is pre-selected — Escape does not approve, and focus lands on the heading rather than a button,
 * so a reflexive keypress cannot consent on the reviewer's behalf.
 */
function HitlModal({ a }: { a: A }) {
  const h = a.hitl!;
  const [modify, setModify] = useState(false);
  const [payload, setPayload] = useState(h.defaultPayload ?? '');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  // Escape closes nothing: the run stays paused until an explicit decision is recorded.
  useEffect(() => {
    const stop = (e: KeyboardEvent) => { if (e.key === 'Escape') e.stopPropagation(); };
    window.addEventListener('keydown', stop, true);
    return () => window.removeEventListener('keydown', stop, true);
  }, []);

  return (
    <div className="overlay" role="alertdialog" aria-modal="true" aria-labelledby="hitl-title" aria-describedby="hitl-body">
      <div className="modal">
        <div className="modal-h">
          <span className="eyebrow warn">Paused before action</span>
          <span className={`risk r-${h.risk ?? 'REVIEW'}`}>{h.risk ?? 'REVIEW'}</span>
        </div>
        <h3 id="hitl-title" ref={heading} tabIndex={-1} className="modal-title">{h.title}</h3>
        <p id="hitl-body" className="modal-lead">{h.body}</p>

        {h.why && <div className="mini"><b>Why</b><p>{h.why}</p></div>}
        {h.procedure && (
          <div className="mini">
            <b>What will happen</b>
            <ol>{h.procedure.map((s) => <li key={s}>{s}</li>)}</ol>
          </div>
        )}
        {h.couldChange && <div className="mini"><b>What could change</b><p>{h.couldChange}</p></div>}

        {(h.known?.length || h.uncertain?.length) && (
          <div className="ku">
            {h.known?.length ? (
              <div className="mini"><b>Known</b><ul>{h.known.map((k) => <li key={k}>{k}</li>)}</ul></div>
            ) : null}
            {h.uncertain?.length ? (
              <div className="mini"><b>Uncertain</b><ul>{h.uncertain.map((u) => <li key={u}>{u}</li>)}</ul></div>
            ) : null}
          </div>
        )}

        <div className="mini safest">
          <b>Safest option</b>
          <p>{h.safestOption ?? h.ifSkipped ?? 'Skip this test and continue the assessment without it.'}</p>
        </div>

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

        {/* Safest choice first; approval is last and never pre-focused. */}
        <div className="modal-actions">
          <button className="ghost" onClick={() => a.decide('skip')}>Skip this test</button>
          <button className="ghost" onClick={() => setModify((m) => !m)}>{modify ? 'Use default data' : 'Modify data'}</button>
          <button className="primary lg" onClick={() => a.decide('run', modify ? payload : undefined)}>Approve once</button>
        </div>
        <p className="fine left">Your decision, the time and whether the data was modified are recorded with the finding.</p>
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
        <span>✓ Screenshot</span><span>✓ Page visited</span>
        {f.evidence.network.length > 0 && <span>✓ Data exchanged</span>}
        <span>✓ Step-by-step record</span>
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
  const [view, setView] = useState<'live' | 'shots' | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [a.logs, tab]);

  const cur = a.shots[a.latest];
  // The sandbox's real-time browser view (noVNC) shows typing and clicks as they happen.
  // Default to it when available; snapshots are the fallback and stay one click away.
  const liveUrl = a.live?.url ?? null;
  const showLive = liveUrl !== null && (view ?? 'live') === 'live';
  const running = a.plan.find((p) => a.tests[p.id] === 'running');
  const finished = a.plan.filter((p) => a.tests[p.id] && a.tests[p.id] !== 'running').length;
  const enabled = a.plan.filter((p) => p.enabled).length;
  const actions = a.logs.filter((l) => l.level !== 'info' || /^Test \d/.test(l.text)).slice(-14);
  const tabs: Array<[Tab, string]> = [
    ['activity', 'Activity'], ['network', `Data exchanged ${a.net.length}`], ['console', `Browser messages ${a.con.length}`],
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
            /* The recording carries the tested product's real host, so replay shows its own address. */
            url={cur ? `${new URL(a.form.targetUrl || location.href, location.href).host}${cur.route}` : ''}
            badge={
              <>
                {running && <span className="nowtest">Testing: {running.title}</span>}
                {liveUrl && (
                  <span className="viewtoggle" role="group" aria-label="Browser view">
                    <button className={showLive ? 'on' : ''} onClick={() => setView('live')}>Live view</button>
                    <button className={!showLive ? 'on' : ''} onClick={() => setView('shots')}>Snapshots</button>
                    <a href={liveUrl} target="_blank" rel="noreferrer" title="Open the live view in its own tab">↗</a>
                  </span>
                )}
              </>
            }
          >
            {showLive ? (
              <iframe className="livefr" src={liveUrl!} title="Live browser" allow="clipboard-read; clipboard-write" />
            ) : cur ? (
              <img src={cur.src} alt={cur.label} />
            ) : (
              <div className="empty">Launching isolated browser…</div>
            )}
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
          {tab === 'network' && (a.net.length ? a.net.map((n, i) => <div key={i} className={`ln ${n.flag ? 'l-warn' : ''}`}><span>{hhmmss(n.ts)}</span>{pathOnly(n.url)} — <b>{describeStatus(n.status)}</b> {n.flag && <em>[{n.flag}]</em>}</div>) : <div className="muted">Nothing exchanged with the product yet.</div>)}
          {tab === 'console' && (a.con.length ? a.con.map((c, i) => <div key={i} className={`ln ${c.flag ? 'l-warn' : ''}`}><span>{hhmmss(c.ts)}</span>{c.text} {c.flag && <em>[{c.flag}]</em>}</div>) : <div className="muted">The browser has reported nothing yet.</div>)}
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
