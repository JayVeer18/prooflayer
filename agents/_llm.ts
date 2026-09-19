/**
 * Makers Model Gateway helper — private module.
 *
 * The model PROPOSES (plan wording) and EXPLAINS (summary). It never decides pass/fail:
 * verdicts come from deterministic verifiers over observed browser evidence.
 * Every call has a timeout and a deterministic fallback, so a slow model can't break a run.
 */
import OpenAI from 'openai';
import { withTimeout } from './_util';

const DEFAULT_MODEL = '@makers/deepseek-v4-flash';

export interface LlmResult<T> {
  ok: boolean;
  model: string;
  ms: number;
  data?: T;
  error?: string;
}

export function modelName(env: Record<string, string | undefined>): string {
  return env.AI_GATEWAY_MODEL || DEFAULT_MODEL;
}

export async function llmJSON<T = any>(
  env: Record<string, string | undefined>,
  system: string,
  user: string,
  timeoutMs = 20000,
): Promise<LlmResult<T>> {
  const model = modelName(env);
  const t0 = Date.now();
  if (!env.AI_GATEWAY_API_KEY || !env.AI_GATEWAY_BASE_URL) {
    return { ok: false, model, ms: 0, error: 'AI_GATEWAY_API_KEY / AI_GATEWAY_BASE_URL not configured' };
  }
  try {
    const client = new OpenAI({ apiKey: env.AI_GATEWAY_API_KEY, baseURL: env.AI_GATEWAY_BASE_URL, maxRetries: 0 });
    const res = await withTimeout(
      client.chat.completions.create({
        model,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      timeoutMs,
      'model call',
    );
    const text = res.choices?.[0]?.message?.content ?? '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('model returned no JSON object');
    return { ok: true, model, ms: Date.now() - t0, data: JSON.parse(m[0]) as T };
  } catch (e) {
    return { ok: false, model, ms: Date.now() - t0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
