import {
  VOICE_SAMPLE_RATE,
  type AgentEvent,
  type UsageLine,
  type VoiceClientMessage,
  type VoiceServerMessage,
  type VoiceState,
} from '@acme/contracts';
import type { AgentOrchestrator, TurnResult } from '../agent/orchestrator';
import type { AppConfig } from '../config';
import { AppError, userFacingMessage } from '../lib/errors';
import type { Logger } from '../lib/logger';
import { sumCost, transcriptionUsageLine, ttsUsageLine } from '../llm/pricing';
import type { BudgetGuard } from '../observability/budget';
import type { SessionService } from '../session/session-service';
import { RealtimeTranscriber } from './realtime-transcriber';
import { SentenceSegmenter } from './sentence-segmenter';
import { SpeechPipeline } from './speech-pipeline';
import { heardPrefix, isBackchannel, toSpokenText } from './spoken-text';
import type { FillerCache, TextToSpeech } from './tts';
import { EnergyVad } from './vad';

export interface VoiceTransport {
  json(msg: VoiceServerMessage): void;
  binary(frame: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface VoiceSessionDeps {
  config: AppConfig;
  log: Logger;
  orchestrator: AgentOrchestrator;
  sessions: SessionService;
  budget: BudgetGuard;
  tts: TextToSpeech;
  fillers: FillerCache;
}

interface ActiveResponse {
  id: number;
  turnId: string | null;
  messageId: string | null;
  controller: AbortController;
  pipeline: SpeechPipeline;
  segmenter: SentenceSegmenter;
  turnDone: Promise<TurnResult | null>;
  /** When the customer stopped speaking (commit time − endpointing delay). */
  speechEndedAt: number;
  firstAudioAt: number | null;
  textSegments: number;
  fillerPlayed: boolean;
  interrupted: boolean;
  audioCompleted: boolean;
  ttsChars: number;
  truncationTimer: NodeJS.Timeout | null;
}

const PRE_ROLL_FRAMES = 15; // 300 ms @ 20 ms frames — catches the first syllable before VAD fires
const BYTES_PER_SECOND = VOICE_SAMPLE_RATE * 2;

/**
 * One live voice call. Voice is a *transport* over the same orchestrator as chat:
 *
 *   mic PCM ─▶ VAD ─(speech only)─▶ streaming STT ─▶ transcript ─▶ AgentOrchestrator.runTurn
 *                                                              (same tools, guardrails, memory)
 *   speaker ◀─ PCM frames ◀─ SpeechPipeline (streaming TTS) ◀─ sentence segmenter ◀─ text deltas
 *
 * Barge-in: speech onset while the agent is talking ducks playback immediately; if it's sustained
 * (or live transcription produces real words) the response is interrupted — generation and TTS are
 * aborted, the client flushes its buffer, and the stored reply is truncated to what was heard.
 */
export class VoiceSession {
  private state: VoiceState = 'connecting';
  private readonly vad: EnergyVad;
  private readonly transcriber: RealtimeTranscriber;
  private preRoll: Int16Array[] = [];
  private forwarding = false;
  private utteranceBytes = 0;
  private response: ActiveResponse | null = null;
  private readonly awaitingTruncation = new Map<number, ActiveResponse>();
  private responseSeq = 0;
  private bargeTimer: NodeJS.Timeout | null = null;
  private muted = false;
  private closed = false;
  private lastCommitAt = 0;
  private sessionTimer: NodeJS.Timeout | null = null;
  private readonly env: AppConfig['env'];

  constructor(
    private readonly sessionId: string,
    private readonly transport: VoiceTransport,
    private readonly deps: VoiceSessionDeps,
  ) {
    this.env = deps.config.env;
    this.vad = new EnergyVad({
      sampleRate: VOICE_SAMPLE_RATE,
      startFrames: this.env.VAD_START_FRAMES,
      endSilenceMs: this.env.VAD_END_SILENCE_MS,
      minUtteranceMs: this.env.VAD_MIN_UTTERANCE_MS,
    });
    this.transcriber = new RealtimeTranscriber(
      {
        apiKey: this.env.OPENAI_API_KEY ?? '',
        model: this.env.OPENAI_TRANSCRIBE_MODEL,
        delay: this.env.OPENAI_TRANSCRIBE_DELAY || null,
        log: deps.log,
      },
      {
        onDelta: (itemId, delta) => this.onTranscriptDelta(itemId, delta),
        onCompleted: (itemId, text) => void this.onTranscriptCompleted(itemId, text),
        onFailed: (itemId, message) => {
          deps.log.warn({ itemId, message }, 'utterance transcription failed');
          this.send({ type: 'voice.error', code: 'VOICE_UNAVAILABLE', message: "Sorry, I didn't catch that — could you say it again?", fatal: false });
          if (!this.response) this.setState('listening');
        },
        onError: (error, fatal) => {
          this.send({ type: 'voice.error', code: error.code, message: error.message, fatal });
          if (fatal) this.close(1011, 'speech recognition unavailable');
        },
      },
    );
  }

  async start(): Promise<void> {
    void this.deps.fillers.warm();
    await this.transcriber.connect();
    this.send({
      type: 'voice.ready',
      sampleRate: VOICE_SAMPLE_RATE,
      transcriptionModel: this.env.OPENAI_TRANSCRIBE_MODEL,
      ttsModel: this.deps.tts.model,
    });
    this.setState('listening');
    this.sessionTimer = setTimeout(() => {
      this.send({ type: 'voice.error', code: 'VOICE_UNAVAILABLE', message: 'Voice session time limit reached. You can keep chatting by text or start voice again.', fatal: true });
      this.close(1000, 'session time limit');
    }, this.env.VOICE_MAX_SESSION_MINUTES * 60_000);
  }

  // -- inbound -------------------------------------------------------------------------------

  onAudio(data: Buffer): void {
    if (this.closed || this.muted || this.state === 'connecting') return;
    // Copy: ws Buffers can sit at odd offsets inside a shared slab, Int16Array needs alignment.
    const bytes = new Uint8Array(data.byteLength - (data.byteLength % 2));
    bytes.set(data.subarray(0, bytes.byteLength));
    const pcm = new Int16Array(bytes.buffer);

    this.vad.echoGuard = this.state === 'speaking';
    const { frames, events } = this.vad.push(pcm);
    for (const frame of frames) {
      if (frame.speech) {
        if (!this.forwarding) {
          this.forwarding = true;
          for (const pre of this.preRoll) this.forward(pre);
          this.preRoll = [];
        }
        this.forward(frame.samples);
      } else {
        this.forwarding = false;
        this.preRoll.push(frame.samples);
        if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      }
    }
    for (const ev of events) {
      if (ev.type === 'speech_start') this.onSpeechStart();
      else this.onSpeechEnd(ev.valid);
    }
  }

  onControl(msg: VoiceClientMessage): void {
    switch (msg.type) {
      case 'ping':
        this.send({ type: 'pong', t: msg.t });
        return;
      case 'mic.muted':
        this.muted = msg.muted;
        if (msg.muted) {
          this.vad.reset();
          this.forwarding = false;
          this.transcriber.clear();
        }
        return;
      case 'playback.truncated': {
        const resp = this.awaitingTruncation.get(msg.responseId);
        if (resp) void this.applyTruncation(resp, msg.playedMs);
        return;
      }
      case 'playback.finished':
        if (this.response?.id === msg.responseId && this.response.audioCompleted) this.finishResponse();
        return;
    }
  }

  private forward(samples: Int16Array): void {
    this.utteranceBytes += samples.byteLength;
    this.transcriber.append(samples);
  }

  // -- turn taking -------------------------------------------------------------------------

  private onSpeechStart(): void {
    const resp = this.response;
    if (resp && !resp.interrupted && (this.state === 'speaking' || this.state === 'thinking')) {
      // Possible barge-in: duck now (instant feedback), confirm before cutting the agent off.
      if (this.state === 'speaking') this.send({ type: 'voice.duck', responseId: resp.id });
      this.clearBargeTimer();
      this.bargeTimer = setTimeout(() => {
        if (this.vad.speaking) this.interrupt('sustained speech');
      }, this.env.VAD_BARGE_IN_MS);
      return;
    }
    this.setState('user_speaking');
  }

  private onSpeechEnd(valid: boolean): void {
    this.clearBargeTimer();
    const seconds = this.utteranceBytes / BYTES_PER_SECOND;
    this.utteranceBytes = 0;
    if (!valid) {
      // Cough, click, echo blip — discard it and restore playback.
      this.transcriber.clear();
      void this.recordUsage([transcriptionUsageLine(this.env.OPENAI_TRANSCRIBE_MODEL, seconds)]);
      if (this.response && !this.response.interrupted && this.state === 'speaking') {
        this.send({ type: 'voice.unduck', responseId: this.response.id });
      } else if (this.state === 'user_speaking') {
        this.setState(this.response ? 'thinking' : 'listening');
      }
      return;
    }
    this.pendingUtteranceSeconds = seconds;
    this.lastCommitAt = performance.now();
    this.transcriber.commit();
    if (!this.response || this.response.interrupted) this.setState('thinking');
  }

  private pendingUtteranceSeconds = 0;

  private onTranscriptDelta(itemId: string, delta: string): void {
    this.send({ type: 'transcript.user.delta', itemId, delta });
    // Word-confirmed barge-in: live STT heard real words over the agent — don't wait for the timer.
    if (this.bargeTimer && /[a-z]{3,}/i.test(delta) && !isBackchannel(delta)) this.interrupt('transcribed speech');
  }

  private async onTranscriptCompleted(itemId: string, transcript: string): Promise<void> {
    const text = transcript.trim();
    this.send({ type: 'transcript.user.final', itemId, text });
    const stt = transcriptionUsageLine(this.env.OPENAI_TRANSCRIBE_MODEL, this.pendingUtteranceSeconds);
    this.pendingUtteranceSeconds = 0;

    if (text.replace(/[^a-z0-9]/gi, '').length < 2) {
      void this.recordUsage([stt]);
      if (!this.response) this.setState('listening');
      return;
    }
    // "mm-hmm" / "okay" while the agent talks is a backchannel, not a turn.
    if (this.response && !this.response.interrupted && this.state === 'speaking' && isBackchannel(text)) {
      void this.recordUsage([stt]);
      this.send({ type: 'voice.unduck', responseId: this.response.id });
      return;
    }
    await this.startTurn(text, [stt]);
  }

  private async startTurn(text: string, priorUsage: UsageLine[]): Promise<void> {
    if (this.closed) return;
    if (this.response && !this.response.interrupted) this.interrupt('new utterance');

    const id = ++this.responseSeq;
    const controller = new AbortController();
    const resp: ActiveResponse = {
      id,
      turnId: null,
      messageId: null,
      controller,
      segmenter: new SentenceSegmenter(),
      pipeline: new SpeechPipeline({
        responseId: id,
        tts: this.deps.tts,
        signal: controller.signal,
        log: this.deps.log,
        send: (frame) => this.transport.binary(frame),
        onSegmentStart: (seg) => {
          if (resp.firstAudioAt === null) {
            resp.firstAudioAt = performance.now();
            this.send({ type: 'audio.started', responseId: id, turnId: resp.turnId ?? '', sampleRate: VOICE_SAMPLE_RATE });
            this.setState('speaking');
          }
          this.send({ type: 'audio.segment', responseId: id, segmentIndex: seg.index, text: seg.display });
        },
      }),
      turnDone: Promise.resolve(null),
      speechEndedAt: this.lastCommitAt - this.env.VAD_END_SILENCE_MS,
      firstAudioAt: null,
      textSegments: 0,
      fillerPlayed: false,
      interrupted: false,
      audioCompleted: false,
      ttsChars: 0,
      truncationTimer: null,
    };
    this.response = resp;
    this.setState('thinking');

    resp.turnDone = this.deps.orchestrator
      .runTurn({
        sessionId: this.sessionId,
        text,
        mode: 'voice',
        preempt: true,
        signal: controller.signal,
        priorUsage,
        emit: (ev) => this.onAgentEvent(resp, ev),
      })
      .catch((err: unknown) => {
        const e = err instanceof AppError ? err : new AppError('INTERNAL', String(err));
        this.send({ type: 'error', code: e.code, message: userFacingMessage(e.code), retryable: e.retryable });
        return null;
      });

    const result = await resp.turnDone;
    if (resp.interrupted) return;
    for (const seg of resp.segmenter.flush()) this.speak(resp, seg);
    resp.pipeline.end();
    await resp.pipeline.done;
    if (resp.interrupted) return;
    resp.audioCompleted = true;
    this.send({ type: 'audio.completed', responseId: id });
    if (resp.pipeline.segments.length === 0) this.finishResponse();
    if (result) await this.amendTrace(resp, result);
  }

  private onAgentEvent(resp: ActiveResponse, ev: AgentEvent): void {
    this.send(ev);
    if (resp.interrupted) return;
    switch (ev.type) {
      case 'turn.started':
        resp.turnId = ev.turnId;
        return;
      case 'message.started':
        resp.messageId = ev.messageId;
        return;
      case 'message.delta':
        for (const seg of resp.segmenter.push(ev.delta)) this.speak(resp, seg);
        return;
      case 'step.started':
        // Tools are about to run and nothing has been said yet: cover the silence.
        if (ev.kind === 'tool' && !resp.fillerPlayed && resp.textSegments === 0) {
          const filler = this.deps.fillers.take();
          if (filler) {
            resp.fillerPlayed = true;
            resp.pipeline.enqueue({ display: '', spoken: filler.phrase, filler: true, cachedPcm: filler.pcm });
          }
        }
        return;
      default:
        return;
    }
  }

  private speak(resp: ActiveResponse, display: string): void {
    const spoken = toSpokenText(display);
    if (!spoken) return;
    resp.textSegments++;
    resp.ttsChars += spoken.length;
    resp.pipeline.enqueue({ display, spoken });
  }

  // -- interruption ----------------------------------------------------------------------------

  private interrupt(reason: string): void {
    const resp = this.response;
    if (!resp || resp.interrupted) return;
    this.clearBargeTimer();
    resp.interrupted = true;
    this.deps.log.info({ responseId: resp.id, reason }, 'barge-in');
    this.send({ type: 'voice.interrupt', responseId: resp.id });
    resp.controller.abort();
    this.response = null;
    this.awaitingTruncation.set(resp.id, resp);
    // If the client never reports what it played, assume everything sent was heard.
    resp.truncationTimer = setTimeout(() => void this.applyTruncation(resp, null), 2_500);
    this.setState(this.vad.speaking ? 'user_speaking' : 'thinking');
  }

  private async applyTruncation(resp: ActiveResponse, playedMs: number | null): Promise<void> {
    if (!this.awaitingTruncation.delete(resp.id)) return;
    if (resp.truncationTimer) clearTimeout(resp.truncationTimer);
    const result = await resp.turnDone; // the orchestrator has persisted its (partial) reply
    const messageId = result?.assistantMessageId;
    if (!messageId) return;

    const played = playedMs ?? resp.pipeline.sentMs;
    let elapsed = 0;
    const heard: string[] = [];
    for (const seg of resp.pipeline.segments) {
      const segMs = seg.bytes / (BYTES_PER_SECOND / 1000);
      if (seg.filler) {
        elapsed += segMs;
        continue;
      }
      if (elapsed + segMs <= played) heard.push(seg.display);
      else {
        if (played > elapsed && segMs > 0) heard.push(heardPrefix(seg.display, (played - elapsed) / segMs));
        break;
      }
      elapsed += segMs;
    }
    const text = heard.join(' ').trim();
    await this.deps.sessions.repo.truncateMessage(this.sessionId, messageId, text);
    this.send({ type: 'message.truncated', messageId, text });
    if (result) await this.amendTrace(resp, result);
  }

  private finishResponse(): void {
    this.response = null;
    this.setState(this.vad.speaking ? 'user_speaking' : 'listening');
  }

  // -- accounting ------------------------------------------------------------------------------

  /** Fold voice-only costs and latency into the turn's persisted trace. */
  private async amendTrace(resp: ActiveResponse, result: TurnResult): Promise<void> {
    try {
      const trace = result.trace;
      const tts = ttsUsageLine(this.deps.tts.model, resp.pipeline.synthesizedSeconds, resp.ttsChars);
      if (!trace.usage.some((u) => u.kind === 'tts')) trace.usage.push(tts);
      trace.metrics.timeToFirstAudioMs = resp.firstAudioAt ? Math.round(resp.firstAudioAt - resp.speechEndedAt) : null;
      trace.metrics.costUsd = sumCost(trace.usage);
      trace.spans.push({
        id: `${trace.turnId}_tts`,
        parentId: trace.spans[0]?.id ?? null,
        kind: 'tts',
        name: 'speech synthesis',
        startedAt: trace.startedAt,
        endedAt: Date.now(),
        durationMs: null,
        status: 'ok',
        attributes: {
          model: this.deps.tts.model,
          segments: resp.pipeline.segments.length,
          audioSeconds: Number(resp.pipeline.synthesizedSeconds.toFixed(2)),
          interrupted: resp.interrupted,
          timeToFirstAudioMs: trace.metrics.timeToFirstAudioMs,
        },
        usage: tts,
      });
      await this.deps.sessions.repo.saveTrace(trace);
      await this.recordUsage([tts]);
      this.send({ type: 'turn.completed', turnId: trace.turnId, status: trace.status, metrics: trace.metrics });
    } catch (err) {
      this.deps.log.warn({ err }, 'failed to amend voice trace');
    }
  }

  private async recordUsage(lines: UsageLine[]): Promise<void> {
    try {
      await this.deps.sessions.repo.recordUsage(this.sessionId, lines);
      this.deps.budget.note(sumCost(lines));
    } catch {
      /* accounting must never break the call */
    }
  }

  // -- plumbing --------------------------------------------------------------------------------

  private setState(state: VoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.send({ type: 'voice.state', state });
  }

  private send(msg: VoiceServerMessage): void {
    if (!this.closed) this.transport.json(msg);
  }

  private clearBargeTimer(): void {
    if (this.bargeTimer) clearTimeout(this.bargeTimer);
    this.bargeTimer = null;
  }

  close(code = 1000, reason = 'closed'): void {
    if (this.closed) return;
    this.response?.controller.abort();
    this.closed = true;
    this.clearBargeTimer();
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    for (const resp of this.awaitingTruncation.values()) void this.applyTruncation(resp, null);
    this.transcriber.close();
    this.transport.close(code, reason);
  }
}
