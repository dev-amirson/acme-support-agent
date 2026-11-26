'use client';

import { create } from 'zustand';
import { DEFAULT_CHAOS, type AgentEvent, type ChaosConfig, type PublicConfig, type VoiceServerMessage, type VoiceState } from '@acme/contracts';
import { api, ApiError } from './api';
import {
  addOptimisticUserMessage,
  EMPTY_CONVERSATION,
  failPending,
  fromSnapshot,
  reduce,
  type ConversationEvent,
  type ConversationState,
} from './conversation';
import { VoiceClient } from './voice/voice-client';

const SESSION_KEY = 'acme-support.sessionId';
const AGENT_EVENT_TYPES = new Set<string>([
  'turn.started', 'step.started', 'step.progress', 'step.completed', 'message.started', 'message.delta',
  'message.completed', 'message.truncated', 'session.updated', 'escalation.created', 'recovery', 'error',
  'trace.span', 'turn.completed',
]);

export type VoiceStatus = 'off' | 'connecting' | 'live' | 'error';

export interface VoiceView {
  status: VoiceStatus;
  state: VoiceState;
  muted: boolean;
  userPartial: string;
  caption: string;
  notice: string | null;
  error: string | null;
}

const VOICE_OFF: VoiceView = { status: 'off', state: 'connecting', muted: false, userPartial: '', caption: '', notice: null, error: null };

interface AppState {
  config: PublicConfig | null;
  sessionId: string | null;
  booting: boolean;
  bootError: string | null;
  conversation: ConversationState;
  chaos: ChaosConfig;
  totals: { costUsd: number; inputTokens: number; outputTokens: number; turns: number };
  drawerOpen: boolean;
  selectedTurnId: string | null;
  voice: VoiceView;
  voiceClient: VoiceClient | null;
  chatAbort: AbortController | null;

  boot(): Promise<void>;
  newConversation(): Promise<void>;
  send(text: string): Promise<void>;
  stop(): void;
  retry(messageKey: string): void;
  dispatch(ev: ConversationEvent): void;
  setChaos(patch: Partial<ChaosConfig>): Promise<void>;
  toggleDrawer(open?: boolean): void;
  selectTurn(turnId: string | null): void;
  startVoice(): Promise<void>;
  stopVoice(): Promise<void>;
  toggleMute(): void;
}

