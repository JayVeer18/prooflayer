# ProofLayer

**Don't ask if it's enterprise-ready. Prove it.**

Buyer-side behavioral due diligence, built on Tencent EdgeOne Makers. Give ProofLayer a product URL and
test credentials: it maps the product, turns vendor claims into testable hypotheses, asks a human to
approve the plan, operates the product in an isolated sandbox browser, and returns evidence-backed findings.

`PLAN → EXECUTE → PROVE`

## Layout

| Path | Purpose |
|---|---|
| `agents/assess` | `POST /assess` — SSE stream of the orchestrator (plan / execute segments) |
| `agents/probe` | `POST /probe` — platform self-test (sandbox, CDP, model, state) |
| `agents/_orchestrator.ts` | Phases, discovery, planning, human checkpoints |
| `agents/_tests.ts` | Deterministic verifiers (RBAC, auth/session, runtime, AI data protection) |
| `agents/_driver.ts` | Browser drivers: sandbox CDP (primary) → sandbox API (fallback) → local |
| `public/demo` | "AcmeDesk" — controlled demo target with seeded defects |
| `src` | React UI |

The model (Makers Model Gateway) proposes plan wording and explains results; verdicts come from
deterministic verifiers over observed evidence.

## Environment (Makers console → Environment Variables)

`AI_GATEWAY_API_KEY`, `AI_GATEWAY_BASE_URL`, optional `AI_GATEWAY_MODEL`. Without them the app still works
using built-in plan templates.

## Local

```bash
npm install
npm run test:local        # runs the orchestrator against the demo app in a local Edge
edgeone makers dev        # full app on http://localhost:8088 (needs `edgeone login`)
```
