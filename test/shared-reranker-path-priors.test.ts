import { describe, it, expect } from 'bun:test';
import { computePathPrior, rerankResults } from '../src/search/shared-reranker.js';
import type { NormalizedSearchResult } from '../src/search/normalized-result.js';

function mkResult(id: string, filePath: string): NormalizedSearchResult {
  return {
    id,
    filePath,
    score: 0.5,
    source: 'graph',
    symbolName: 'TokenCounter',
    symbolKind: 'class',
    content: 'token limits compression handling',
    rrfScore: 0.5,
  };
}

describe('shared-reranker path priors', () => {
  it('down-ranks test paths when query is implementation-oriented', () => {
    const query = 'token limits compression handling';
    const implPrior = computePathPrior('src/token-counter-factory.ts', query);
    const testPrior = computePathPrior('test/token-counter-factory.test.ts', query);
    expect(implPrior).toBeGreaterThan(testPrior);
  });

  it('down-ranks filename-based test indicators even without test directory', () => {
    const query = 'context compaction compression messages';
    const implPrior = computePathPrior('src/pi-compactor.ts', query);
    const testLikePrior = computePathPrior('orchestrator-integration-test.ts', query);
    expect(implPrior).toBeGreaterThan(testLikePrior);
  });

  it('does not down-rank tests when query explicitly targets tests', () => {
    const query = 'integration test compaction handling';
    const testPrior = computePathPrior('test/orchestrator-integration-test.ts', query);
    expect(testPrior).toBeGreaterThan(0.95);
  });

  it('boosts architecture files for exploration queries', async () => {
    const query = 'token limits compression handling';
    const results = [
      mkResult('impl', 'src/compaction/default-compactor.ts'),
      mkResult('factory', 'src/compaction/compactor-factory.ts'),
      mkResult('test', 'test/compaction/default-compactor.test.ts'),
    ];

    const reranked = await rerankResults(results, query, {
      method: 'heuristic',
      topK: 10,
      fallbackToHeuristic: true,
    });

    const topFile = reranked.results[0]?.filePath ?? '';
    expect(topFile.includes('factory') || topFile.includes('compactor')).toBe(true);
    const testRank = reranked.results.findIndex(r => r.filePath.includes('.test.'));
    expect(testRank).toBeGreaterThan(0);
  });
});