const readStoredSession = () => {
  try {
    return window.localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
};
const storeSession = (id: string | null) => {
  try {
    if (id) window.localStorage.setItem(SESSION_KEY, id);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode / blocked storage: the session simply won't resume after reload */
  }
};

const newKey = () => `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const useApp = create<AppState>((set, get) => ({
  config: null,
  sessionId: null,
  booting: true,
  bootError: null,
  conversation: EMPTY_CONVERSATION,
  chaos: DEFAULT_CHAOS,
  totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
  drawerOpen: false,
  selectedTurnId: null,
  voice: VOICE_OFF,
  voiceClient: null,
  chatAbort: null,

  async boot() {
    set({ booting: true, bootError: null });
    try {
      const config = await api.config();
      set({ config });
      const stored = readStoredSession();
      if (stored) {
        try {
          const snap = await api.snapshot(stored);
          set({ sessionId: stored, conversation: fromSnapshot(snap), chaos: snap.chaos, totals: snap.totals, booting: false });
          return;
        } catch (err) {
          if (!(err instanceof ApiError) || err.status !== 404) throw err;
        }
      }
      await get().newConversation();
      set({ booting: false });
    } catch (err) {
      set({ booting: false, bootError: err instanceof Error ? err.message : 'Failed to start' });
    }
  },

  async newConversation() {
    await get().stopVoice();
    get().chatAbort?.abort();
    const { sessionId } = await api.createSession();
    storeSession(sessionId);
    set({ sessionId, conversation: EMPTY_CONVERSATION, chaos: DEFAULT_CHAOS, totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 }, selectedTurnId: null, chatAbort: null });
  },

  dispatch(ev) {
    set((s) => {
      const conversation = reduce(s.conversation, ev);
      let totals = s.totals;
      if (ev.type === 'turn.completed') {
        const prev = s.conversation.turns[ev.turnId]?.metrics;
        totals = {
          costUsd: totals.costUsd - (prev?.costUsd ?? 0) + ev.metrics.costUsd,
          inputTokens: totals.inputTokens - (prev?.inputTokens ?? 0) + ev.metrics.inputTokens,
          outputTokens: totals.outputTokens - (prev?.outputTokens ?? 0) + ev.metrics.outputTokens,
          turns: totals.turns + (prev ? 0 : 1),
        };
      }
      return { conversation, totals };
    });
  },

  async send(text) {
    const { sessionId, conversation } = get();
    const message = text.trim();
    if (!sessionId || !message || conversation.activeTurnId || get().chatAbort) return;
    const key = newKey();
    const controller = new AbortController();
    set((s) => ({ conversation: addOptimisticUserMessage(s.conversation, key, message, 'text'), chatAbort: controller }));
    try {
      await api.sendMessage(sessionId, message, { clientTurnId: key, signal: controller.signal, onEvent: (e) => get().dispatch(e) });
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, 'INTERNAL', 'Something went wrong.', true);
      set((s) => ({ conversation: failPending(s.conversation, key, { code: e.code as never, message: e.message, retryable: e.retryable }, message) }));
    } finally {
      // Stream ended without turn.completed (connection drop): don't leave the UI spinning.
      set((s) => {
        const active = s.conversation.activeTurnId;
        if (active && !controller.signal.aborted) {
          const conv = reduce(s.conversation, {
            type: 'error',
            turnId: active,
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'The connection dropped before the reply finished. Your conversation is saved — retry to continue.',
            retryable: true,
          });
          return { chatAbort: null, conversation: { ...conv, activeTurnId: null } };
        }
        return { chatAbort: null };
      });
    }
  },

  stop() {
    get().chatAbort?.abort();
    set((s) => {
      const active = s.conversation.activeTurnId;
      if (!active) return { chatAbort: null };
      const conv = reduce(s.conversation, { type: 'turn.completed', turnId: active, status: 'aborted', metrics: s.conversation.turns[active]?.metrics ?? EMPTY_METRICS });
      return { chatAbort: null, conversation: conv };
    });
  },

  retry(messageKey) {
    const msg = get().conversation.messages.find((m) => m.key === messageKey);
    if (msg?.retryText) void get().send(msg.retryText);
  },

  async setChaos(patch) {
    const { sessionId, chaos } = get();
    if (!sessionId) return;
    const next = { ...chaos, ...patch };
    set({ chaos: next });
    try {
      const res = await api.setChaos(sessionId, next);
      set({ chaos: res.chaos });
    } catch {
      set({ chaos });
    }
  },

  toggleDrawer(open) {
    set((s) => ({ drawerOpen: open ?? !s.drawerOpen }));
  },

  selectTurn(turnId) {
    set({ selectedTurnId: turnId });
  },

  async startVoice() {
    const { sessionId, voiceClient, config } = get();
    if (!sessionId || voiceClient || !config?.voiceEnabled) return;
    const setVoice = (patch: Partial<VoiceView>) => set((s) => ({ voice: { ...s.voice, ...patch } }));
    set({ voice: { ...VOICE_OFF, status: 'connecting' } });

    const client = new VoiceClient(sessionId, {
      onMessage: (msg: VoiceServerMessage) => {
        if (AGENT_EVENT_TYPES.has(msg.type)) {
          get().dispatch(msg as AgentEvent);
          if (msg.type === 'turn.started') setVoice({ userPartial: '', caption: '' });
          return;
        }
        switch (msg.type) {
          case 'voice.state':
            setVoice({ state: msg.state, ...(msg.state === 'listening' ? { caption: '' } : {}) });
            break;
          case 'transcript.user.delta':
            set((s) => ({ voice: { ...s.voice, userPartial: s.voice.userPartial + msg.delta } }));
            break;
          case 'transcript.user.final':
            setVoice({ userPartial: msg.text });
            break;
          case 'voice.interrupt':
            setVoice({ caption: '', notice: 'Interrupted — listening' });
            window.setTimeout(() => setVoice({ notice: null }), 1600);
            break;
          case 'voice.error':
            if (msg.fatal) setVoice({ status: 'error', error: msg.message });
            else {
              setVoice({ notice: msg.message });
              window.setTimeout(() => setVoice({ notice: null }), 3000);
            }
            break;
          default:
            break;
        }
      },
      onCaption: (text) => setVoice({ caption: text }),
      onClose: ({ expected, reason }) => {
        set((s) => ({
          voiceClient: null,
          voice: expected ? VOICE_OFF : { ...s.voice, status: 'error', error: s.voice.error ?? (reason || 'Voice connection closed.') },
        }));
      },
    });
    set({ voiceClient: client });
    try {
      await client.start();
      setVoice({ status: 'live', state: 'listening' });
    } catch (err) {
      await client.stop();
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Microphone permission was denied. Allow microphone access in your browser to use voice.'
          : err instanceof Error
            ? err.message
            : 'Voice is unavailable right now.';
      set({ voiceClient: null, voice: { ...VOICE_OFF, status: 'error', error: message } });
    }
  },

  async stopVoice() {
    const client = get().voiceClient;
    set({ voiceClient: null, voice: VOICE_OFF });
    await client?.stop();
  },

  toggleMute() {
    const { voiceClient, voice } = get();
    if (!voiceClient) return;
    voiceClient.setMuted(!voice.muted);
    set({ voice: { ...voice, muted: !voice.muted } });
  },
}));

const EMPTY_METRICS = {
  e2eLatencyMs: 0,
  ttftMs: null,
  timeToFirstAudioMs: null,
  llmCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};
