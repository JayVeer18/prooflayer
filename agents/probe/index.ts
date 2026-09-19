/**
 * POST|GET /probe — platform self-test.
 * Verifies every EdgeOne capability Argus depends on and reports which fallback path is active.
 * Safe to expose: secrets are never returned (only the CDP hostname).
 */
import { createDriver } from '../_driver';
import { llmJSON, modelName } from '../_llm';
import { withTimeout } from '../_util';

type Step = { name: string; ok: boolean; ms: number; detail?: string };

export async function onRequest(context: any) {
  const env = (context.env ?? {}) as Record<string, string | undefined>;
  const steps: Step[] = [];
  const run = async (name: string, fn: () => Promise<string | void>) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? undefined });
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - t0, detail: String((e as Error)?.message ?? e).slice(0, 200) });
    }
  };

  const sb = context.sandbox?.browser;
  let liveUrl: string | null = null;
  let cdpHost: string | null = null;

  await run('sandbox.browser present', async () => {
    if (!sb) throw new Error('context.sandbox.browser is undefined');
  });
  await run('browser.liveUrl (noVNC live view)', async () => {
    const v = typeof sb?.liveUrl === 'function' ? await sb.liveUrl() : await sb?.liveUrl;
    if (!v) throw new Error('empty');
    liveUrl = String(v);
    return new URL(liveUrl).host;
  });
  await run('browser.cdpUrl', async () => {
    const v = typeof sb?.cdpUrl === 'function' ? await sb.cdpUrl() : await sb?.cdpUrl;
    if (!v) throw new Error('empty');
    cdpHost = new URL(String(v)).host;
    return cdpHost;
  });
  await run('import playwright-core', async () => {
    const pw: any = await import(['playwright', 'core'].join('-'));
    if (!pw.chromium) throw new Error('chromium export missing');
  });

  let mode = 'none';
  await run('driver: connect + navigate + screenshot + observe', async () => {
    const d = await withTimeout(createDriver(context, () => {}), 30000, 'createDriver');
    mode = d.mode;
    try {
      const target = new URL(context.request?.body?.target ?? 'https://example.com');
      await d.drain();
      const r = await d.goto(target.href);
      const shot = await d.screenshot();
      const ev = await d.drain();
      return `${d.mode}: “${r.title}” HTTP ${r.status}; screenshot ${Math.round(shot.b64.length / 1024)}KB; ${ev.network.length} requests, ${ev.console.length} console events`;
    } finally {
      await d.close();
    }
  });

  await run('model gateway', async () => {
    const r = await llmJSON<{ ok: boolean }>(env, 'Reply with ONLY {"ok": true}', 'ping', 15000);
    if (!r.ok) throw new Error(r.error);
    return `${r.model} in ${r.ms}ms`;
  });

  await run('store.state read/write', async () => {
    const st = context.store?.state;
    if (!st?.set || !st?.get) throw new Error('context.store.state unavailable');
    await st.set('prooflayer.probe', 'ok');
    const v = await st.get('prooflayer.probe');
    const val = typeof v === 'string' ? v : (v as any)?.value;
    if (val !== 'ok') throw new Error(`readback mismatch: ${JSON.stringify(v)}`);
  });

  const ok = steps.every((s) => s.ok);
  return new Response(JSON.stringify({ ok, driverMode: mode, liveUrl, cdpHost, model: modelName(env), steps }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}
