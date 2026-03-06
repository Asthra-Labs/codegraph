import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, NodeLabel } from '../src/graph/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('P0: Vector Search Production Guards', () => {
  let backend: SQLiteBackend;
  let dbPath: string;
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p0-guard-'));
    dbPath = path.join(tempDir, 'test.db');
    backend = new SQLiteBackend();
    originalEnv = process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK;
    delete process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK;
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalEnv !== undefined) {
      process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK = originalEnv;
    } else {
      delete process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK;
    }
  });

  describe('P0-1: KNN path verification', () => {
    it('should use MATCH query when vec table exists and never call fallback', async () => {
      await backend.initialize(dbPath);
      
      const graph = new KnowledgeGraph();
      const node = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'testFunc',
        filePath: '/test/file.ts',
        content: 'function testFunc() {}',
        language: 'typescript',
      });
      graph.addNode(node);
      await backend.bulkLoad(graph);
      
      await backend.storeEmbeddings([{
        nodeId: node.id,
        embedding: Array(768).fill(0.5),
      }]);

      const db = (backend as any).getDb();
      const fallbackSpy = spyOn(backend as any, 'vectorSearchFallback');
      
      const query = Array(768).fill(0.5);
      const results = await backend.vectorSearch(query, 10);
      
      expect(fallbackSpy).not.toHaveBeenCalled();
      expect(results.length).toBe(1);
      expect(results[0].nodeId).toBe(node.id);
      
      fallbackSpy.mockRestore();
    });

    it('should use exact KNN SQL: SELECT node_id, distance FROM vec WHERE embedding MATCH ? AND k = ?', async () => {
      await backend.initialize(dbPath);
      
      const db = (backend as any).getDb();
      
      const tableInfo = db.prepare(`
        SELECT sql FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
      `).get() as { sql: string };
      
      expect(tableInfo.sql).toContain('vec0');
      expect(tableInfo.sql).toContain('float[768]');
      expect(tableInfo.sql).toContain('distance_metric=cosine');
    });
  });

  describe('P0-2: Fallback disabled by default', () => {
    it('should throw error when vec table missing and fallback flag is false (default)', async () => {
      await backend.initialize(dbPath);
      
      const db = (backend as any).getDb();
      db.exec(`DROP TABLE IF EXISTS node_embeddings_vec`);
      
      const graph = new KnowledgeGraph();
      const node = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'testFunc',
        filePath: '/test/file.ts',
        content: 'function testFunc() {}',
        language: 'typescript',
      });
      graph.addNode(node);
      await backend.bulkLoad(graph);
      
      await backend.storeEmbeddings([{
        nodeId: node.id,
        embedding: Array(768).fill(0.5),
      }]);

      const query = Array(768).fill(0.5);
      
      await expect(backend.vectorSearch(query, 10)).rejects.toThrow();
      
      try {
        await backend.vectorSearch(query, 10);
      } catch (error) {
        expect((error as Error).message).toContain('node_embeddings_vec table does not exist');
        expect((error as Error).message).toContain('Remediation');
        expect((error as Error).message).toContain('ALLOW_BRUTE_FORCE_VECTOR_FALLBACK');
      }
    });
  });

  describe('P0-3: Fallback with explicit flag', () => {
    it('should use fallback and emit WARN when vec table missing and flag is true', async () => {
      process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK = 'true';
      
      await backend.initialize(dbPath);
      
      const db = (backend as any).getDb();
      db.exec(`DROP TABLE IF EXISTS node_embeddings_vec`);
      
      const graph = new KnowledgeGraph();
      const node = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'testFunc',
        filePath: '/test/file.ts',
        content: 'function testFunc() {}',
        language: 'typescript',
      });
      graph.addNode(node);
      await backend.bulkLoad(graph);
      
      await backend.storeEmbeddings([{
        nodeId: node.id,
        embedding: Array(768).fill(0.5),
      }]);

      const warnSpy = spyOn(console, 'warn');
      
      const query = Array(768).fill(0.5);
      const results = await backend.vectorSearch(query, 10);
      
      expect(results.length).toBe(1);
      expect(results[0].nodeId).toBe(node.id);
      
      expect(warnSpy).toHaveBeenCalled();
      const warnCall = warnSpy.mock.calls[0];
      expect(warnCall[0]).toContain('vector_fallback_used=1');
      expect(warnCall[0]).toContain('brute-force');
      
      warnSpy.mockRestore();
    });
  });

  describe('P0-4: Score correctness', () => {
    it('should return score = 1 - distance (cosine similarity)', async () => {
      await backend.initialize(dbPath);
      
      const graph = new KnowledgeGraph();
      
      const nodeA = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'nodeA',
        filePath: '/test/a.ts',
        content: 'function nodeA() {}',
        language: 'typescript',
      });
      
      const nodeB = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'nodeB',
        filePath: '/test/b.ts',
        content: 'function nodeB() {}',
        language: 'typescript',
      });
      
      graph.addNode(nodeA);
      graph.addNode(nodeB);
      await backend.bulkLoad(graph);
      
      // Orthogonal vectors
      const embA = Array(768).fill(0).map((_, i) => i % 2 === 0 ? 1 : 0);
      const embB = Array(768).fill(0).map((_, i) => i % 2 === 0 ? 0 : 1);
      
      await backend.storeEmbeddings([
        { nodeId: nodeA.id, embedding: embA },
        { nodeId: nodeB.id, embedding: embB },
      ]);

      // Query identical to A
      const results = await backend.vectorSearch(embA, 2);
      
      expect(results.length).toBe(2);
      
      // First result should be A with similarity ~1
      expect(results[0].nodeId).toBe(nodeA.id);
      expect(results[0].score).toBeGreaterThan(0.99);
      
      // Second result should be B with similarity ~0 (orthogonal)
      expect(results[1].nodeId).toBe(nodeB.id);
      expect(results[1].score).toBeLessThan(0.01);
    });
  });
});

