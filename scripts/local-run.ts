/**
 * Local end-to-end run: serves public/ and runs the real orchestrator against the demo app
 * using a local Edge/Chrome (PL_DRIVER=local).
 *
 *   npm run test:local     → run and print results
 *   npm run record         → also write public/replay/acme-run.json (the recorded-replay fallback)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { runPlan, runExecute } from '../agents/_orchestrator';

process.env.PL_DRIVER = 'local';
const RECORD = process.argv.includes('--record');
const ROOT = path.resolve('public');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url || '/').split('?')[0]);
  let f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) {
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>404 Page not found</h1>');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }).end(fs.readFileSync(f));
});

interface Rec {
  dt: number;
  event: string;
  data: unknown;
}

async function main() {
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const base = `http://localhost:${port}/demo/`;
  const context: any = { env: { ...process.env }, conversation_id: 'local-test', store: { state: { set: async () => {} } } };
  const captured: Record<string, any[]> = {};
  const segments: Rec[][] = [];
  let seg: Rec[] = [];
  let last = Date.now();

  const emit = (event: string, data: any) => {
    (captured[event] ||= []).push(data);
    const t = Date.now();
    seg.push({ dt: t - last, event, data });
    last = t;
    if (event === 'log') console.log(`  [${data.level}] ${data.text}`);
    else if (event === 'finding') console.log(`  ▶ FINDING ${data.status} (${data.severity}) — ${data.title}\n     ${data.observed}`);
    else if (event === 'error') console.log(`  !! ERROR ${data.message}`);
    else if (event === 'phase') console.log(`\n== ${data.label}`);
  };
  const beginSegment = () => {
    seg = [];
    segments.push(seg);
    last = Date.now();
  };
  const creds = { targetUrl: base, username: 'buyer@acme-demo.test', password: 'Buyer#2026' };

  console.log('### PLAN segment');
  beginSegment();
  await runPlan({ context, emit, body: { ...creds, action: 'plan' } });
  const plan = captured.plan?.[0]?.items;
  const surfaces = captured.surfaces?.[0]?.items;
  if (!plan) throw new Error('no plan produced');
  console.log('\nPlan:', plan.map((p: any) => `${p.id}:${p.template}`).join(', '));

  const findings: any[] = [];
  const approvals: Record<string, any> = {};
  let fromIndex = 0;
  for (let guard = 0; guard < 4; guard++) {
    console.log(`\n### EXECUTE segment from ${fromIndex}`);
    beginSegment();
    const before = (captured.finding ?? []).length;
    await runExecute({ context, emit, body: { ...creds, action: 'execute', plan, surfaces, fromIndex, findings: [...findings], approvals } });
    (captured.finding ?? []).slice(before).forEach((f) => findings.push(f));
    const pause = captured.paused?.at(-1);
    if (captured.complete?.length) break;
    if (pause?.reason === 'test_approval') {
      console.log(`  ⏸  HITL requested for ${pause.testId} → auto-approving`);
      approvals[pause.testId] = { decision: 'run' };
      fromIndex = pause.fromIndex;
    } else break;
  }
  console.log('\n### COMPLETE', JSON.stringify(captured.complete?.[0]?.counts));
  console.log(captured.complete?.[0]?.narrative);

  if (RECORD) {
    // The recording came from a local run; present the target neutrally and label the mode at play time.
    const raw = JSON.stringify({ version: 1, recordedAt: new Date().toISOString(), segments })
      .replace(/localhost:\d+/g, 'acmedesk.demo')
      .replace(/http:\/\/acmedesk\.demo/g, 'https://acmedesk.demo');
    fs.mkdirSync(path.resolve('public/replay'), { recursive: true });
    fs.writeFileSync(path.resolve('public/replay/acme-run.json'), raw);
    console.log(`\nRecorded ${segments.map((s) => s.length).join(' + ')} events → public/replay/acme-run.json (${Math.round(raw.length / 1024)} KB)`);
  }
  server.close();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
