import { z } from 'zod';
import type { ErrorCode, AgentEvent } from './events';

/**
 * Voice WebSocket wire protocol.
 *
 * Audio is PCM16 little-endian, mono, 24 kHz in both directions (the native rate of the OpenAI
 * realtime transcription and TTS endpoints, so the server never resamples).
 *
 *   client → server  binary : raw mic PCM16 frames
 *   client → server  text   : VoiceClientMessage (JSON)
 *   server → client  binary : [u32 responseId][u32 segmentIndex][PCM16 …]  (little-endian header)
 *   server → client  text   : VoiceServerMessage (JSON) — AgentEvents are forwarded unchanged
 *
 * Tagging every audio frame with its responseId lets the client drop stale audio that was already
 * in flight when an interruption happened, without any server/client clock coordination.
 */

export const VOICE_SAMPLE_RATE = 24_000;
export const AUDIO_FRAME_HEADER_BYTES = 8;

export type VoiceState = 'connecting' | 'listening' | 'user_speaking' | 'thinking' | 'speaking';

export const voiceClientMessageSchema = z.discriminatedUnion('type', [
  /** Sent after a server `voice.interrupt`: how much of that response the user actually heard. */
  z.object({
    type: z.literal('playback.truncated'),
    responseId: z.number().int().nonnegative(),
    playedMs: z.number().nonnegative(),
  }),
  /** All audio for a response has finished playing on the client. */
  z.object({ type: z.literal('playback.finished'), responseId: z.number().int().nonnegative() }),
  z.object({ type: z.literal('mic.muted'), muted: z.boolean() }),
  z.object({ type: z.literal('ping'), t: z.number() }),
]);
export type VoiceClientMessage = z.infer<typeof voiceClientMessageSchema>;

export type VoiceEvent =
  | { type: 'voice.ready'; sampleRate: number; transcriptionModel: string; ttsModel: string }
  | { type: 'voice.state'; state: VoiceState }
  | { type: 'transcript.user.delta'; itemId: string; delta: string }
  | { type: 'transcript.user.final'; itemId: string; text: string }
  | { type: 'audio.started'; responseId: number; turnId: string; sampleRate: number }
  /** Caption for one spoken segment; arrives before that segment's audio frames. */
  | { type: 'audio.segment'; responseId: number; segmentIndex: number; text: string }
  | { type: 'audio.completed'; responseId: number }
  /** User started speaking over the assistant — lower playback volume until confirmed. */
  | { type: 'voice.duck'; responseId: number }
  | { type: 'voice.unduck'; responseId: number }
  /** Barge-in confirmed: stop playback immediately and report `playback.truncated`. */
  | { type: 'voice.interrupt'; responseId: number }
  /** After a barge-in: the assistant message now holds only what the customer actually heard. */
  | { type: 'message.truncated'; messageId: string; text: string }
  | { type: 'voice.error'; code: ErrorCode; message: string; fatal: boolean }
  | { type: 'pong'; t: number };

export type VoiceServerMessage = VoiceEvent | AgentEvent;

export function encodeAudioFrame(
  responseId: number,
  segmentIndex: number,
  pcm: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(AUDIO_FRAME_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, responseId, true);
  view.setUint32(4, segmentIndex, true);
  frame.set(pcm, AUDIO_FRAME_HEADER_BYTES);
  return frame;
}

export function decodeAudioFrame(buffer: ArrayBuffer): {
  responseId: number;
  segmentIndex: number;
  pcm: Int16Array;
} {
  const view = new DataView(buffer);
  const responseId = view.getUint32(0, true);
  const segmentIndex = view.getUint32(4, true);
  const sampleCount = Math.floor((buffer.byteLength - AUDIO_FRAME_HEADER_BYTES) / 2);
  return {
    responseId,
    segmentIndex,
    pcm: new Int16Array(buffer, AUDIO_FRAME_HEADER_BYTES, sampleCount),
  };
}
