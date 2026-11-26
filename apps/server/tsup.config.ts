import { defineConfig } from 'tsup';

// One self-contained ESM bundle. Workspace packages (@acme/contracts, TS source) are inlined;
// third-party deps stay external and are installed in the runtime image.
export default defineConfig({
  entry: ['src/main.ts', 'src/scripts/ingest.ts', 'src/scripts/eval-retrieval.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: true,
  noExternal: ['@acme/contracts'],
});
