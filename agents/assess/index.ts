/**
 * POST /assess — Argus assessment stream (Server-Sent Events)
 *
 * Body:
 *   { action: 'plan',    targetUrl, username, password, claims? }
 *   { action: 'execute', targetUrl, username, password, plan, surfaces, fromIndex, findings, approvals }
 *
 * Each call runs one segment of PLAN → EXECUTE → PROVE and ends at the next human checkpoint.
 * Credentials are used in memory for the request only — never persisted, logged or sent to the model.
 */
import { sseResponse } from '../_sse';
import { createLogger } from '../_logger';
import { runExecute, runPlan } from '../_orchestrator';
import { makeChannel, redact } from '../_util';

const logger = createLogger('assess');

export async function onRequest(context: any) {
  const body = (context.request.body ?? {}) as Record<string, any>;
  const action = body.action === 'execute' ? 'execute' : 'plan';
  const signal: AbortSignal | undefined = context.request.signal;
  logger.log(`[request] cid=${context.conversation_id} action=${action} target=${String(body.targetUrl ?? '').slice(0, 80)}`);

  const ch = makeChannel<{ event: string; data: unknown }>();
  const emit = (event: string, data: unknown) => ch.push({ event, data });

  const runner = (async () => {
    try {
      const io = { context, emit, body };
      if (action === 'plan') await runPlan(io);
      else await runExecute(io);
    } catch (e) {
      const msg = redact(String((e as Error)?.message ?? e), [String(body.password ?? '')]);
      logger.error('[assess] failed:', msg);
      emit('error', { message: msg });
    } finally {
      ch.close();
    }
  })();

  return sseResponse(
    async function* () {
      for await (const ev of ch) {
        if (signal?.aborted) break;
        yield ev;
      }
      await runner;
    },
    { signal, logger },
  );
}
