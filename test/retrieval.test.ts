import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { 
  createRetrievalTables,
  dropRetrievalTables,
  storeRetrievalDocument,
  storeRetrievalDocuments,
  ftsSearchRetrievalDocs,
  vectorSearchRetrievalDocs,
  getRetrievalDocsBySymbol,
  getRetrievalDocsByFile,
  deleteRetrievalDocsByFile,
  clearRetrievalDocs,
  type RetrievalDocument,
} from '../src/retrieval/document-store.js';
import { openDatabase, loadSqliteVec, type Database } from '../src/db.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Retrieval Document Store', () => {
  let db: Database;
  let dbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrieval-test-'));
    dbPath = path.join(tempDir, 'test.db');
    db = openDatabase(dbPath);
    loadSqliteVec(db);
    createRetrievalTables(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('table creation', () => {
    it('should create retrieval_documents table', () => {
      const result = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='retrieval_documents'
      `).get();
      expect(result).toBeDefined();
    });

    it('should create retrieval_documents_fts virtual table', () => {
      const result = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='retrieval_documents_fts'
      `).get();
      expect(result).toBeDefined();
    });
  });

  describe('storeRetrievalDocument', () => {
    it('should store a retrieval document', () => {
      const doc: RetrievalDocument = {
        id: 'symbol:/test/file.ts:myFunc',
        type: 'symbol',
        symbolId: 'function:/test/file.ts:myFunc',
        symbolName: 'myFunc',
        symbolKind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 10,
        content: 'function myFunc() { return 42; }',
        ftsText: 'myFunc function',
        embeddingText: 'Symbol: myFunc\nKind: function\n\nfunction myFunc() { return 42; }',
        signature: 'myFunc()',
        metadata: JSON.stringify({ tokenCount: 50 }),
      };

      storeRetrievalDocument(db, doc);

      const stored = db.prepare(`
        SELECT * FROM retrieval_documents WHERE id = ?
      `).get(doc.id) as Record<string, unknown>;
      
      expect(stored).toBeDefined();
      expect(stored.symbol_name).toBe('myFunc');
      expect(stored.symbol_kind).toBe('function');
    });

    it('should store document in FTS index', () => {
      const doc: RetrievalDocument = {
        id: 'symbol:/test/file.ts:myFunc',
        type: 'symbol',
        symbolName: 'myFunc',
        symbolKind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 10,
        content: 'function myFunc() { return 42; }',
        ftsText: 'myFunc function returns number',
        embeddingText: 'test',
        metadata: '{}',
      };

      storeRetrievalDocument(db, doc);

      const results = ftsSearchRetrievalDocs(db, 'myFunc', 10);
      expect(results.length).toBe(1);
      expect(results[0].symbolName).toBe('myFunc');
    });

    it('should store sub-chunks with parent relationship', () => {
      const parentDoc: RetrievalDocument = {
        id: 'symbol:/test/file.ts:largeFunc',
        type: 'symbol',
        symbolId: 'function:/test/file.ts:largeFunc',
        symbolName: 'largeFunc',
        symbolKind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 100,
        content: 'function largeFunc() { /* ... */ }',
        ftsText: 'largeFunc',
        embeddingText: 'test',
        metadata: '{}',
      };

      const subDoc: RetrievalDocument = {
        id: 'sub_chunk:/test/file.ts:largeFunc:0',
        type: 'sub_chunk',
        parentId: 'symbol:/test/file.ts:largeFunc',
        symbolId: 'function:/test/file.ts:largeFunc',
        symbolName: 'largeFunc',
        symbolKind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 50,
        content: 'function largeFunc() { /* first half */ }',
        ftsText: 'largeFunc',
        embeddingText: 'test',
        metadata: JSON.stringify({ chunkIndex: 0, totalChunks: 2 }),
      };

      storeRetrievalDocuments(db, [parentDoc, subDoc]);

      const stored = db.prepare(`
        SELECT * FROM retrieval_documents WHERE id = ?
      `).get(subDoc.id) as RetrievalDocument;
      
      expect(stored.parent_id).toBe(parentDoc.id);
    });
  });

  describe('ftsSearchRetrievalDocs', () => {
    beforeEach(() => {
      const docs: RetrievalDocument[] = [
        {
          id: 'symbol:/test/file.ts:fetchUser',
          type: 'symbol',
          symbolName: 'fetchUser',
          symbolKind: 'function',
          filePath: '/test/user.ts',
          startLine: 1,
          endLine: 10,
          content: 'async function fetchUser(id: string) { return db.query(id); }',
          ftsText: 'fetchUser async function database query user',
          embeddingText: 'test',
          signature: 'fetchUser(id: string)',
          metadata: '{}',
        },
        {
          id: 'symbol:/test/file.ts:fetchProduct',
          type: 'symbol',
          symbolName: 'fetchProduct',
          symbolKind: 'function',
          filePath: '/test/product.ts',
          startLine: 1,
          endLine: 10,
          content: 'async function fetchProduct(id: string) { return db.query(id); }',
          ftsText: 'fetchProduct async function database query product',
          embeddingText: 'test',
          signature: 'fetchProduct(id: string)',
          metadata: '{}',
        },
      ];
      storeRetrievalDocuments(db, docs);
    });

    it('should find documents by keyword', () => {
      const results = ftsSearchRetrievalDocs(db, 'fetchUser', 10);
      expect(results.length).toBe(1);
      expect(results[0].symbolName).toBe('fetchUser');
    });

    it('should return results with normalized scores', () => {
      const results = ftsSearchRetrievalDocs(db, 'fetchUser', 10);
      expect(results[0].score).toBeGreaterThanOrEqual(0);
      expect(results[0].score).toBeLessThanOrEqual(1);
    });

    it('should support multi-term queries', () => {
      const results = ftsSearchRetrievalDocs(db, 'async function', 10);
      expect(results.length).toBe(2);
    });

    it('should respect limit parameter', () => {
      const results = ftsSearchRetrievalDocs(db, 'function', 1);
      expect(results.length).toBe(1);
    });
  });

  describe('getRetrievalDocsBySymbol', () => {
    it('should return all chunks for a symbol', () => {
      const docs: RetrievalDocument[] = [
        {
          id: 'symbol:/test/file.ts:myFunc',
          type: 'symbol',
          symbolId: 'function:/test/file.ts:myFunc',
          symbolName: 'myFunc',
          symbolKind: 'function',
          filePath: '/test/file.ts',
          startLine: 1,
          endLine: 100,
          content: 'function myFunc() {}',
          ftsText: 'myFunc',
          embeddingText: 'test',
          metadata: '{}',
        },
        {
          id: 'sub_chunk:/test/file.ts:myFunc:0',
          type: 'sub_chunk',
          parentId: 'symbol:/test/file.ts:myFunc',
          symbolId: 'function:/test/file.ts:myFunc',
          symbolName: 'myFunc',
          symbolKind: 'function',
          filePath: '/test/file.ts',
          startLine: 1,
          endLine: 50,
          content: 'function myFunc() { /* part 1 */ }',
          ftsText: 'myFunc',
          embeddingText: 'test',
          metadata: '{}',
        },
      ];
      storeRetrievalDocuments(db, docs);

      const results = getRetrievalDocsBySymbol(db, 'function:/test/file.ts:myFunc');
      expect(results.length).toBe(2);
    });
  });

  describe('getRetrievalDocsByFile', () => {
    it('should return all documents for a file', () => {
      const docs: RetrievalDocument[] = [
        {
          id: 'symbol:/test/file.ts:func1',
          type: 'symbol',
          symbolName: 'func1',
          symbolKind: 'function',
          filePath: '/test/file.ts',
          startLine: 1,
          endLine: 10,
          content: 'function func1() {}',
          ftsText: 'func1',
          embeddingText: 'test',
          metadata: '{}',
        },
        {
          id: 'symbol:/test/file.ts:func2',
          type: 'symbol',
          symbolName: 'func2',
          symbolKind: 'function',
          filePath: '/test/file.ts',
          startLine: 11,
          endLine: 20,
          content: 'function func2() {}',
          ftsText: 'func2',
          embeddingText: 'test',
          metadata: '{}',
        },
      ];
      storeRetrievalDocuments(db, docs);

      const results = getRetrievalDocsByFile(db, '/test/file.ts');
      expect(results.length).toBe(2);
    });
  });

  describe('deleteRetrievalDocsByFile', () => {
    it('should delete all documents for a file', () => {
      const doc: RetrievalDocument = {
        id: 'symbol:/test/file.ts:myFunc',
        type: 'symbol',
        symbolName: 'myFunc',
        symbolKind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 10,
        content: 'function myFunc() {}',
        ftsText: 'myFunc',
        embeddingText: 'test',
        metadata: '{}',
      };
      storeRetrievalDocument(db, doc);

      deleteRetrievalDocsByFile(db, '/test/file.ts');

      const results = getRetrievalDocsByFile(db, '/test/file.ts');
      expect(results.length).toBe(0);
    });

    it('should delete from FTS index', () => {
      const doc: RetrievalDocument = {
        id: 'symbol:/test/file.ts:myFunc',
        type: 'symbol',
        symbolName: 'myFunc',
        symbolKind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 10,
        content: 'function myFunc() {}',
        ftsText: 'myFunc',
        embeddingText: 'test',
        metadata: '{}',
      };
      storeRetrievalDocument(db, doc);

      deleteRetrievalDocsByFile(db, '/test/file.ts');

      const ftsResults = ftsSearchRetrievalDocs(db, 'myFunc', 10);
      expect(ftsResults.length).toBe(0);
    });
  });

  describe('clearRetrievalDocs', () => {
    it('should clear all documents', () => {
      const docs: RetrievalDocument[] = [
        {
          id: 'symbol:/test/file1.ts:func1',
          type: 'symbol',
          symbolName: 'func1',
          symbolKind: 'function',
          filePath: '/test/file1.ts',
          startLine: 1,
          endLine: 10,
          content: 'function func1() {}',
          ftsText: 'func1',
          embeddingText: 'test',
          metadata: '{}',
        },
        {
          id: 'symbol:/test/file2.ts:func2',
          type: 'symbol',
          symbolName: 'func2',
          symbolKind: 'function',
          filePath: '/test/file2.ts',
          startLine: 1,
          endLine: 10,
          content: 'function func2() {}',
          ftsText: 'func2',
          embeddingText: 'test',
          metadata: '{}',
        },
      ];
      storeRetrievalDocuments(db, docs);

      clearRetrievalDocs(db);

      const count = db.prepare(`SELECT COUNT(*) as count FROM retrieval_documents`).get() as { count: number };
      expect(count.count).toBe(0);
    });
  });

  describe('vectorSearchRetrievalDocs', () => {
    it('should store and search embeddings', () => {
      const embedding = Array(768).fill(0).map((_, i) => Math.sin(i * 0.01));
      
      const doc: RetrievalDocument = {
        id: 'symbol:/test/file.ts:myFunc',
        type: 'symbol',
        symbolName: 'myFunc',
        symbolKind: 'function',
        filePath: '/test/file.ts',
        startLine: 1,
        endLine: 10,
        content: 'function myFunc() { return 42; }',
        ftsText: 'myFunc',
        embeddingText: 'test',
        metadata: '{}',
        embedding,
      };

      storeRetrievalDocument(db, doc);

      const results = vectorSearchRetrievalDocs(db, embedding, 10);
      expect(results.length).toBe(1);
      expect(results[0].docId).toBe(doc.id);
      expect(results[0].score).toBeGreaterThan(0.99);
      expect(results[0].source).toBe('vector');
    });

    it('should return results sorted by similarity', () => {
      const highEmb = Array(768).fill(0.1);
      const lowEmb = Array(768).fill(-0.1);
      const query = Array(768).fill(0.1);

      const docs: RetrievalDocument[] = [
        {
          id: 'symbol:/test/file.ts:high',
          type: 'symbol',
          symbolName: 'high',
          symbolKind: 'function',
          filePath: '/test/file.ts',
          startLine: 1,
          endLine: 10,
          content: 'function high() {}',
          ftsText: 'high',
          embeddingText: 'test',
          metadata: '{}',
          embedding: highEmb,
        },
        {
          id: 'symbol:/test/file.ts:low',
          type: 'symbol',
          symbolName: 'low',
          symbolKind: 'function',
          filePath: '/test/file.ts',
          startLine: 11,
          endLine: 20,
          content: 'function low() {}',
          ftsText: 'low',
          embeddingText: 'test',
          metadata: '{}',
          embedding: lowEmb,
        },
      ];

      storeRetrievalDocuments(db, docs);

      const results = vectorSearchRetrievalDocs(db, query, 10);
      expect(results.length).toBe(2);
      expect(results[0].symbolName).toBe('high');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });
  });
});
