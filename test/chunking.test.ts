import { describe, it, expect } from 'bun:test';
import { Chunker, createChunker } from '../src/chunking/chunker.js';
import { DEFAULT_CHUNKING_CONFIG, estimateTokenCount } from '../src/chunking/types.js';
import type { ParseResult, SymbolInfo, ImportInfo, RelationshipInfo } from '../src/parsers/base.js';

function createMockParseResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    symbols: [],
    imports: [],
    relationships: [],
    exports: [],
    language: 'typescript',
    ...overrides,
  };
}

function createMockSymbol(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  return {
    id: 'function:/test/file.ts:testFunc',
    name: 'testFunc',
    kind: 'function',
    filePath: '/test/file.ts',
    startLine: 1,
    endLine: 10,
    content: 'function testFunc() { return 42; }',
    signature: 'testFunc()',
    ...overrides,
  };
}

describe('Chunker', () => {
  describe('small symbols', () => {
    it('should keep small symbols as single chunks', () => {
      const chunker = createChunker();
      const symbol = createMockSymbol({
        content: 'function testFunc() { return 42; }',
      });
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol] }),
        symbol.content
      );

      const symbolChunks = result.filter(c => c.symbolId === symbol.id);
      expect(symbolChunks.length).toBe(1);
      expect(symbolChunks[0].type).toBe('symbol');
    });

    it('should not split symbols under maxChunkTokens', () => {
      const chunker = createChunker({ maxChunkTokens: 1000 });
      const symbol = createMockSymbol({
        content: 'function testFunc() { return 42; }',
      });
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol] }),
        symbol.content
      );

      const symbolChunks = result.filter(c => c.symbolId === symbol.id);
      expect(symbolChunks.length).toBe(1);
      expect(symbolChunks[0].type).toBe('symbol');
    });
  });

  describe('large symbol splitting', () => {
    it('should split large symbols into multiple sub-chunks', () => {
      const chunker = createChunker({ maxChunkTokens: 50, overlapTokens: 10 });
      
      const largeContent = Array(50).fill('const x = 1;').join('\n');
      const symbol = createMockSymbol({
        content: `function largeFunc() {\n${largeContent}\n}`,
        startLine: 1,
        endLine: 52,
      });
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol] }),
        symbol.content
      );

      const symbolChunks = result.filter(c => c.symbolId === symbol.id);
      expect(symbolChunks.length).toBeGreaterThan(1);
      
      const subChunks = symbolChunks.filter(c => c.type === 'sub_chunk');
      expect(subChunks.length).toBeGreaterThan(1);
    });

    it('should preserve parent-child relationships in sub-chunks', () => {
      const chunker = createChunker({ maxChunkTokens: 50, overlapTokens: 10 });
      
      const largeContent = Array(50).fill('const x = 1;').join('\n');
      const symbol = createMockSymbol({
        content: `function largeFunc() {\n${largeContent}\n}`,
      });
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol] }),
        symbol.content
      );

      const subChunks = result.filter(c => c.type === 'sub_chunk');
      for (const chunk of subChunks) {
        expect(chunk.parentId).toBe(symbol.id);
        expect(chunk.symbolId).toBe(symbol.id);
      }
    });

    it('should include overlap between consecutive chunks', () => {
      const chunker = createChunker({ maxChunkTokens: 50, overlapTokens: 20 });
      
      const largeContent = Array(50).fill('const x = 1;').join('\n');
      const symbol = createMockSymbol({
        content: `function largeFunc() {\n${largeContent}\n}`,
      });
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol] }),
        symbol.content
      );

      const subChunks = result.filter(c => c.type === 'sub_chunk');
      
      if (subChunks.length > 1) {
        const overlapMetadata = subChunks.filter(c => c.metadata?.overlapTokens);
        expect(overlapMetadata.length).toBeGreaterThan(0);
      }
    });

    it('should track chunk index and total chunks', () => {
      const chunker = createChunker({ maxChunkTokens: 50, overlapTokens: 10 });
      
      const largeContent = Array(50).fill('const x = 1;').join('\n');
      const symbol = createMockSymbol({
        content: `function largeFunc() {\n${largeContent}\n}`,
      });
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol] }),
        symbol.content
      );

      const subChunks = result.filter(c => c.type === 'sub_chunk');
      
      for (let i = 0; i < subChunks.length; i++) {
        expect(subChunks[i].metadata?.chunkIndex).toBe(i);
        expect(subChunks[i].metadata?.totalChunks).toBe(subChunks.length);
      }
    });
  });

  describe('file context chunks', () => {
    it('should create import context chunks', () => {
      const chunker = createChunker({ includeFileContext: true });
      const symbol = createMockSymbol();
      const imports: ImportInfo[] = [
        { module: 'lodash', names: ['map', 'filter'], isRelative: false },
        { module: './utils', names: ['helper'], isRelative: true },
      ];
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol], imports }),
        symbol.content
      );

      const importChunks = result.filter(c => c.type === 'file_context' && c.metadata?.contextType === 'imports');
      expect(importChunks.length).toBe(1);
      expect(importChunks[0].symbolName).toBe('_imports');
    });

    it('should create export context chunks', () => {
      const chunker = createChunker({ includeFileContext: true });
      const symbol = createMockSymbol();
      
      const result = chunker.chunk(
        createMockParseResult({ 
          symbols: [symbol], 
          exports: ['testFunc', 'AnotherClass'] 
        }),
        symbol.content
      );

      const exportChunks = result.filter(c => c.type === 'file_context' && c.metadata?.contextType === 'exports');
      expect(exportChunks.length).toBe(1);
      expect(exportChunks[0].symbolName).toBe('_exports');
    });

    it('should not create file context chunks when disabled', () => {
      const chunker = createChunker({ includeFileContext: false });
      const symbol = createMockSymbol();
      const imports: ImportInfo[] = [
        { module: 'lodash', names: ['map'], isRelative: false },
      ];
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol], imports }),
        symbol.content
      );

      const fileContextChunks = result.filter(c => c.type === 'file_context');
      expect(fileContextChunks.length).toBe(0);
    });
  });

  describe('callsite chunks', () => {
    it('should create callsite chunks for function calls', () => {
      const chunker = createChunker({ includeCallsites: true });
      
      const callerSymbol = createMockSymbol({
        id: 'function:/test/file.ts:callerFunc',
        name: 'callerFunc',
        startLine: 1,
        endLine: 10,
        content: 'function callerFunc() { targetFunc(); }',
      });
      
      const targetSymbol = createMockSymbol({
        id: 'function:/test/file.ts:targetFunc',
        name: 'targetFunc',
        startLine: 11,
        endLine: 20,
        content: 'function targetFunc() {}',
      });
      
      const relationships: RelationshipInfo[] = [
        {
          type: 'calls',
          sourceId: 'call:/test/file.ts:3',
          target: 'targetFunc',
          confidence: 1.0,
          line: 3,
        },
      ];
      
      const result = chunker.chunk(
        createMockParseResult({ 
          symbols: [callerSymbol, targetSymbol], 
          relationships 
        }),
        `${callerSymbol.content}\n${targetSymbol.content}`
      );

      const callsiteChunks = result.filter(c => c.type === 'callsite');
      expect(callsiteChunks.length).toBe(1);
      expect(callsiteChunks[0].symbolName).toBe('targetFunc');
      expect(callsiteChunks[0].metadata?.callerSymbolName).toBe('callerFunc');
    });

    it('should limit callsites per symbol', () => {
      const chunker = createChunker({ 
        includeCallsites: true, 
        maxCallsitesPerSymbol: 2 
      });
      
      const callerSymbol = createMockSymbol({
        id: 'function:/test/file.ts:callerFunc',
        name: 'callerFunc',
        startLine: 1,
        endLine: 100,
        content: 'function callerFunc() { targetFunc(); }',
      });
      
      const targetSymbol = createMockSymbol({
        id: 'function:/test/file.ts:targetFunc',
        name: 'targetFunc',
        startLine: 101,
        endLine: 110,
        content: 'function targetFunc() {}',
      });
      
      const relationships: RelationshipInfo[] = [
        { type: 'calls', sourceId: 'call:1', target: 'targetFunc', confidence: 1.0, line: 5 },
        { type: 'calls', sourceId: 'call:2', target: 'targetFunc', confidence: 1.0, line: 10 },
        { type: 'calls', sourceId: 'call:3', target: 'targetFunc', confidence: 1.0, line: 15 },
        { type: 'calls', sourceId: 'call:4', target: 'targetFunc', confidence: 1.0, line: 20 },
      ];
      
      const result = chunker.chunk(
        createMockParseResult({ 
          symbols: [callerSymbol, targetSymbol], 
          relationships 
        }),
        `${callerSymbol.content}\n${targetSymbol.content}`
      );

      const callsiteChunks = result.filter(c => c.type === 'callsite');
      expect(callsiteChunks.length).toBe(2);
    });

    it('should not create callsite chunks when disabled', () => {
      const chunker = createChunker({ includeCallsites: false });
      
      const callerSymbol = createMockSymbol({
        id: 'function:/test/file.ts:callerFunc',
        name: 'callerFunc',
        startLine: 1,
        endLine: 10,
        content: 'function callerFunc() { targetFunc(); }',
      });
      
      const targetSymbol = createMockSymbol({
        id: 'function:/test/file.ts:targetFunc',
        name: 'targetFunc',
        startLine: 11,
        endLine: 20,
        content: 'function targetFunc() {}',
      });
      
      const relationships: RelationshipInfo[] = [
        { type: 'calls', sourceId: 'call:1', target: 'targetFunc', confidence: 1.0, line: 3 },
      ];
      
      const result = chunker.chunk(
        createMockParseResult({ 
          symbols: [callerSymbol, targetSymbol], 
          relationships 
        }),
        `${callerSymbol.content}\n${targetSymbol.content}`
      );

      const callsiteChunks = result.filter(c => c.type === 'callsite');
      expect(callsiteChunks.length).toBe(0);
    });
  });

  describe('ftsText and embeddingText', () => {
    it('should generate meaningful ftsText for symbols', () => {
      const chunker = createChunker();
      const symbol = createMockSymbol({
        name: 'myFunction',
        signature: 'myFunction(a: number, b: string): void',
        className: 'MyClass',
      });
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol] }),
        symbol.content
      );

      const chunk = result.find(c => c.symbolId === symbol.id);
      expect(chunk?.ftsText).toContain('myFunction');
      expect(chunk?.ftsText).toContain('MyClass');
    });

    it('should generate meaningful embeddingText with metadata', () => {
      const chunker = createChunker();
      const symbol = createMockSymbol({
        name: 'myFunction',
        kind: 'function',
        signature: 'myFunction(): void',
        isExported: true,
      });
      
      const result = chunker.chunk(
        createMockParseResult({ symbols: [symbol] }),
        symbol.content
      );

      const chunk = result.find(c => c.symbolId === symbol.id);
      expect(chunk?.embeddingText).toContain('Symbol: myFunction');
      expect(chunk?.embeddingText).toContain('Kind: function');
      expect(chunk?.embeddingText).toContain('Exported: true');
    });
  });
});

describe('estimateTokenCount', () => {
  it('should estimate tokens based on character count', () => {
    const shortText = 'hello world';
    const longText = 'a'.repeat(1000);
    
    const shortCount = estimateTokenCount(shortText);
    const longCount = estimateTokenCount(longText);
    
    expect(shortCount).toBeLessThan(longCount);
    expect(longCount).toBe(250);
  });
});
