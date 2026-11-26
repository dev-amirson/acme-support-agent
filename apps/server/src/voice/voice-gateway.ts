import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { voiceClientMessageSchema } from '@acme/contracts';
import type { Container } from '../container';
import { AppError } from '../lib/errors';
import { isSessionId } from '../lib/ids';
import { FillerCache, OpenAITextToSpeech } from './tts';
import { VoiceSession } from './voice-session';

const VOICE_PATH = /^\/api\/sessions\/([0-9a-f-]{36})\/voice$/i;

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${message}`);
  socket.destroy();
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
  return forwarded || req.socket.remoteAddress || 'unknown';
}

/**
 * WebSocket endpoint for live voice: `GET /api/sessions/:id/voice` (upgrade).
 * All admission checks run *before* the upgrade so rejected clients get a real HTTP status.
 */
export function attachVoiceGateway(server: Server, c: Container): void {
  const { env } = c.config;
  const openai = c.providers.openai;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const perIp = new Map<string, number>();
  const tts = openai ? new OpenAITextToSpeech(openai, env.OPENAI_TTS_MODEL, env.OPENAI_TTS_VOICE) : null;
  const fillers = tts ? new FillerCache(tts, c.log) : null;

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = url.pathname.match(VOICE_PATH);
      if (!match) return reject(socket, 404, 'Not Found');
      const sessionId = match[1]!;

      // Cross-site WebSocket hijacking defence: same-origin or an explicitly allowed origin.
      const origin = req.headers.origin;
      const host = req.headers.host;
      const sameOrigin = origin && host && new URL(origin).host === host;
      if (origin && !sameOrigin && !c.config.corsOrigins.includes(origin)) return reject(socket, 403, 'Forbidden');

      if (!tts || !fillers) return reject(socket, 503, 'Voice unavailable in offline mode');
      const ip = clientIp(req, env.TRUST_PROXY);
      if ((perIp.get(ip) ?? 0) >= env.VOICE_MAX_CONCURRENT_PER_IP) return reject(socket, 429, 'Too Many Requests');
      try {
        if (!isSessionId(sessionId)) throw new AppError('SESSION_NOT_FOUND', 'Unknown session');
        await c.sessions.require(sessionId);
        await c.budget.assertAvailable();
      } catch (err) {
        const e = err instanceof AppError ? err : new AppError('INTERNAL', String(err));
        return reject(socket, e.httpStatus, e.code);
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
        void runSession(ws, sessionId, ip);
      });
    })().catch((err) => {
      c.log.error({ err }, 'voice upgrade failed');
      reject(socket, 500, 'Internal Server Error');
    });
  });

  async function runSession(ws: WebSocket, sessionId: string, ip: string): Promise<void> {
    const log = c.log.child?.({ sessionId, transport: 'voice' }) ?? c.log;
    const session = new VoiceSession(
      sessionId,
      {
        json: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
        binary: (frame) => ws.readyState === ws.OPEN && ws.send(frame, { binary: true }),
        close: (code, reason) => ws.readyState === ws.OPEN && ws.close(code, reason),
      },
      { config: c.config, log, orchestrator: c.orchestrator, sessions: c.sessions, budget: c.budget, tts: tts!, fillers: fillers! },
    );

    // Heartbeat: detect half-open connections (mobile networks, sleeping laptops).
    let alive = true;
    ws.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 20_000);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return session.onAudio(data as Buffer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = voiceClientMessageSchema.safeParse(parsed);
      if (msg.success) session.onControl(msg.data);
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      perIp.set(ip, Math.max(0, (perIp.get(ip) ?? 1) - 1));
      session.close();
      log.info('voice session closed');
    });
    ws.on('error', (err) => log.warn({ err: err.message }, 'voice socket error'));

    try {
      await session.start();
      log.info('voice session started');
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError('VOICE_UNAVAILABLE', String(err));
      log.warn({ err: e.message }, 'voice session failed to start');
      ws.send(JSON.stringify({ type: 'voice.error', code: 'VOICE_UNAVAILABLE', message: 'Voice mode is unavailable right now. You can keep chatting by text.', fatal: true }));
      ws.close(1011, 'voice unavailable');
    }
  }
}
