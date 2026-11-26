import type { ServerResponse } from 'node:http';
import type { AgentEvent } from '@acme/contracts';

/**
 * Minimal SSE writer over a raw Node response. We POST (EventSource is GET-only) and the client
 * reads the stream with fetch(). Heartbeat comments keep proxies (Render, Cloudflare) from
 * closing an idle connection while a slow tool or model call is in flight.
 */
export class SseStream {
  private seq = 0;
  private heartbeat: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    this.heartbeat = setInterval(() => this.write(': keep-alive\n\n'), 15_000);
    res.on('close', () => this.dispose());
  }

  /** True when the client went away before we finished. */
  get clientGone(): boolean {
    return this.closed && !this.res.writableFinished;
  }

  onClientGone(fn: () => void): void {
    this.res.on('close', () => {
      if (!this.res.writableFinished) fn();
    });
  }

  send(event: AgentEvent): void {
    this.write(`id: ${++this.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.write('event: end\ndata: {}\n\n');
    this.dispose();
    this.res.end();
  }

  private write(chunk: string): void {
    if (this.closed || this.res.destroyed) return;
    this.res.write(chunk);
  }

  private dispose(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
  }
}