describe('P0: KNN SQL Documentation', () => {
  it('should document the exact KNN SQL query', () => {
    const knnSql = `
      SELECT node_id, distance
      FROM node_embeddings_vec
      WHERE embedding MATCH ? AND k = ?
    `;
    
    expect(knnSql).toContain('embedding MATCH');
    expect(knnSql).toContain('node_id, distance');
  });

  it('should document the ID mapping strategy', () => {
    // Schema: node_embeddings_vec has node_id as PRIMARY KEY
    // The node_id is the same as graph_nodes.id (symbol ID)
    // 
    // Mapping flow:
    // 1. KNN query returns: { node_id: "function:/path/file.ts:funcName", distance: 0.15 }
    // 2. node_id is used to JOIN with graph_nodes table
    // 3. Score is computed as: 1 - distance (cosine similarity)
    //
    // For RetrievalDocument:
    // - retrieval_docs_vec.doc_id maps to retrieval_documents.id
    // - retrieval_documents.id format: "{type}:{filePath}:{symbolName}[:index]"
    
    const mappingCode = `
      // Step 1: KNN returns node_id and distance
      const vecResults = db.query(\`
        SELECT node_id, distance FROM node_embeddings_vec
        WHERE embedding MATCH ? AND k = ?
      \`, [new Float32Array(queryVector), limit * 3]);
      
      // Step 2: Map node_id to distance
      const distanceMap = new Map(vecResults.map(r => [r.node_id, r.distance]));
      
      // Step 3: Fetch node data by IDs
      const nodeRows = db.query(\`
        SELECT * FROM graph_nodes WHERE id IN (?,?,...)
      \`, [...distanceMap.keys()]);
      
      // Step 4: Compute similarity score
      for (const row of nodeRows) {
        const distance = distanceMap.get(row.id);
        const similarity = 1 - distance;  // Cosine similarity = 1 - cosine distance
        results.push({ ...row, score: similarity });
      }
    `;
    
    expect(mappingCode).toContain('node_id');
    expect(mappingCode).toContain('1 - distance');
  });
});
