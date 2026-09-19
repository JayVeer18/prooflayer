/**
 * Browser drivers — private module.
 *
 * One interface, three backends:
 *   1. PlaywrightDriver over the EdgeOne sandbox Chromium (CDP)  → exact console/network events
 *   2. SandboxApiDriver over context.sandbox.browser.*          → fallback, hook-based observation
 *   3. PlaywrightDriver over a local Edge/Chrome (PL_DRIVER=local) → local development & tests
 */
import { now, sleep, withTimeout } from './_util';
import { ENSURE_CURSOR_SCRIPT, moveCursorToSelectorScript, typingBadgeScript } from './_cursor';
import type { ConEvt, NetEvt } from './_types';

export interface Shot {
  b64: string;
  mime: string;
}

export interface Driver {
  readonly mode: string;
  readonly liveUrl?: string;
  goto(url: string): Promise<{ url: string; status: number | null; title: string }>;
  fill(selector: string, text: string): Promise<void>;
  click(selector: string): Promise<void>;
  /** Click the first button/link whose visible text matches one of `texts`. */
  clickText(texts: string[]): Promise<boolean>;
  evaluate<T = unknown>(script: string): Promise<T>;
  screenshot(): Promise<Shot>;
  url(): Promise<string>;
  text(): Promise<string>;
  title(): Promise<string>;
  settle(): Promise<void>;
  /** Clear cookies + web storage so each assessment starts from a signed-out browser. */
  resetSession(): Promise<void>;
  /** Console/network events observed since the previous drain. */
  drain(): Promise<{ console: ConEvt[]; network: NetEvt[] }>;
  close(): Promise<void>;
}

const CLICK_TEXT_SCRIPT = (texts: string[]) => `${ENSURE_CURSOR_SCRIPT};(function(){
  var want=${JSON.stringify(texts.map((t) => t.toLowerCase()))};
  var els=Array.prototype.slice.call(document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"]'));
  for (var i=0;i<els.length;i++){
    var t=((els[i].innerText||els[i].value||els[i].textContent||'')+'').trim().toLowerCase();
    if(!t) continue;
    for (var j=0;j<want.length;j++){ if(t===want[j]||t.indexOf(want[j])===0){
      var el=els[i]; el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
      var r=el.getBoundingClientRect(); var cx=r.left+r.width/2, cy=r.top+r.height/2;
      var cur=document.getElementById('__pl_cursor');
      if(cur){ cur.style.left=(cx-2)+'px'; cur.style.top=(cy-2)+'px'; cur.classList.remove('click'); void cur.offsetWidth; cur.classList.add('click'); }
      el.click(); return true;
    } }
  }
  return false; })()`;

const HOST_NOISE = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);

function keepNet(kind: string, url: string, targetHost: string): boolean {
  if (kind === 'document' || kind === 'xhr' || kind === 'fetch') return true;
  if (kind === 'script') {
    try {
      const h = new URL(url).host;
      return h !== targetHost && !HOST_NOISE.has(h);
    } catch {
      return false;
    }
  }
  return false;
}

/* ─────────────────────────── Playwright (CDP or local) ─────────────────────────── */

export class PlaywrightDriver implements Driver {
  private con: ConEvt[] = [];
  private net: NetEvt[] = [];
  private targetHost = '';

  constructor(
    private page: any,
    readonly mode: string,
    readonly liveUrl?: string,
    private closer?: () => Promise<void>,
  ) {
    page.on('console', (m: any) => this.con.push({ ts: now(), type: m.type(), text: m.text() }));
    page.on('pageerror', (e: any) =>
      this.con.push({ ts: now(), type: 'pageerror', text: String(e?.message ?? e) }),
    );
    page.on('response', (r: any) => {
      try {
        const req = r.request();
        const kind = req.resourceType();
        if (!keepNet(kind, r.url(), this.targetHost)) return;
        this.net.push({ ts: now(), method: req.method(), url: r.url(), status: r.status(), kind });
      } catch {
        /* ignore */
      }
    });
  }

