/**
 * CLI: (re)build the vector index from ./knowledge-base.
 *   npm run ingest            incremental (only changed docs / chunks are embedded)
 *   npm run ingest -- --force re-embed everything
 */
import { loadConfig } from '../config';
import { migrate } from '../db/migrate';
import { createDatabase } from '../db/pool';
import { createProviders } from '../llm/providers';
import { consoleLogger } from '../lib/logger';
import { ingestKnowledgeBase } from '../rag/ingest';
import { KnowledgeBaseRepository } from '../rag/kb-repository';

const config = loadConfig();
const { db, pool } = createDatabase(config);
try {
  await migrate(pool, config, consoleLogger);
  const { embedder } = createProviders(config);
  const repo = new KnowledgeBaseRepository(db);
  const report = await ingestKnowledgeBase({
    dir: config.env.KB_DIR,
    repo,
    embedder,
    force: process.argv.includes('--force'),
    log: (m) => console.log(`  ${m}`),
  });
  console.log('\nIngest report:', report);
  console.log('Index:', await repo.stats());
} finally {
  await pool.end();
}
