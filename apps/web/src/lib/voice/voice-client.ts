import {
  decodeAudioFrame,
  VOICE_SAMPLE_RATE,
  type VoiceClientMessage,
  type VoiceServerMessage,
} from '@acme/contracts';
import { wsUrl } from '../api';
import { PcmPlayer } from './pcm-player';

export interface VoiceClientHandlers {
  /** Every JSON message from the server (agent events + voice events). */
  onMessage(msg: VoiceServerMessage): void;
  /** Caption for the segment that just started playing. */
  onCaption(text: string): void;
  onClose(info: { code: number; reason: string; expected: boolean }): void;
}

export interface VoiceAnalysers {
  mic: AnalyserNode;
  output: AnalyserNode;
}

/**
 * Browser side of the voice transport. Owns the microphone graph, the WebSocket and playback.
 *
 * Barge-in contract with the server:
 *   voice.duck      → drop playback volume (the customer may be talking over us)
 *   voice.unduck    → false alarm, restore volume
 *   voice.interrupt → stop now, discard queued audio, reply `playback.truncated` with ms heard
 *   audio.completed → once the queue drains, reply `playback.finished`
 * Frames carry their response id, so audio still in flight after an interrupt is ignored.
 */
export class VoiceClient {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private ws: WebSocket | null = null;
  private player: PcmPlayer | null = null;
  private capture: AudioWorkletNode | null = null;
  private currentResponse: number | null = null;
  private readonly captions = new Map<string, string>();
  private muted = false;
  private closing = false;
  private pingTimer: number | null = null;
  analysers: VoiceAnalysers | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly handlers: VoiceClientHandlers,
  ) {}

  async start(): Promise<void> {
    // Mic permission first: if it's denied we haven't opened (and paid for) a server session.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.resume();
    await ctx.audioWorklet.addModule('/worklets/pcm-capture.js');

    const source = ctx.createMediaStreamSource(this.stream);
    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 1024;
    micAnalyser.smoothingTimeConstant = 0.6;
    source.connect(micAnalyser);

    this.capture = new AudioWorkletNode(ctx, 'pcm-capture', { processorOptions: { targetRate: VOICE_SAMPLE_RATE } });
    source.connect(this.capture);
    // Keep the worklet pulled by the graph without making the mic audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.capture.connect(sink).connect(ctx.destination);

    const outAnalyser = ctx.createAnalyser();
    outAnalyser.fftSize = 1024;
    outAnalyser.smoothingTimeConstant = 0.6;
    outAnalyser.connect(ctx.destination);
    this.player = new PcmPlayer(ctx, outAnalyser);
    this.player.onSegmentStart = (responseId, segmentIndex) => {
      const caption = this.captions.get(`${responseId}:${segmentIndex}`);
      if (caption) this.handlers.onCaption(caption);
    };
    this.analysers = { mic: micAnalyser, output: outAnalyser };

    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl(`/api/sessions/${this.sessionId}/voice`));
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let ready = false;

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return this.onAudio(ev.data as ArrayBuffer);
        const msg = JSON.parse(ev.data) as VoiceServerMessage;
        if (msg.type === 'voice.ready' && !ready) {
          ready = true;
          resolve();
        }
        this.onServerMessage(msg);
      };
      ws.onerror = () => {
        if (!ready) reject(new Error('Could not connect to the voice service.'));
      };
      ws.onclose = (ev) => {
        if (this.pingTimer) window.clearInterval(this.pingTimer);
        if (!ready) reject(new Error(ev.reason || `Voice connection rejected (${ev.code}).`));
        this.handlers.onClose({ code: ev.code, reason: ev.reason, expected: this.closing });
      };
      ws.onopen = () => {
        this.capture!.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
          if (!this.muted && ws.readyState === WebSocket.OPEN) ws.send(e.data);
        };
        this.pingTimer = window.setInterval(() => this.send({ type: 'ping', t: Date.now() }), 15_000);
      };
    });
  }

  private onAudio(buffer: ArrayBuffer): void {
    const { responseId, segmentIndex, pcm } = decodeAudioFrame(buffer);
    if (responseId !== this.currentResponse) return; // stale audio from an interrupted response
    this.player?.enqueue(responseId, segmentIndex, pcm);
  }

  private onServerMessage(msg: VoiceServerMessage): void {
    switch (msg.type) {
      case 'audio.started':
        this.currentResponse = msg.responseId;
        this.player?.begin(msg.responseId);
        break;
      case 'audio.segment':
        if (msg.text) this.captions.set(`${msg.responseId}:${msg.segmentIndex}`, msg.text);
        break;
      case 'audio.completed': {
        const id = msg.responseId;
        this.player?.onDrained(() => {
          if (this.currentResponse === id) this.send({ type: 'playback.finished', responseId: id });
        });
        break;
      }
      case 'voice.duck':
        if (msg.responseId === this.currentResponse) this.player?.setVolume(0.18);
        break;
      case 'voice.unduck':
        if (msg.responseId === this.currentResponse) this.player?.setVolume(1);
        break;
      case 'voice.interrupt': {
        const playedMs = msg.responseId === this.currentResponse ? (this.player?.stop() ?? 0) : 0;
        this.currentResponse = null;
        this.send({ type: 'playback.truncated', responseId: msg.responseId, playedMs });
        break;
      }
      default:
        break;
    }
    this.handlers.onMessage(msg);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.send({ type: 'mic.muted', muted });
  }

  private send(msg: VoiceClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    this.player?.stop();
    this.ws?.close(1000, 'client ended call');
    this.stream?.getTracks().forEach((t) => t.stop());
    this.capture?.disconnect();
    await this.ctx?.close().catch(() => undefined);
    this.analysers = null;
  }
}