  private async safe<T>(fn: () => Promise<T>): Promise<T> {
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        if (!/context was destroyed|navigation|Target closed/i.test(String((e as Error)?.message))) throw e;
        await sleep(350);
      }
    }
    throw last;
  }

  async goto(url: string) {
    try {
      this.targetHost = new URL(url).host;
    } catch {
      /* ignore */
    }
    const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await this.settle();
    return { url: this.page.url(), status: resp ? resp.status() : null, title: await this.title() };
  }
  async fill(selector: string, text: string) {
    // Real keystrokes at a human pace, with a visible synthetic cursor and a typing badge,
    // so the live view shows a field being typed into rather than a value appearing instantly.
    // (Local test runs stay instant — no audience is watching those.)
    if (this.mode === 'local') {
      await this.safe(() => this.page.locator(selector).first().fill(text, { timeout: 8000 }));
      return;
    }
    await this.safe(async () => {
      await this.page.evaluate(moveCursorToSelectorScript(selector, true));
      const loc = this.page.locator(selector).first();
      await loc.click({ timeout: 8000 });
      await loc.fill('', { timeout: 8000 });
      // The badge reads the field's live value and masks it in-page based on the element's own
      // type="password" attribute — the real value never passes through this Node process as text.
      // pressSequentially has no per-keystroke hook, so refresh the badge at intervals instead of
      // only at the end — this keeps it honestly tied to what's actually in the field as it fills.
      const refresh = setInterval(() => {
        this.page.evaluate(typingBadgeScript(selector, true)).catch(() => undefined);
      }, 90);
      try {
        await loc.pressSequentially(text, { delay: 45 });
      } finally {
        clearInterval(refresh);
      }
      await this.page.evaluate(typingBadgeScript(selector, false));
    });
  }
  async click(selector: string) {
    await this.safe(async () => {
      if (this.mode !== 'local') await this.page.evaluate(moveCursorToSelectorScript(selector, true));
      await this.page.locator(selector).first().click({ timeout: 8000 });
    });
  }
  async clickText(texts: string[]) {
    return this.safe(() => this.page.evaluate(CLICK_TEXT_SCRIPT(texts))) as Promise<boolean>;
  }
  async evaluate<T = unknown>(script: string) {
    return this.safe(() => this.page.evaluate(script)) as Promise<T>;
  }
  async screenshot(): Promise<Shot> {
    const buf: Buffer = await this.safe(() => this.page.screenshot({ type: 'jpeg', quality: 72 }));
    return { b64: buf.toString('base64'), mime: 'image/jpeg' };
  }
  async url() {
    return this.page.url();
  }
  async title() {
    try {
      return String(await this.safe(() => this.page.title()));
    } catch {
      return '';
    }
  }
  async text() {
    return this.safe(() => this.page.evaluate('document.body ? document.body.innerText : ""')) as Promise<string>;
  }
  async settle() {
    try {
      await this.page.waitForLoadState('networkidle', { timeout: 2500 });
    } catch {
      /* fine — some pages never go idle */
    }
    await sleep(350);
  }
  async resetSession() {
    // Web storage is per-origin, so clear it while still on the target origin, then drop cookies.
    try {
      await this.page.evaluate('try{localStorage.clear();sessionStorage.clear()}catch(e){}');
    } catch {
      /* not on an http page yet */
    }
    try {
      await this.page.context().clearCookies();
    } catch {
      /* ignore */
    }
  }
  async drain() {
    const out = { console: this.con, network: this.net };
    this.con = [];
    this.net = [];
    return out;
  }
  async close() {
    try {
      await withTimeout(this.closer ? this.closer() : Promise.resolve(), 4000, 'driver close');
    } catch {
      /* ignore */
    }
  }
}

/* ───────────────────────── Sandbox atomic API fallback ───────────────────────── */

