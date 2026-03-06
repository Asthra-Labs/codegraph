import { describe, it, expect } from 'bun:test';
import {
  simpleRerank,
  rerankResults,
  createRerankInput,
  createRerankInputs,
  DEFAULT_RERANKER_OPTIONS,
  type RerankInput,
  type RerankerOptions,
} from '../src/search/reranker.js';
import type { UnifiedSearchResult } from '../src/search/unified-search.js';

function createMockResult(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
  return {
    id: 'symbol:/test/file.ts:testFunc',
    type: 'symbol',
    source: 'graph',
    symbolName: 'testFunc',
    symbolKind: 'function',
    filePath: '/test/file.ts',
    startLine: 1,
    endLine: 10,
    content: 'function testFunc() { return 42; }',
    score: 0.9,
    rrfScore: 0.016,
    metadata: {},
    ...overrides,
  };
}

describe('Reranker', () => {
  describe('createRerankInput', () => {
    it('should convert UnifiedSearchResult to RerankInput', () => {
      const result = createMockResult({
        signature: 'testFunc(): number',
        className: 'TestClass',
      });

      const input = createRerankInput(result);

      expect(input.id).toBe(result.id);
      expect(input.symbolName).toBe(result.symbolName);
      expect(input.symbolKind).toBe(result.symbolKind);
      expect(input.filePath).toBe(result.filePath);
      expect(input.signature).toBe(result.signature);
      expect(input.className).toBe(result.className);
      expect(input.content).toBe(result.content);
    });
  });

  describe('createRerankInputs', () => {
    it('should convert multiple results', () => {
      const results = [
        createMockResult({ id: 'func1', symbolName: 'func1' }),
        createMockResult({ id: 'func2', symbolName: 'func2' }),
      ];

      const inputs = createRerankInputs(results);

      expect(inputs.length).toBe(2);
      expect(inputs[0].id).toBe('func1');
      expect(inputs[1].id).toBe('func2');
    });
  });

  describe('simpleRerank', () => {
    it('should return identity scores when disabled', () => {
      const inputs: RerankInput[] = [
        { id: 'a', symbolName: 'funcA', symbolKind: 'function', filePath: '/a.ts', content: '', metadata: {} },
        { id: 'b', symbolName: 'funcB', symbolKind: 'function', filePath: '/b.ts', content: '', metadata: {} },
      ];

      const results = simpleRerank(inputs, 'query', { ...DEFAULT_RERANKER_OPTIONS, enabled: false });

      expect(results.length).toBe(2);
      expect(results[0].originalRank).toBe(0);
      expect(results[1].originalRank).toBe(1);
    });

    it('should boost exact symbol name matches', () => {
      const inputs: RerankInput[] = [
        { id: 'a', symbolName: 'otherFunc', symbolKind: 'function', filePath: '/a.ts', content: '', metadata: {} },
        { id: 'b', symbolName: 'myTargetFunc', symbolKind: 'function', filePath: '/b.ts', content: '', metadata: {} },
      ];

      const results = simpleRerank(inputs, 'myTargetFunc', DEFAULT_RERANKER_OPTIONS);

      expect(results[0].id).toBe('b');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('should boost partial symbol name matches', () => {
      const inputs: RerankInput[] = [
        { id: 'a', symbolName: 'unrelatedFunc', symbolKind: 'function', filePath: '/a.ts', content: '', metadata: {} },
        { id: 'b', symbolName: 'getUserById', symbolKind: 'function', filePath: '/b.ts', content: '', metadata: {} },
      ];

      const results = simpleRerank(inputs, 'User', DEFAULT_RERANKER_OPTIONS);

      expect(results[0].id).toBe('b');
    });

    it('should consider signature matches', () => {
      const inputs: RerankInput[] = [
        { id: 'a', symbolName: 'func', symbolKind: 'function', filePath: '/a.ts', content: '', signature: 'func(name: string)', metadata: {} },
        { id: 'b', symbolName: 'func', symbolKind: 'function', filePath: '/b.ts', content: '', signature: 'func(id: number)', metadata: {} },
      ];

      const results = simpleRerank(inputs, 'name', DEFAULT_RERANKER_OPTIONS);

      expect(results[0].id).toBe('a');
    });

    it('should consider file path relevance', () => {
      const inputs: RerankInput[] = [
        { id: 'a', symbolName: 'handler', symbolKind: 'function', filePath: '/src/utils/common.ts', content: '', metadata: {} },
        { id: 'b', symbolName: 'handler', symbolKind: 'function', filePath: '/src/auth/AuthHandler.ts', content: '', metadata: {} },
      ];

      const results = simpleRerank(inputs, 'auth', DEFAULT_RERANKER_OPTIONS);

      expect(results[0].id).toBe('b');
    });

    it('should consider class name matches', () => {
      const inputs: RerankInput[] = [
        { id: 'a', symbolName: 'process', symbolKind: 'method', filePath: '/a.ts', content: '', className: 'DataProcessor', metadata: {} },
        { id: 'b', symbolName: 'process', symbolKind: 'method', filePath: '/b.ts', content: '', className: 'FileHandler', metadata: {} },
      ];

      const results = simpleRerank(inputs, 'Data', DEFAULT_RERANKER_OPTIONS);

      expect(results[0].id).toBe('a');
    });

    it('should consider content matches', () => {
      const inputs: RerankInput[] = [
        { id: 'a', symbolName: 'func', symbolKind: 'function', filePath: '/a.ts', content: 'function func() { return null; }', metadata: {} },
        { id: 'b', symbolName: 'func', symbolKind: 'function', filePath: '/b.ts', content: 'function func() { authenticate(); return user; }', metadata: {} },
      ];

      const results = simpleRerank(inputs, 'authenticate', DEFAULT_RERANKER_OPTIONS);

      expect(results[0].id).toBe('b');
    });
  });

  describe('rerankResults', () => {
    it('should preserve order when disabled', () => {
      const results = [
        createMockResult({ id: 'a', symbolName: 'a' }),
        createMockResult({ id: 'b', symbolName: 'b' }),
      ];

      const reranked = rerankResults(results, 'query', { ...DEFAULT_RERANKER_OPTIONS, enabled: false });

      expect(reranked[0].id).toBe('a');
      expect(reranked[1].id).toBe('b');
    });

    it('should only rerank top K results', () => {
      const results = [];
      for (let i = 0; i < 50; i++) {
        results.push(createMockResult({ id: `func${i}`, symbolName: `func${i}` }));
      }

      const options: RerankerOptions = { ...DEFAULT_RERANKER_OPTIONS, topK: 10 };
      const reranked = rerankResults(results, 'func25', options);

      expect(reranked.length).toBe(50);

      const top10 = reranked.slice(0, 10);
      const hasReranked = top10.some(r => r.metadata?.reranked === true);
      expect(hasReranked).toBe(true);

      const remaining = reranked.slice(10);
      const remainingHasReranked = remaining.some(r => r.metadata?.reranked === true);
      expect(remainingHasReranked).toBe(false);
    });

    it('should mark reranked results with metadata', () => {
      const results = [
        createMockResult({ id: 'a', symbolName: 'targetFunc' }),
        createMockResult({ id: 'b', symbolName: 'otherFunc' }),
      ];

      const reranked = rerankResults(results, 'targetFunc', DEFAULT_RERANKER_OPTIONS);

      expect(reranked[0].metadata?.reranked).toBe(true);
      expect(reranked[0].metadata?.originalRank).toBeDefined();
    });

    it('should reorder results based on rerank scores', () => {
      const results = [
        createMockResult({ id: 'a', symbolName: 'unrelatedFunc', score: 0.95 }),
        createMockResult({ id: 'b', symbolName: 'targetFunc', score: 0.80 }),
      ];

      const reranked = rerankResults(results, 'targetFunc', DEFAULT_RERANKER_OPTIONS);

      expect(reranked[0].id).toBe('b');
      expect(reranked[0].score).toBeGreaterThan(0);
    });
  });
});
