export function newConversationId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return 'pl-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); // 35 chars (limit 36)
}

/** POST → Server-Sent Events. Calls onEvent for each frame; resolves when the stream ends. */
export async function streamAssess(
  conversationId: string,
  body: Record<string, unknown>,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/assess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'makers-conversation-id': conversationId },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Assessment service returned HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      try {
        onEvent(ev, JSON.parse(data));
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}

export async function runProbe(conversationId: string): Promise<any> {
  const res = await fetch('/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'makers-conversation-id': conversationId },
    body: JSON.stringify({ target: location.origin + '/demo/login/' }),
  });
  return res.json();
}
