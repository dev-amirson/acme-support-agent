import { describe, expect, it } from 'vitest';
import { parseFrame, readSse } from './sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe('SSE reader', () => {
  it('parses frames split across chunks, skips heartbeats, stops at the end frame', async () => {
    const got: string[] = [];
    await readSse(
      streamOf(['id: 1\ndata: {"a":', '1}\n\n: keep-alive\n\n', 'data: {"b":2}\r\n\r\n', 'event: end\ndata: {}\n\n', 'data: {"never":true}\n\n']),
      new AbortController().signal,
      (d) => got.push(d),
    );
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('joins multi-line data fields', () => {
    expect(parseFrame('data: line1\ndata: line2')).toEqual({ event: 'message', data: 'line1\nline2' });
    expect(parseFrame(': comment only')).toBeNull();
  });
});
