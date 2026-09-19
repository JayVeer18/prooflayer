import { useEffect, useMemo, useState } from 'react';
import { DEMO_TARGET } from '../model';
import { load } from '../replay';
import { BrowserFrame } from '../ui';
import type { A } from '../useAssessment';

const DEMO_HOST = (() => { try { return new URL(DEMO_TARGET.url).host } catch { return 'demo' } })();

const STAGES = [
  { k: 'CLAIM', t: 'Vendor claim', d: 'Enterprise-grade role-based access control' },
  { k: 'EXECUTE', t: 'Agent uses the product', d: 'Signs in as a standard user and navigates' },
  { k: 'OBSERVE', t: 'Observed behavior', d: 'Account data is returned to a standard user' },
  { k: 'PROVE', t: 'Evidence-backed conclusion', d: 'CLAIM CONTRADICTED' },
];

/** Frames come from a real recorded run against the demo target — not a mockup. */
function LandingVisual() {
  const [rec, setRec] = useState<Awaited<ReturnType<typeof load>> | null>(null);
  const [stage, setStage] = useState(0);

  useEffect(() => {
    load().then(setRec).catch(() => undefined);
    const t = window.setInterval(() => setStage((s) => (s + 1) % 4), 3000);
    return () => window.clearInterval(t);
  }, []);

  const frames = useMemo(() => {
    const shots = (rec?.segments ?? []).flat().filter((e) => e.event === 'screenshot').map((e) => e.data);
    const by = (p: (l: string) => boolean) => shots.find((s: any) => p(String(s.label)));
    const src = (s: any) => (s ? `data:${s.mime};base64,${s.b64}` : '');
    return {
      login: by((l) => l === 'Target loaded'),
      dash: by((l) => l === 'Signed in'),
      admin: by((l) => l.startsWith('Standard user reached') || l.startsWith('Account data returned')),
      toSrc: src,
    };
  }, [rec]);

  const cur = [frames.login, frames.dash, frames.admin, frames.admin][stage];
  // Show each frame's own recorded route, so the address bar matches the evidence on screen.
  const route = (cur as any)?.route ?? '/';

  return (
    <div className="lv">
      <BrowserFrame url={`${DEMO_HOST}${route}`} badge={<span className="rec">RECORDED</span>}>
        {cur ? <img src={frames.toSrc(cur)} alt="" className={stage === 3 ? 'dim' : ''} /> : <div className="empty">Loading recorded frames…</div>}
        {stage === 3 && <div className="stamp">CLAIM CONTRADICTED</div>}
      </BrowserFrame>
      <ol className="lv-steps">
        {STAGES.map((s, i) => (
          <li key={s.k} className={i === stage ? 'on' : i < stage ? 'past' : ''} onClick={() => setStage(i)}>
            <b>{s.k}</b>
            <span>{s.d}</span>
          </li>
        ))}
      </ol>
      <p className="fine left">Frames from a real recorded run against {DEMO_TARGET.name}, a deliberately vulnerable application published by OWASP.</p>
    </div>
  );
}

export default function Landing({ a }: { a: A }) {
  return (
    <div className="landing">
      <section className="hero-l">
        <div className="eyebrow">AI software due diligence</div>
        <h1>
          Don’t ask if it’s enterprise-ready.
          <br />
          <em>Prove it.</em>
        </h1>
        <p className="lede">
          Argus tests authorized product workflows and records what it observes. It uses the software to check vendor claims against behavior, and reports only what the evidence supports.
        </p>
        <div className="cta-row">
          <button className="primary lg" onClick={() => a.setRoute('new')}>
            Start an Assessment
          </button>
          <button className="ghost lg" onClick={() => a.generatePlan(true)}>
            Watch 3-Minute Demo
          </button>
        </div>
        <ul className="pillars">
          <li><b>Claims are cheap.</b> Execution is proof.</li>
          <li>Every conclusion links to evidence you can inspect.</li>
          <li>It says <i>not verified</i> when it can’t know.</li>
        </ul>
      </section>
      <LandingVisual />
    </div>
  );
}
