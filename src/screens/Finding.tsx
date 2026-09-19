import { useState } from 'react';
import { STATUS, hhmmss, pathOnly } from '../model';
import { Badge } from '../ui';
import type { A } from '../useAssessment';

type Tab = 'trace' | 'shots' | 'network' | 'console' | 'logs';

export default function Finding({ a }: { a: A }) {
  const [tab, setTab] = useState<Tab>('trace');
  const list = a.findings;
  const f = list.find((x) => x.id === a.selected) ?? a.hero ?? list[0];
  if (!f) {
    return (
      <div className="page-body narrow">
        <h2>Evidence</h2>
        <p className="muted">Evidence appears here once ProofLayer has tested a claim.</p>
      </div>
    );
  }
  const s = STATUS[f.status];
  const idx = list.findIndex((x) => x.id === f.id);
  const item = a.plan.find((p) => p.id === f.testId);
  const steps = a.trace.filter((t) => t.ref === f.testId);
  const shots = f.evidence.screenshotIds.map((id) => a.shots[id]).filter(Boolean);
  const actions = steps.filter((t) => t.kind === 'action');
  const obs = steps.filter((t) => t.kind === 'observation');

  const chain: Array<{ k: string; title: string; body: React.ReactNode; id?: string }> = [
    { k: 'CLAIM', title: 'Vendor claim', body: f.claim, id: f.claimId },
    { k: 'HYPOTHESIS', title: 'Executable hypothesis', body: item?.hypothesis ?? f.test, id: f.hypothesisId },
    {
      k: 'ACTIONS', title: 'What ProofLayer did',
      body: actions.length ? <ol>{actions.map((t) => <li key={t.id}>{t.text} <code>{t.id}</code></li>)}</ol> : item ? <ol>{item.procedure.map((p) => <li key={p}>{p}</li>)}</ol> : `${f.actionIds.length} recorded actions`,
    },
    { k: 'OBSERVATION', title: 'What was observed', body: obs.length ? <>{f.observed}<ul className="ids">{obs.map((t) => <li key={t.id}>{t.text} <code>{t.id}</code></li>)}</ul></> : f.observed },
    {
      k: 'EVIDENCE', title: 'Proof you can inspect',
      body: (
        <div className="evchips">
          {shots.length > 0 && <button className="chip link" onClick={() => setTab('shots')}>Screenshot ×{shots.length}</button>}
          <button className="chip link" onClick={() => setTab('trace')}>URL {f.evidence.route || '—'}</button>
          {f.evidence.network.length > 0 && <button className="chip link" onClick={() => setTab('network')}>Network ×{f.evidence.network.length}</button>}
          {f.evidence.console.length > 0 && <button className="chip link" onClick={() => setTab('console')}>Console ×{f.evidence.console.length}</button>}
          <button className="chip link" onClick={() => setTab('trace')}>Trace {f.evidence.traceRef}</button>
        </div>
      ),
    },
    { k: 'CONCLUSION', title: 'Conclusion', body: <><span className={`concl tone-${s.tone}`}>{s.headline}</span> <span className="muted">{s.blurb}</span></> },
  ];

  return (
    <div className="page-body wide">
      <div className="crumbs">
        <button className="link" onClick={() => a.setRoute('results')}>← Results</button>
        <span className="muted">Finding {idx + 1} of {list.length}</span>
        <span className="grow" />
        <button className="ghost sm" disabled={idx <= 0} onClick={() => a.openFinding(list[idx - 1].id)}>Previous</button>
        <button className="ghost sm" disabled={idx >= list.length - 1} onClick={() => a.openFinding(list[idx + 1].id)}>Next</button>
      </div>

      <div className={`fhead tone-${s.tone}`}>
        <div>
          <div className="eyebrow">{f.title}</div>
          <h2>{s.headline}</h2>
        </div>
        <div className="fmeta"><Badge status={f.status} /><span className="sev-l">Severity {f.severity}</span></div>
      </div>

      <div className="fgrid">
        <div><b>Vendor claim</b><p>{f.claim}</p></div>
        <div><b>Expected</b><p>{f.expected}</p></div>
        <div><b>Observed</b><p>{f.observed}</p></div>
      </div>
      {f.recommendation && <p className="reco"><b>Recommendation</b> {f.recommendation}</p>}
      {f.approval && <p className="fine left">Human decision: {f.approval.decision === 'run' ? 'approved' : 'skipped'}{f.approval.modified ? ' (test modified)' : ''} at {hhmmss(f.approval.at)} UTC.</p>}

      <h3 className="sect">Evidence chain</h3>
      <ol className="chain-v">
        {chain.map((c) => (
          <li key={c.k}>
            <div className="ck">{c.k}{c.id && <code>{c.id}</code>}</div>
            <div className="cb"><b>{c.title}</b><div>{c.body}</div></div>
          </li>
        ))}
      </ol>

      <div className="tabs flat">
        <nav>
          {([['trace', 'Execution Trace'], ['shots', `Screenshots ${shots.length}`], ['network', `Network ${f.evidence.network.length}`], ['console', `Console ${f.evidence.console.length}`], ['logs', 'Logs']] as Array<[Tab, string]>).map(([k, l]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>
        <div className="tab-body tall">
          {tab === 'trace' && (steps.length ? steps.map((t) => <div key={t.id} className={`ln tk-${t.kind}`}><span>{t.kind}</span>{t.text}<code>{t.id}</code></div>) : <div className="muted">Detailed trace steps are not stored after a session ends. Trace reference: {f.evidence.traceRef}</div>)}
          {tab === 'shots' && (shots.length ? <div className="shotlist">{shots.map((sh) => <figure key={sh.id}><img src={sh.src} alt={sh.label} /><figcaption>{sh.label} · {sh.route} · {hhmmss(sh.ts)} UTC</figcaption></figure>)}</div> : <div className="muted">Screenshots are not stored after a session ends.</div>)}
          {tab === 'network' && (f.evidence.network.length ? f.evidence.network.map((n, i) => <div key={i} className={`ln ${n.flag ? 'l-warn' : ''}`}><span>{hhmmss(n.ts)}</span>{n.method} {pathOnly(n.url)} → <b>{n.status}</b> {n.flag && <em>[{n.flag}]</em>}</div>) : <div className="muted">No relevant network events for this test.</div>)}
          {tab === 'console' && (f.evidence.console.length ? f.evidence.console.map((c, i) => <div key={i} className={`ln ${c.flag ? 'l-warn' : ''}`}><span>{hhmmss(c.ts)}</span>[{c.type}] {c.text} {c.flag && <em>[{c.flag}]</em>}</div>) : <div className="muted">No relevant console events for this test.</div>)}
          {tab === 'logs' && (a.logs.length ? a.logs.map((l, i) => <div key={i} className={`ln l-${l.level}`}><span>{hhmmss(l.ts)}</span>{l.text}</div>) : <div className="muted">Session logs are not stored after a session ends.</div>)}
        </div>
      </div>
    </div>
  );
}
