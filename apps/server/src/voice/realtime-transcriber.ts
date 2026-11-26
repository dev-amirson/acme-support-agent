import WebSocket from 'ws';
import { VOICE_SAMPLE_RATE } from '@acme/contracts';
import { backoffDelay } from '../lib/async';
import { AppError } from '../lib/errors';
import type { Logger } from '../lib/logger';

export interface TranscriberEvents {
  onDelta(itemId: string, delta: string): void;
  onCompleted(itemId: string, transcript: string): void;
  onFailed(itemId: string, message: string): void;
  /** Non-fatal problems (reconnecting, rejected commit) and fatal ones (gave up). */
  onError(error: AppError, fatal: boolean): void;
}

export interface TranscriberOptions {
  apiKey: string;
  model: string;
  delay: string | null;
  url?: string;
  log: Logger;
}

const BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2;
const MAX_QUEUED_MESSAGES = 250; // ~5s of audio buffered while (re)connecting

/**
 * Streaming speech-to-text over the OpenAI Realtime API (GA interface, transcription session).
 *
 * The live models stream transcript deltas while the customer is still talking — that's what the
 * UI's live caption shows. They require `turn_detection: null`, so turns are committed explicitly
 * by our VAD. Audio is only forwarded while the VAD hears speech (plus pre-roll), which both cuts
 * per-minute cost and stops silence from producing hallucinated transcripts.
 */
export class RealtimeTranscriber {
  private ws: WebSocket | null = null;
  private ready = false;
  private closedByUs = false;
  private reconnects = 0;
  private queue: string[] = [];
  bytesSent = 0;

  constructor(
    private readonly opts: TranscriberOptions,
    private readonly events: TranscriberEvents,
  ) {}

  get audioSeconds(): number {
    return this.bytesSent / BYTES_PER_SECOND;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.opts.url ?? 'wss://api.openai.com/v1/realtime?intent=transcription';
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.opts.apiKey}` } });
      this.ws = ws;
      this.ready = false;
      const timer = setTimeout(() => {
        reject(new AppError('VOICE_UNAVAILABLE', 'Speech recognition did not become ready in time'));
        ws.terminate();
      }, 10_000);

      ws.on('open', () => ws.send(JSON.stringify(this.sessionUpdate())));
      ws.on('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        reject(new AppError('VOICE_UNAVAILABLE', `Speech recognition handshake failed (HTTP ${res.statusCode})`));
      });
      ws.on('message', (raw) => {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (ev.type === 'session.updated' || ev.type === 'transcription_session.updated') {
          if (!this.ready) {
            this.ready = true;
            this.reconnects = 0;
            clearTimeout(timer);
            for (const msg of this.queue.splice(0)) ws.send(msg);
            resolve();
          }
          return;
        }
        this.handle(ev);
      });
      ws.on('error', (err) => {
        this.opts.log.warn({ err: err.message }, 'transcriber socket error');
        if (!this.ready) {
          clearTimeout(timer);
          reject(new AppError('VOICE_UNAVAILABLE', `Speech recognition unavailable: ${err.message}`));
        }
      });
      ws.on('close', (code) => {
        const wasReady = this.ready;
        this.ready = false;
        if (this.closedByUs || !wasReady) return;
        this.opts.log.warn({ code }, 'transcriber closed unexpectedly');
        void this.reconnect();
      });
    });
  }

  private sessionUpdate() {
    const live = /^gpt-(live|transcribe|realtime-whisper)/.test(this.opts.model);
    return {
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: VOICE_SAMPLE_RATE },
            transcription: {
              model: this.opts.model,
              // gpt-live-transcribe takes `languages`; older models take `language` — never both.
              ...(live ? { languages: ['en'] } : { language: 'en' }),
              ...(live && this.opts.delay ? { delay: this.opts.delay } : {}),
              ...(!live ? { prompt: 'Customer support call about an Acme Cloud account, billing, refunds, invoices.' } : {}),
            },
            turn_detection: null,
          },
        },
      },
    };
  }

  private async reconnect(): Promise<void> {
    if (this.reconnects >= 3) {
      this.events.onError(new AppError('VOICE_UNAVAILABLE', 'Speech recognition connection lost'), true);
      return;
    }
    this.reconnects++;
    this.events.onError(new AppError('VOICE_UNAVAILABLE', 'Reconnecting speech recognition…', { retryable: true }), false);
    await new Promise((r) => setTimeout(r, backoffDelay(this.reconnects, 300, 3_000)));
    if (this.closedByUs) return;
    try {
      await this.connect();
    } catch {
      await this.reconnect();
    }
  }

  private handle(ev: Record<string, unknown>): void {
    const itemId = String(ev.item_id ?? '');
    switch (ev.type) {
      case 'conversation.item.input_audio_transcription.delta':
        if (typeof ev.delta === 'string' && ev.delta) this.events.onDelta(itemId, ev.delta);
        return;
      case 'conversation.item.input_audio_transcription.completed':
        this.events.onCompleted(itemId, typeof ev.transcript === 'string' ? ev.transcript : '');
        return;
      case 'conversation.item.input_audio_transcription.failed': {
        const error = ev.error as { message?: string } | undefined;
        this.events.onFailed(itemId, error?.message ?? 'transcription failed');
        return;
      }
      case 'error': {
        const error = ev.error as { message?: string; code?: string } | undefined;
        this.opts.log.warn({ error }, 'transcriber error event');
        // e.g. committing an empty buffer — recoverable, the next utterance proceeds normally.
        this.events.onError(new AppError('VOICE_UNAVAILABLE', error?.message ?? 'Speech recognition error', { retryable: true }), false);
        return;
      }
      default:
        return;
    }
  }

  private send(msg: object): void {
    const data = JSON.stringify(msg);
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else if (this.queue.length < MAX_QUEUED_MESSAGES) this.queue.push(data);
  }

  append(pcm: Int16Array): void {
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    this.bytesSent += bytes.byteLength;
    this.send({ type: 'input_audio_buffer.append', audio: bytes.toString('base64') });
  }

  commit(): void {
    this.send({ type: 'input_audio_buffer.commit' });
  }

  clear(): void {
    this.send({ type: 'input_audio_buffer.clear' });
  }

  close(): void {
    this.closedByUs = true;
    this.queue = [];
    this.ws?.close();
  }
}