const HOOKS = `(function(){
  if (window.__plh) return 'ok'; window.__plh = 1;
  function push(k,o){ try{ var a=JSON.parse(sessionStorage.getItem('__pl_'+k)||'[]'); a.push(o); sessionStorage.setItem('__pl_'+k, JSON.stringify(a.slice(-200))); }catch(e){} }
  ['log','info','warn','error','debug'].forEach(function(t){
    var o=console[t]; if(!o) return;
    console[t]=function(){ try{ push('con',{ts:new Date().toISOString(),type:t,text:Array.prototype.map.call(arguments,function(x){ try{return typeof x==='string'?x:JSON.stringify(x)}catch(e){return String(x)} }).join(' ')}); }catch(e){}
      return o.apply(console,arguments); };
  });
  window.addEventListener('error',function(e){ push('con',{ts:new Date().toISOString(),type:'pageerror',text:String(e.message||e)}); });
  var f=window.fetch;
  if(f){ window.fetch=function(u,i){ var url=(typeof u==='string')?u:(u&&u.url); var m=(i&&i.method)||'GET';
    return f.apply(this,arguments).then(function(r){ push('net',{ts:new Date().toISOString(),method:m,url:r.url||url,status:r.status,kind:'fetch'}); return r; }); }; }
  return 'ok'; })()`;

const DRAIN = `(function(){
  var out={con:[],net:[]};
  try{ out.con=JSON.parse(sessionStorage.getItem('__pl_con')||'[]'); sessionStorage.removeItem('__pl_con'); }catch(e){}
  try{ out.net=JSON.parse(sessionStorage.getItem('__pl_net')||'[]'); sessionStorage.removeItem('__pl_net'); }catch(e){}
  try{
    var nav=performance.getEntriesByType('navigation')[0];
    if(nav) out.net.push({ts:new Date().toISOString(),method:'GET',url:nav.name,status:nav.responseStatus||null,kind:'document'});
    performance.getEntriesByType('resource').forEach(function(r){
      if(r.initiatorType==='fetch'||r.initiatorType==='xmlhttprequest') out.net.push({ts:new Date().toISOString(),method:'GET',url:r.name,status:r.responseStatus||null,kind:r.initiatorType==='fetch'?'fetch':'xhr'});
    });
    performance.clearResourceTimings();
  }catch(e){}
  return out; })()`;

export class SandboxApiDriver implements Driver {
  readonly mode = 'sandbox-api';
  private seen = new Set<string>();

  constructor(private sb: any, readonly liveUrl?: string) {}

