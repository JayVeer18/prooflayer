import { useState } from 'react';
import { CLAIM_TEMPLATES } from '../model';
import { Notice } from '../ui';
import type { A } from '../useAssessment';

export default function NewAssessment({ a }: { a: A }) {
  const { form, setForm } = a;
  const [tpl, setTpl] = useState<string>('Security & Access');
  const ok = form.targetUrl && form.username && form.password;

  return (
    <div className="page-body narrow">
      <div className="eyebrow">New assessment</div>
      <h2>Start a New Assessment</h2>
      <p className="muted">Tell ProofLayer what to look at and what the vendor claims. Everything is prefilled for the demo target.</p>

      <div className="form">
        <label>
          Product URL
          <input value={form.targetUrl} onChange={(e) => setForm({ ...form, targetUrl: e.target.value })} placeholder="https://demo.acmeapp.com" />
        </label>
        <div className="row2">
          <label>
            Authorized test credentials — username
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" placeholder="test.user@example.com" />
          </label>
          <label>
            Password
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          </label>
        </div>
        <p className="hint">Use a <b>standard-user</b> account. Credentials stay in memory for this session only — never stored, logged or sent to a model.</p>

        <label>
          Vendor claims <span className="opt">one per line · leave empty and ProofLayer finds them on the product</span>
          <textarea rows={5} value={form.claims} onChange={(e) => setForm({ ...form, claims: e.target.value })} />
        </label>

        <div className="tpl">
          <div className="tpl-tabs" role="tablist">
            {Object.keys(CLAIM_TEMPLATES).map((k) => (
              <button key={k} role="tab" aria-selected={tpl === k} className={tpl === k ? 'on' : ''} onClick={() => setTpl(k)}>
                {k}
              </button>
            ))}
          </div>
          <div className="tpl-body">
            {CLAIM_TEMPLATES[tpl].length ? (
              CLAIM_TEMPLATES[tpl].map((c) => (
                <button key={c} className="chip add" onClick={() => a.addClaims([c])}>
                  + {c}
                </button>
              ))
            ) : (
              <span className="muted">Type your own claims in the box above.</span>
            )}
          </div>
        </div>

        <Notice>Only assess software and credentials you are authorized to test.</Notice>

        <div className="actions">
          <button className="ghost" onClick={() => a.generatePlan(true)} title="Plays a real recording of the demo target — no sandbox needed">
            Use recorded run
          </button>
          <button className="primary lg" disabled={!ok} onClick={() => a.generatePlan(false)}>
            Generate Assessment Plan →
          </button>
        </div>
      </div>
    </div>
  );
}
