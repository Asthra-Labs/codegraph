import { describe, it, expect } from 'bun:test';
import {
  processQuery,
  extractIdentifiers,
  DEFAULT_PROCESSING_OPTIONS,
  type QueryProcessingOptions,
} from '../src/search/query-processor.js';

describe('QueryProcessor', () => {
  describe('extractIdentifiers', () => {
    it('should extract camelCase identifiers', () => {
      const identifiers = extractIdentifiers('getUserById');
      expect(identifiers).toContain('getUserById');
    });

    it('should extract PascalCase identifiers', () => {
      const identifiers = extractIdentifiers('UserServiceFactory');
      expect(identifiers).toContain('UserServiceFactory');
    });

    it('should extract snake_case identifiers', () => {
      const identifiers = extractIdentifiers('user_service_handler');
      expect(identifiers).toContain('user_service_handler');
    });

    it('should extract SCREAMING_SNAKE_CASE constants', () => {
      const identifiers = extractIdentifiers('MAX_RETRY_COUNT');
      expect(identifiers).toContain('MAX_RETRY_COUNT');
    });

    it('should extract multiple identifiers from a query', () => {
      const identifiers = extractIdentifiers('find getUserById and UserServiceFactory');
      expect(identifiers.length).toBeGreaterThanOrEqual(2);
      expect(identifiers).toContain('getUserById');
      expect(identifiers).toContain('UserServiceFactory');
    });
  });

  describe('processQuery', () => {
    describe('identifier extraction', () => {
      it('should extract camelCase and expand it', () => {
        const result = processQuery('getUserById', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.identifiers).toContain('getUserById');
        expect(result.expandedTerms).toContain('get');
        expect(result.expandedTerms).toContain('user');
        expect(result.expandedTerms).toContain('by');
        expect(result.expandedTerms).toContain('id');
      });

      it('should extract snake_case and expand it', () => {
        const result = processQuery('user_service_handler', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.identifiers).toContain('user_service_handler');
        expect(result.expandedTerms).toContain('user');
        expect(result.expandedTerms).toContain('service');
        expect(result.expandedTerms).toContain('handler');
      });

      it('should extract kebab-case and expand it', () => {
        const result = processQuery('user-service-handler', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.expandedTerms).toContain('user');
        expect(result.expandedTerms).toContain('service');
        expect(result.expandedTerms).toContain('handler');
      });
    });

    describe('path extraction', () => {
      it('should extract Unix-style paths', () => {
        const result = processQuery('src/components/Button.tsx', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.paths.length).toBeGreaterThan(0);
      });

      it('should extract module paths', () => {
        const result = processQuery('lodash/map', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.paths.length).toBeGreaterThan(0);
      });
    });

    describe('intent detection', () => {
      it('should detect exact symbol lookup for single identifier', () => {
        const result = processQuery('getUserById', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.intent).toBe('exact_symbol');
        expect(result.routingHints.preferExactMatch).toBe(true);
        expect(result.routingHints.weightBoost.fts).toBeGreaterThan(1);
      });

      it('should detect definition intent', () => {
        const result = processQuery('class UserService definition', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.intent).toBe('definition');
        expect(result.routingHints.includeRelated).toBe(true);
      });

      it('should detect usage intent for caller queries', () => {
        const result = processQuery('who calls getUserById', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.intent).toBe('usage');
        expect(result.routingHints.includeCallers).toBe(true);
        expect(result.routingHints.weightBoost.graph).toBeGreaterThan(1);
      });

      it('should detect usage intent for reference queries', () => {
        const result = processQuery('where is UserService used', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.intent).toBe('usage');
      });

      it('should detect navigation intent', () => {
        const result = processQuery('go to AuthService', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.intent).toBe('navigation');
      });

      it('should detect semantic intent', () => {
        const result = processQuery('how do I authenticate a user', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.intent).toBe('semantic');
        expect(result.routingHints.preferVectorSearch).toBe(true);
        expect(result.routingHints.weightBoost.vector).toBeGreaterThan(1);
      });

      it('should default to hybrid for ambiguous queries', () => {
        const result = processQuery('user authentication', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.intent).toBe('hybrid');
      });
    });

    describe('normalization', () => {
      it('should preserve exact identifiers when option is set', () => {
        const options: QueryProcessingOptions = {
          ...DEFAULT_PROCESSING_OPTIONS,
          preserveExactIdentifiers: true,
        };
        
        const result = processQuery('getUserById', options);
        
        expect(result.normalized).toContain('getUserById');
      });

      it('should expand identifiers when preservation is disabled', () => {
        const options: QueryProcessingOptions = {
          ...DEFAULT_PROCESSING_OPTIONS,
          preserveExactIdentifiers: false,
        };
        
        const result = processQuery('getUserById', options);
        
        expect(result.expandedTerms).toContain('get');
        expect(result.expandedTerms).toContain('user');
      });

      it('should expand identifiers without destroying original terms', () => {
        const result = processQuery('UserService', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.identifiers).toContain('UserService');
        expect(result.expandedTerms).toContain('user');
        expect(result.expandedTerms).toContain('service');
      });
    });

    describe('routing hints', () => {
      it('should boost FTS for exact symbol queries', () => {
        const result = processQuery('getUserById', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.routingHints.weightBoost.fts).toBeGreaterThan(1);
        expect(result.routingHints.weightBoost.vector).toBeLessThan(1);
      });

      it('should boost vector for semantic queries', () => {
        const result = processQuery('how to implement auth', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.routingHints.weightBoost.vector).toBeGreaterThan(1);
      });

      it('should boost graph for usage queries', () => {
        const result = processQuery('who calls processPayment', DEFAULT_PROCESSING_OPTIONS);
        
        expect(result.routingHints.weightBoost.graph).toBeGreaterThan(1);
        expect(result.routingHints.includeCallers).toBe(true);
      });
    });
  });

  describe('edge cases', () => {
    it('should handle empty query', () => {
      const result = processQuery('', DEFAULT_PROCESSING_OPTIONS);
      
      expect(result.original).toBe('');
      expect(result.identifiers.length).toBe(0);
    });

    it('should handle whitespace-only query', () => {
      const result = processQuery('   ', DEFAULT_PROCESSING_OPTIONS);
      
      expect(result.original).toBe('');
    });

    it('should handle mixed case identifiers', () => {
      const result = processQuery('getHTTPResponse', DEFAULT_PROCESSING_OPTIONS);
      
      expect(result.identifiers).toContain('getHTTPResponse');
      expect(result.expandedTerms).toContain('get');
      expect(result.expandedTerms).toContain('http');
      expect(result.expandedTerms).toContain('response');
    });

    it('should handle identifiers with numbers', () => {
      const result = processQuery('getUser2FAStatus', DEFAULT_PROCESSING_OPTIONS);
      
      expect(result.identifiers).toContain('getUser2FAStatus');
    });
  });
});
