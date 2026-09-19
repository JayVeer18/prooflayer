/**
 * Humane cursor overlay — private module.
 *
 * A synthetic pointer + "typing…" badge injected into the TARGET page (not the extension layer),
 * so it renders identically in the sandbox's real-time view and in screenshots. Without this,
 * clicks and field fills happen instantly and invisibly, which is why the agent reads as
 * "mechanical" rather than as something a person could follow along with.
 *
 * All scripts are plain strings built with string concatenation / .replace() — no nested
 * template literals — so there is nothing here to accidentally mis-escape.
 *
 * Security note: the typing badge NEVER receives the real value from Node. `typingBadgeScript`
 * takes a selector, and the injected script reads the target element's own `type` attribute in
 * the page to decide whether to mask — the same ground truth the browser itself uses to render
 * a password field as dots. This avoids depending on every call site classifying a selector
 * correctly; a password can only ever reach the overlay as bullets, never as text.
 */

const CURSOR_CSS = [
  '#__pl_cursor{position:fixed;z-index:2147483647;width:22px;height:22px;pointer-events:none;',
  'transition:left .38s cubic-bezier(.2,.7,.3,1),top .38s cubic-bezier(.2,.7,.3,1);left:-40px;top:-40px}',
  '#__pl_cursor svg{filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))}',
  "#__pl_cursor.click:after{content:'';position:absolute;left:2px;top:2px;width:18px;height:18px;border-radius:50%;",
  'background:rgba(124,156,255,.55);animation:__pl_ripple .45s ease-out}',
  '@keyframes __pl_ripple{from{transform:scale(.2);opacity:1}to{transform:scale(2.2);opacity:0}}',
  '#__pl_typing{position:fixed;z-index:2147483647;background:#1b1d24;color:#c4d0ff;font:11px monospace;',
  'padding:3px 8px;border-radius:6px;border:1px solid #37478a;pointer-events:none;opacity:0;',
  'transition:opacity .15s;left:-999px;top:-999px;white-space:nowrap}',
  '#__pl_typing.show{opacity:1}',
].join('');

const CURSOR_SVG =
  '<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M2 1 L2 18 L6.5 14.5 L9.5 20.5 L12.5 19 L9.5 13 L15 13 Z" fill="#ffffff" stroke="#111111" stroke-width="1.1"/>' +
  '</svg>';

/** Idempotent — safe to call before every action. Builds the overlay via safe DOM APIs; the only
 * markup involved (CURSOR_SVG) is a fixed literal authored here, never page or user data. */
export const ENSURE_CURSOR_SCRIPT =
  '(function(){' +
  "if (document.getElementById('__pl_cursor')) return;" +
  "var s=document.createElement('style'); s.id='__pl_cursor_css'; s.textContent=" +
  JSON.stringify(CURSOR_CSS) +
  ';' +
  'document.head.appendChild(s);' +
  "var c=document.createElement('div'); c.id='__pl_cursor';" +
  'c.innerHTML=' +
  JSON.stringify(CURSOR_SVG) +
  ';' +
  'document.documentElement.appendChild(c);' +
  "var t=document.createElement('div'); t.id='__pl_typing';" +
  'document.documentElement.appendChild(t);' +
  '})()';

/** Moves the synthetic cursor to an element (by selector), optionally rippling a click. */
export function moveCursorToSelectorScript(selector: string, click: boolean): string {
  return (
    ENSURE_CURSOR_SCRIPT +
    ';(function(){' +
    'var el=document.querySelector(' +
    JSON.stringify(selector) +
    ');if(!el)return false;' +
    'el.scrollIntoView({block:"center",inline:"center",behavior:"instant"});' +
    'var r=el.getBoundingClientRect();' +
    'var x=r.left+r.width/2, y=r.top+r.height/2;' +
    "var c=document.getElementById('__pl_cursor');" +
    'c.style.left=(x-2)+"px"; c.style.top=(y-2)+"px";' +
    'if (' +
    JSON.stringify(click) +
    ') { c.classList.remove("click"); void c.offsetWidth; c.classList.add("click"); }' +
    'return true;' +
    '})()'
  );
}

/**
 * Shows or hides a "Typing …" badge next to the given field, reading the field's live value
 * directly from the DOM (`el.value`) and masking it in-page if the element's own `type` is
 * "password" — the browser's own signal for a secret field, not a guess based on selector text.
 * The real value is never passed in from Node.
 */
export function typingBadgeScript(selector: string, show: boolean): string {
  return (
    ENSURE_CURSOR_SCRIPT +
    ';(function(){' +
    "var t=document.getElementById('__pl_typing'); var c=document.getElementById('__pl_cursor');" +
    'if(!t||!c) return;' +
    'if (!(' +
    JSON.stringify(show) +
    ')) { t.classList.remove("show"); return; }' +
    'var el=document.querySelector(' +
    JSON.stringify(selector) +
    ');if(!el){t.classList.remove("show");return;}' +
    'var raw=String(el.value==null?"":el.value);' +
    'var isSecret=(el.getAttribute("type")||"").toLowerCase()==="password";' +
    'var shown=isSecret ? new Array(Math.min(raw.length,10)+1).join("\\u2022") : (raw.length>24?raw.slice(0,24)+"\\u2026":raw);' +
    'var cx=parseFloat(c.style.left)||0, cy=parseFloat(c.style.top)||0;' +
    't.style.left=(cx+16)+"px"; t.style.top=(cy+16)+"px";' +
    't.textContent="Typing \\u201c"+shown+"\\u201d";' +
    't.classList.add("show");' +
    '})()'
  );
}
