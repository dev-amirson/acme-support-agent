import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type ErrorRequestHandler, type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger as PinoLogger } from 'pino';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@acme/contracts';
import type { Container } from '../container';
import { AppError, userFacingMessage } from '../lib/errors';
import { newId } from '../lib/ids';
import { limiter } from './rate-limit';
import { createApiRouter } from './routes';

export interface HttpServer {
  app: Express;
  server: Server;
}

export function createHttpServer(c: Container, logger: PinoLogger): HttpServer {
  const { env } = c.config;
  const app = express();
  app.disable('x-powered-by');
  // Render / most PaaS sit behind exactly one proxy hop; needed for per-client rate limits.
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // Next.js static export inlines its bootstrap scripts.
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:', ...c.config.corsOrigins],
          mediaSrc: ["'self'", 'blob:'],
          workerSrc: ["'self'", 'blob:'],
          // Only meaningful (and safe) behind TLS; on plain-http localhost it would break every request.
          upgradeInsecureRequests: c.config.isProd ? [] : null,
          // Hosts that render the app in an iframe (e.g. Hugging Face Spaces) must be allow-listed.
          frameAncestors: ["'self'", ...c.config.frameAncestors],
        },
      },
      // CSP frame-ancestors supersedes X-Frame-Options; keep the legacy header only when not embeddable.
      xFrameOptions: c.config.frameAncestors.length ? false : { action: 'sameorigin' },
      strictTransportSecurity: c.config.isProd,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = (req.headers['x-request-id'] as string | undefined) ?? newId('call').replace('call_', 'req_');
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' },
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );
  if (c.config.corsOrigins.length) app.use(cors({ origin: c.config.corsOrigins, credentials: true }));
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api', limiter({ windowMs: 60_000, limit: 120 }), createApiRouter(c));

  // Single-origin deployment: the API also serves the statically exported Next.js UI.
  const webRoot = path.resolve(env.WEB_DIST_DIR);
  const indexHtml = path.join(webRoot, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(express.static(webRoot, { maxAge: c.config.isProd ? '1h' : 0, index: 'index.html' }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(indexHtml);
      next();
    });
  } else {
    logger.warn({ webRoot }, 'web build not found — serving API only (run `npm run build -w @acme/web`)');
  }

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'VALIDATION', message: `Not found: ${req.method} ${req.path}`, retryable: false } } satisfies ApiErrorBody);
  });
  app.use(errorHandler);

  return { app, server: createServer(app) };
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let body: ApiErrorBody['error'];
  if (err instanceof AppError) {
    status = err.httpStatus;
    body = { code: err.code, message: err.code === 'VALIDATION' ? err.message : userFacingMessage(err.code), retryable: err.retryable };
  } else if (err instanceof ZodError) {
    status = 400;
    body = { code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), retryable: false };
  } else if (typeof err?.status === 'number' && err.status < 500) {
    // body-parser errors (malformed JSON, payload too large) carry a 4xx status.
    status = err.status;
    body = { code: 'VALIDATION', message: err.expose ? err.message : 'Invalid request', retryable: false };
  } else {
    req.log?.error({ err }, 'unhandled error');
    body = { code: 'INTERNAL', message: userFacingMessage('INTERNAL'), retryable: false };
  }
  if (res.headersSent) return;
  res.status(status).json({ error: { ...body, requestId: String(req.id ?? '') } } satisfies ApiErrorBody);
};
