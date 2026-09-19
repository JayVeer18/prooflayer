/**
 * Recorded-run replay — the demo-day safety net.
 *
 * public/replay/demo-run.json is a real recording of the orchestrator (scripts/local-run.ts --record)
 * against the demo target. Replay feeds it through the exact same event handler as a live run,
 * including the human-approval pause, so the whole UI behaves identically.
 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Rec {
  dt: number;
  event: string;
  data: any;
}

let cache: { segments: Rec[][] } | null = null;

export async function load() {
  if (!cache) {
    const res = await fetch('/replay/demo-run.json');
    if (!res.ok) throw new Error('Recorded run is not available');
    cache = await res.json();
  }
  return cache!;
}

/** action 'plan' → segment 0; 'execute' from 0 → segment 1; 'execute' resumed after approval → segment 2. */
export async function streamReplay(body: Record<string, unknown>, onEvent: (event: string, data: any) => void, speed = 1): Promise<void> {
  const rec = await load();
  const idx = body.action === 'plan' ? 0 : Number(body.fromIndex) > 0 ? 2 : 1;
  const seg = rec.segments[idx] ?? [];
  for (const e of seg) {
    await sleep(Math.max(70, Math.min(e.dt, 1000)) / speed);
    onEvent(e.event, e.event === 'live' ? { url: null, mode: 'replay' } : e.data);
  }
}
