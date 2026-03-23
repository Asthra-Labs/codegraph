/**
 * Pipeline benchmark test — verifies parallel parsing works and measures timing.
 * Run: npx vitest run --reporter=verbose test/pipeline-benchmark.test.ts
 */

import { describe, it, expect } from 'vitest';
import { IngestionPipeline } from '../src/ingestion/pipeline.js';
import * as path from 'path';

describe('Pipeline Benchmark', () => {
  it('should parse codegraph/src with parallel pipeline (no embeddings)', async () => {
    const repoPath = path.resolve(__dirname, '../src');
    const phases: Record<string, number> = {};

    const pipeline = new IngestionPipeline({
      generateEmbeddings: false,
      detectDeadCode: true,
      onProgress: (phase: string, progress: number, message?: string) => {
        if (progress === 0 && !phases[`${phase}_start`]) {
          phases[`${phase}_start`] = Date.now();
        }
        if (progress >= 1 && !phases[`${phase}_end`]) {
          phases[`${phase}_end`] = Date.now();
        }
      },
    });

    const start = Date.now();
    const { result } = await pipeline.run(repoPath);
    const total = Date.now() - start;

    console.log('\n=== Pipeline Benchmark Results ===');
    console.log(`Repo: codegraph/src (${result.filesProcessed} files)`);
    console.log(`Symbols: ${result.symbolsExtracted}`);
    console.log(`Relationships: ${result.relationshipsCreated}`);
    console.log(`Errors: ${result.errors.length}`);
    console.log(`Total: ${total}ms (${(total / 1000).toFixed(1)}s)`);

    // Show phase timings
    const phaseNames = ['discovery', 'structure', 'parsing', 'imports', 'calls', 'heritage', 'types', 'deadcode'];
    for (const phase of phaseNames) {
      const s = phases[`${phase}_start`];
      const e = phases[`${phase}_end`];
      if (s && e) {
        console.log(`  ${phase}: ${e - s}ms`);
      }
    }
    console.log('');

    // Verify pipeline produced correct results
    expect(result.filesProcessed).toBeGreaterThan(10);
    expect(result.symbolsExtracted).toBeGreaterThan(50);
    expect(result.relationshipsCreated).toBeGreaterThan(0);
    expect(result.errors.length).toBeLessThan(result.filesProcessed); // Most files should parse OK
    expect(total).toBeLessThan(60000); // Should complete in under 60s for src/
  }, 120000);

  it('should not crash with this.stats bug (community/process/coupling)', async () => {
    const repoPath = path.resolve(__dirname, '../src');

    const pipeline = new IngestionPipeline({
      generateEmbeddings: false,
      detectDeadCode: true,
      detectCommunities: true,
      detectProcesses: true,
      detectChangeCoupling: true,
      repoPath,
    });

    // This used to crash with "Cannot read property 'relationshipsCreated' of undefined"
    const { result } = await pipeline.run(repoPath);
    expect(result.filesProcessed).toBeGreaterThan(0);
  }, 120000);
});
