# ProofLayer — Implementation Plan

North star: **CLAIM → PLAN → EXECUTE → OBSERVE → EVIDENCE → PROVE**

## 1. Current architecture (inspected)

| Layer | What exists | Notes |
|---|---|---|
| Platform | Tencent EdgeOne Makers, Git-connected project `prooflayer` (GitHub `JayVeer18/prooflayer`), auto-build on push | Deployed and working |
| Agent runtime | `agents/<name>/index.ts` file-as-route, `handler(context)`; SSE via `agents/_sse.ts` | `/assess` (orchestrator stream), `/probe` (platform self-test) |
| Browser | `context.sandbox.browser.*` (goto/click/type/evaluate/screenshot, `liveUrl` noVNC, `cdpUrl`) | Bundler cannot bundle `playwright-core` → loaded by runtime name; cloud path falls back to sandbox API + in-page hooks |
| Model | Makers Model Gateway (OpenAI-compatible, `AI_GATEWAY_*`) | Proposes plan wording and explains results; **never decides verdicts** |
| State | `context.store.state` checkpoints; sandbox instance is per `conversation_id` | Enables pause/resume across requests |
| Frontend | Vite + React + TS, in `src/` | Functional UI; to be restructured into an app shell |
| Demo target | "AcmeDesk" static app in `public/demo` with seeded defects | Deterministic |
| Fallback | Recorded replay of a real run (`public/replay/acme-run.json`) | Always labelled as replay |

## 2. Existing capabilities

Real browser execution, deterministic verifiers (auth/session, RBAC direct navigation, runtime console/network, AI data protection, unverifiable claims), claim discovery from page copy, LLM-drafted plan with template fallback, two human checkpoints (plan review, test approval), evidence capture (screenshot, route, timestamp, network, console), redaction of credential material, replay mode, report JSON export.

## 3. Missing versus the product spec

1. App shell: landing, sidebar (Overview / New Assessment / Assessments / Claim Library / Settings), separate Plan / Live / Results / Evidence / Finding / Report screens.
2. Structured reasoning chain with IDs: `claimId → hypothesisId → actionIds → observationIds → evidenceIds → conclusion`.
3. Status model: `UNTESTED PLANNED EXECUTING SUPPORTED CONTRADICTED PARTIALLY_VERIFIED NOT_VERIFIED INCONCLUSIVE NEEDS_HUMAN_REVIEW` (currently `VERIFIED` and no INCONCLUSIVE for failures).
4. Explicit action-safety policy `SAFE / REVIEW / BLOCKED`, enforced in code, not in prompts.
5. Hypothesis objects with procedure steps and risk level shown in the plan.
6. Failure behavior: browser failure → INCONCLUSIVE; auth failure → "Authentication failed", no conclusion.
7. Unit tests: claim conversion, result classification, HITL gating, evidence linkage, state machine.
8. Report screen with human approvals and unverified claims; "not a certification" wording.

## 4. Target architecture

```
UI (React app shell)
  Landing · New Assessment · Plan · Live · Results · Finding/Evidence · Report · Assessments · Claim Library · Settings
        │  SSE (POST /assess: plan | execute segments)         ▲ replay (recorded run, same events)
        ▼
EdgeOne Makers agent runtime ── ONE Orchestrator ─────────────────────────────
   Understand → Plan → Ask human → Act → Observe → Reason → Evidence → Prove/Inconclusive
   ├─ Model Gateway      (plan wording, executive summary; timeout + deterministic fallback)
   ├─ BrowserExecutor    (Driver interface: sandbox CDP · sandbox API · local · never silent mock)
   ├─ Observation/Evidence collector (console, network, screenshots, trace)
   ├─ Policy (SAFE/REVIEW/BLOCKED)  ├─ HITL controller  └─ Assessment state (checkpointed)
        ▼
EdgeOne sandbox browser (live view) ──► AcmeDesk demo target
```

`BrowserExecutor` is implemented by `agents/_driver.ts` (`Driver`): `goto`, `click`, `fill` (type), `screenshot`, `url`, `evaluate`, `drain` (console + network events).

## 5. Files

Create: `agents/_policy.ts`, `tests/*.test.ts`, `src/shell/*` (Sidebar, screens), `src/model.ts` (structured types + selectors).
Modify: `agents/_types.ts`, `_tests.ts`, `_orchestrator.ts`, `_claims.ts`, `src/App.tsx`, `src/index.css`, `src/types.ts`, `scripts/local-run.ts`, `README.md`.

## 6. Dependencies

No new runtime dependencies. Dev: `tsx` (already), Node built-in test runner.

## 7. EdgeOne integration (real, not faked)

Agent runtime + SSE routes · sandbox browser (`liveUrl`, `cdpUrl`, atomic API) · Model Gateway · `context.store.state` checkpoints · conversation-scoped sandbox instance · `/probe` self-test · Git-connected deployment. Any capability that fails at runtime is reported as such and a labelled fallback is used.

## 8. Browser execution strategy

Primary: sandbox Chromium via CDP when the runtime can load a client; fallback: sandbox atomic API with injected console/fetch hooks + resource timing. Local dev: Playwright on Edge. Deterministic verifiers own the verdict; the model only writes wording.

## 9. State architecture

Client holds non-secret assessment state (plan, findings, approvals). Server checkpoints phase to `context.store.state`. Credentials exist only in request memory and React state — never persisted, logged, put in URLs or in evidence.

## 10. Demo strategy

AcmeDesk (`/demo/`) with deterministic accounts and seeded defects: role check missing on `/demo/admin/users/` (primary), token logged to console, SSN not masked by the AI assistant. Correct logout behavior gives a SUPPORTED result. Replay of a recorded run is the labelled fallback.

## 11. Sequence

1. Backend model: statuses, structured IDs, policy, failure semantics, tests, re-record.
2. App shell + landing + new assessment + plan (hypothesis chain).
3. Live execution screen (browser-dominant) + HITL.
4. Results, finding detail, evidence chain, report.
5. Assessments, claim library, settings.
6. Verify locally in a browser, push, verify the deployed self-test.
7. Freeze at 2:30 PM; rehearse the exact demo path.

## 12. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Sandbox browser API differs from docs | `/probe` reports it; hook-based driver; replay mode |
| Live-view iframe blocked | Screenshot stream in the same viewport |
| Model slow/unavailable | Template plan and deterministic summary (labelled) |
| Network/deploy trouble on stage | Recorded replay, same UI |
| CDP client unavailable in bundle | Direct WebSocket CDP client if hooks prove too weak |
