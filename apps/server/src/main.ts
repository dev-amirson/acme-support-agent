import { pino } from 'pino';
import { loadConfig } from './config';
import { createContainer } from './container';
import { migrate } from './db/migrate';
import { createHttpServer } from './http/app';
import { ingestKnowledgeBase } from './rag/ingest';
import { attachVoiceGateway } from './voice/voice-gateway';

/**
 * Boot order is chosen for free-tier hosting (no release-phase jobs):
 *   1. migrate  (fast, advisory-locked so parallel boots are safe)
 *   2. listen   (liveness passes immediately)
 *   3. ingest the knowledge base in the background (incremental; /api/ready reports when done)
 */
const config = loadConfig();
const logger = pino({
  level: config.env.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie'],
  ...(config.isProd ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
});
const container = createContainer(config, logger);
const { server } = createHttpServer(container, logger);
attachVoiceGateway(server, container);

async function start(): Promise<void> {
  if (config.env.AUTO_MIGRATE) await migrate(container.pool, config, logger);
  await new Promise<void>((resolve) => server.listen(config.env.PORT, config.env.HOST, resolve));
  logger.info(
    { port: config.env.PORT, chat: config.env.OPENAI_CHAT_MODEL, provider: config.env.AI_PROVIDER, chaos: config.env.ENABLE_CHAOS },
    'support agent listening',
  );
  if (config.env.AUTO_INGEST) {
    ingestKnowledgeBase({
      dir: config.env.KB_DIR,
      repo: container.kbRepo,
      embedder: container.providers.embedder,
      log: (m) => logger.info(m),
    })
      .then((r) => {
        container.ingestion.status = 'ready';
        logger.info(r, 'knowledge base ready');
      })
      .catch((err) => {
        container.ingestion = { status: 'failed', error: (err as Error).message };
        logger.error({ err }, 'knowledge base ingestion failed');
      });
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await container.pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

start().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
