/** Small helpers shared across the orchestrator. Private module. */

export const now = () => new Date().toISOString();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
const LONG_SECRET =
  /((?:token|secret|api[_-]?key|password|authorization|bearer)["']?\s*[:=]?\s*["']?)([A-Za-z0-9._\-]{12,})/gi;

/** Mask credential-like material before anything is emitted, logged or sent to a model. */
export function redact(text: string, extra: string[] = []): string {
  let out = String(text ?? '');
  for (const s of extra) {
    if (s && s.length >= 4) out = out.split(s).join('••••');
  }
  out = out.replace(JWT, (m) => `${m.slice(0, 10)}…[redacted]`);
  out = out.replace(LONG_SECRET, (_m, p1: string, p2: string) => `${p1}${p2.slice(0, 6)}…[redacted]`);
  return out;
}

export function hasCredentialMaterial(text: string): boolean {
  JWT.lastIndex = 0;
  LONG_SECRET.lastIndex = 0;
  const hit = JWT.test(text);
  JWT.lastIndex = 0;
  if (hit) return true;
  const hit2 = LONG_SECRET.test(text);
  LONG_SECRET.lastIndex = 0;
  return hit2;
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Minimal async queue so verifiers can `emit()` while the SSE generator yields. */
export function makeChannel<T>() {
  const q: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(e: T) {
      q.push(e);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      while (true) {
        if (q.length) {
          yield q.shift() as T;
          continue;
        }
        if (closed) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
