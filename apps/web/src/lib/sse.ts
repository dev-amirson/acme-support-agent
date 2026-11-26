/**
 * Minimal Server-Sent Events reader for fetch() streams (EventSource can't POST).
 * Handles frames split across chunks, CRLF line endings, comments (heartbeats) and the
 * terminal `event: end` frame.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onData: (data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseFrame(frame);
        if (parsed?.event === 'end') return;
        if (parsed?.data) onData(parsed.data);
      }
    }
  } catch (err) {
    if (!signal.aborted) throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function parseFrame(frame: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (!data.length && event === 'message') return null;
  return { event, data: data.join('\n') };
}
