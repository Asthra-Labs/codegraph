import { describe, it, expect } from 'bun:test';
import {
  detectQueryType,
  getRerankMethodForQueryType,
  selectRerankMethod,
  DEFAULT_RERANK_POLICY,
} from '../src/search/query-type-detector.js';
import type { QueryType, DetectionConfidence, RerankPolicy } from '../src/search/query-type-detector.js';

describe('Query Type Detector', () => {
  describe('detectQueryType', () => {
    describe('exact_identifier detection', () => {
      it('should detect camelCase as exact_identifier with high confidence', () => {
        const result = detectQueryType('hybridSearch');
        expect(result.queryType).toBe('exact_identifier');
        expect(result.confidence).toBe('high');
        expect(result.reason).toContain('CamelCase');
      });

      it('should detect PascalCase as exact_identifier with high confidence', () => {
        const result = detectQueryType('TelemetryCollector');
        expect(result.queryType).toBe('exact_identifier');
        expect(result.confidence).toBe('high');
        expect(result.reason).toContain('PascalCase');
      });

      it('should detect snake_case as exact_identifier with high confidence', () => {
        const result = detectQueryType('normalize_results');
        expect(result.queryType).toBe('exact_identifier');
        expect(result.confidence).toBe('high');
        expect(result.reason).toContain('snake_case');
      });

      it('should detect SCREAMING_SNAKE_CASE as exact_identifier', () => {
        const result = detectQueryType('MAX_RESULTS');
        expect(result.queryType).toBe('exact_identifier');
        expect(result.confidence).toBe('high');
      });

      it('should detect path-like patterns as exact_identifier with medium confidence', () => {
        const result = detectQueryType('hybrid.ts');
        expect(result.queryType).toBe('exact_identifier');
        expect(result.confidence).toBe('medium');
      });

      it('should detect signature patterns as exact_identifier', () => {
        const result = detectQueryType('search(query: string)');
        expect(result.queryType).toBe('exact_identifier');
        expect(result.confidence).toBe('medium');
      });

      it('should NOT classify single lowercase word as exact_identifier', () => {
        const result = detectQueryType('search');
        expect(result.queryType).not.toBe('exact_identifier');
      });

      it('should NOT classify short PascalCase (like Api, Http) as exact_identifier', () => {
        const result = detectQueryType('Api');
        expect(result.queryType).not.toBe('exact_identifier');
      });
    });

    describe('bug_error detection', () => {
      it('should detect "error" as bug_error with high confidence', () => {
        const result = detectQueryType('error');
        expect(result.queryType).toBe('bug_error');
        expect(result.confidence).toBe('high');
        expect(result.reason).toContain('error keyword');
      });

      it('should detect "exception" as bug_error', () => {
        const result = detectQueryType('exception');
        expect(result.queryType).toBe('bug_error');
        expect(result.confidence).toBe('high');
      });

      it('should detect "crash" as bug_error', () => {
        const result = detectQueryType('crash');
        expect(result.queryType).toBe('bug_error');
        expect(result.confidence).toBe('high');
      });

      it('should detect "timeout" as bug_error', () => {
        const result = detectQueryType('timeout');
        expect(result.queryType).toBe('bug_error');
        expect(result.confidence).toBe('high');
      });

      it('should detect error phrases with medium confidence', () => {
        const result = detectQueryType('not working');
        expect(result.queryType).toBe('bug_error');
        expect(result.confidence).toBe('medium');
      });

      it('should detect "got an error" as bug_error', () => {
        const result = detectQueryType('got an error in search');
        expect(result.queryType).toBe('bug_error');
        expect(result.confidence).toBe('medium');
      });
    });

    describe('semantic detection', () => {
      it('should detect question-based queries as semantic', () => {
        const result = detectQueryType('how to implement authentication');
        expect(result.queryType).toBe('semantic');
        expect(result.confidence).toBe('medium');
      });

      it('should detect long queries as semantic with high confidence', () => {
        const result = detectQueryType('find all functions that process user authentication tokens');
        expect(result.queryType).toBe('semantic');
        expect(result.confidence).toBe('high');
        expect(result.reason).toContain('Long query');
      });

      it('should detect natural language patterns as semantic', () => {
        const result = detectQueryType('looking for the main entry point');
        expect(result.queryType).toBe('semantic');
        expect(result.confidence).toBe('high');
      });

      it('should detect action-based queries as semantic', () => {
        const result = detectQueryType('find the database connection');
        expect(result.queryType).toBe('semantic');
        expect(result.confidence).toBe('medium');
      });
    });

    describe('unknown detection', () => {
      it('should return unknown for empty query', () => {
        const result = detectQueryType('');
        expect(result.queryType).toBe('unknown');
        expect(result.confidence).toBe('low');
      });

      it('should return unknown for whitespace-only query', () => {
        const result = detectQueryType('   ');
        expect(result.queryType).toBe('unknown');
        expect(result.confidence).toBe('low');
      });

      it('should return unknown for ambiguous short queries', () => {
        const result = detectQueryType('x');
        expect(result.queryType).toBe('unknown');
        expect(result.confidence).toBe('low');
      });
    });

    describe('precedence', () => {
      it('should prioritize exact_identifier over bug_error for code patterns', () => {
        const result = detectQueryType('handleError');
        expect(result.queryType).toBe('exact_identifier');
      });

      it('should prioritize exact_identifier over semantic for code patterns in longer queries', () => {
        const result = detectQueryType('getUserById in auth module');
        expect(result.queryType).toBe('exact_identifier');
        expect(result.confidence).toBe('medium');
      });
    });
  });

  describe('getRerankMethodForQueryType', () => {
    it('should return heuristic for exact_identifier', () => {
      expect(getRerankMethodForQueryType('exact_identifier')).toBe('heuristic');
    });

    it('should return model for semantic', () => {
      expect(getRerankMethodForQueryType('semantic')).toBe('model');
    });

    it('should return heuristic for bug_error', () => {
      expect(getRerankMethodForQueryType('bug_error')).toBe('heuristic');
    });

    it('should return heuristic for unknown', () => {
      expect(getRerankMethodForQueryType('unknown')).toBe('heuristic');
    });

    it('should respect custom policy', () => {
      const customPolicy: RerankPolicy = {
        exact_identifier: 'none',
        semantic: 'heuristic',
        bug_error: 'none',
        unknown: 'none',
      };
      expect(getRerankMethodForQueryType('semantic', customPolicy)).toBe('heuristic');
      expect(getRerankMethodForQueryType('exact_identifier', customPolicy)).toBe('none');
    });
  });

  describe('selectRerankMethod', () => {
    it('should respect explicit method override', () => {
      const result = selectRerankMethod('how to search', 'model');
      expect(result.selectedMethod).toBe('model');
      expect(result.confidence).toBe('high');
      expect(result.reason).toContain('Explicit');
    });

    it('should auto-detect when method is auto', () => {
      const result = selectRerankMethod('hybridSearch', 'auto');
      expect(result.selectedMethod).toBe('heuristic');
      expect(result.queryType).toBe('exact_identifier');
    });

    it('should auto-detect semantic query and select model', () => {
      const result = selectRerankMethod('how to implement authentication', 'auto');
      expect(result.selectedMethod).toBe('model');
      expect(result.queryType).toBe('semantic');
    });

    it('should auto-detect bug_error query and select heuristic', () => {
      const result = selectRerankMethod('timeout in search', 'auto');
      expect(result.selectedMethod).toBe('heuristic');
      expect(result.queryType).toBe('bug_error');
    });

    it('should use default method when no explicit method given', () => {
      const result = selectRerankMethod('search');
      expect(result.selectedMethod).toBeDefined();
    });

    it('should respect custom policy when auto-detecting', () => {
      const customPolicy: RerankPolicy = {
        exact_identifier: 'model',
        semantic: 'model',
        bug_error: 'model',
        unknown: 'model',
      };
      const result = selectRerankMethod('handleError', 'auto', customPolicy);
      expect(result.selectedMethod).toBe('model');
    });
  });

  describe('DEFAULT_RERANK_POLICY', () => {
    it('should have correct policy based on evaluation results', () => {
      expect(DEFAULT_RERANK_POLICY.exact_identifier).toBe('heuristic');
      expect(DEFAULT_RERANK_POLICY.semantic).toBe('model');
      expect(DEFAULT_RERANK_POLICY.bug_error).toBe('heuristic');
      expect(DEFAULT_RERANK_POLICY.unknown).toBe('heuristic');
    });
  });
});
