import OpenAI from 'openai';
import type { AppConfig } from '../config';
import { HashEmbedder, OpenAIEmbedder } from './embedders';
import { offlineScript, ScriptedChatModel } from './fake-chat';
import { OpenAIChatModel } from './openai-chat';
import type { ChatModel, Embedder } from './types';
import { EMBEDDING_DIMENSIONS } from '../db/schema';

export interface ModelProviders {
  openai: OpenAI | null;
  chat: ChatModel;
  embedder: Embedder;
}

/** Composition point for model vendors — the only place that knows which provider is in use. */
export function createProviders(config: AppConfig): ModelProviders {
  const { env } = config;
  if (env.AI_PROVIDER === 'fake') {
    return {
      openai: null,
      chat: new ScriptedChatModel(offlineScript),
      embedder: new HashEmbedder(EMBEDDING_DIMENSIONS),
    };
  }
  const openai = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    // Retries/timeouts are owned by our resilience layer so they're observable and streamed to the UI.
    maxRetries: 0,
    timeout: env.LLM_TIMEOUT_MS,
  });
  return {
    openai,
    chat: new OpenAIChatModel(openai, env.OPENAI_CHAT_MODEL, config.reasoningEffort),
    embedder: new OpenAIEmbedder(openai, env.OPENAI_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS),
  };
}