  private async hooks() {
    try {
      await this.sb.evaluate(HOOKS);
    } catch {
      /* page may be mid-navigation */
    }
  }
  async goto(url: string) {
    const r = await this.sb.goto(url);
    await this.settle();
    await this.hooks();
    return { url: (await this.url()) || r?.url || url, status: r?.status ?? null, title: (await this.title()) || r?.title || '' };
  }
  async fill(selector: string, text: string) {
    await this.hooks();
    await this.sb.evaluate(moveCursorToSelectorScript(selector, true));
    // The badge reads the field's live value and masks it in-page based on the element's own
    // type="password" attribute — the real value never passes through this Node process as text.
    // Type character by character so the live view shows the entry (short strings only).
    const steps = text.length <= 32 ? text.length : 1;
    for (let i = 1; i <= steps; i++) {
      const part = steps === 1 ? text : text.slice(0, i);
      const script = `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;
        if(${i === 1}){el.focus();}
        var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        var set=Object.getOwnPropertyDescriptor(proto,'value').set;set.call(el,${JSON.stringify(part)});
        el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`;
      const ok = await this.sb.evaluate(script);
      if (ok === false) throw new Error(`fill: no element for ${selector}`);
      await this.sb.evaluate(typingBadgeScript(selector, true));
      if (steps > 1) await sleep(35);
    }
    await this.sb.evaluate(typingBadgeScript(selector, false));
  }
  async click(selector: string) {
    await this.hooks();
    await this.sb.evaluate(moveCursorToSelectorScript(selector, true));
    const ok = await this.sb.evaluate(
      `(function(){var el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`,
    );
    if (ok === false) throw new Error(`click: no element for ${selector}`);
  }
  async clickText(texts: string[]) {
    await this.hooks();
    return (await this.sb.evaluate(CLICK_TEXT_SCRIPT(texts))) === true;
  }
  async evaluate<T = unknown>(script: string) {
    return (await this.sb.evaluate(script)) as T;
  }
  async screenshot(): Promise<Shot> {
    const r = await this.sb.screenshot({ fullPage: false });
    return { b64: r?.base64Image ?? '', mime: 'image/png' };
  }
  async url() {
    try {
      return String(await this.sb.evaluate('location.href'));
    } catch {
      return '';
    }
  }
  async title() {
    try {
      return String(await this.sb.evaluate('document.title'));
    } catch {
      return '';
    }
  }
  async text() {
    return String(await this.sb.evaluate('document.body ? document.body.innerText : ""'));
  }
  async settle() {
    await sleep(1100);
  }
  async resetSession() {
    try {
      await this.sb.evaluate('localStorage.clear();sessionStorage.clear();document.cookie.split(";").forEach(function(c){document.cookie=c.replace(/^ +/,"").replace(/=.*/,"=;expires="+new Date(0).toUTCString()+";path=/")});true');
    } catch {
      /* about:blank has no storage */
    }
  }
  async drain() {
    let raw: any = { con: [], net: [] };
    try {
      raw = (await this.sb.evaluate(DRAIN)) ?? raw;
    } catch {
      /* ignore */
    }
    const network: NetEvt[] = [];
    for (const n of raw.net ?? []) {
      const key = `${n.url}|${n.status}`;
      if (this.seen.has(key) && n.kind !== 'document') continue;
      this.seen.add(key);
      network.push(n);
    }
    return { console: (raw.con ?? []) as ConEvt[], network };
  }
  async close() {
    try {
      await withTimeout(Promise.resolve(this.sb.close?.()), 3000, 'sandbox close');
    } catch {
      /* ignore */
    }
  }
}

/* ───────────────────────────────── factory ───────────────────────────────── */

/** Loaded by a runtime name so the Makers agent bundler (esbuild) does not try to bundle it. */
async function loadPlaywright(): Promise<any> {
  const name = ['playwright', 'core'].join('-');
  return import(name);
}

async function read(o: any, key: string): Promise<any> {
  if (!o) return undefined;
  const v = o[key];
  return typeof v === 'function' ? await v.call(o) : await v;
}

export async function createDriver(
  context: any,
  log: (level: 'info' | 'ok' | 'warn', text: string) => void,
): Promise<Driver> {
  const env = (context?.env ?? {}) as Record<string, string | undefined>;

  if ((env.PL_DRIVER ?? process.env.PL_DRIVER) === 'local') {
    const pw = await loadPlaywright();
    const browser = await pw.chromium.launch({
      channel: process.env.PL_CHANNEL || 'msedge',
      headless: process.env.PL_HEADED ? false : true,
    });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    log('info', 'Local browser driver (development mode)');
    return new PlaywrightDriver(page, 'local', undefined, () => browser.close());
  }

  const sb = context?.sandbox?.browser;
  if (!sb) throw new Error('Makers sandbox browser is not available in this runtime');

  let liveUrl: string | undefined;
  try {
    liveUrl = await read(sb, 'liveUrl');
  } catch {
    /* optional */
  }

  try {
    const cdpUrl = await read(sb, 'cdpUrl');
    if (!cdpUrl) throw new Error('no cdpUrl');
    const pw = await loadPlaywright();
    const browser: any = await withTimeout<any>(pw.chromium.connectOverCDP(String(cdpUrl)), 20000, 'CDP connect');
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
    } catch {
      /* viewport is best-effort on a CDP page */
    }
    log('ok', 'Connected to EdgeOne sandbox Chromium over CDP');
    return new PlaywrightDriver(page, 'sandbox-cdp', liveUrl, () => browser.close());
  } catch (e) {
    log('warn', `CDP unavailable (${(e as Error).message}); using sandbox atomic API with page hooks`);
    return new SandboxApiDriver(sb, liveUrl);
  }
}
