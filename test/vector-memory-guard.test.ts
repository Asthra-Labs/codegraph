import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, NodeLabel } from '../src/graph/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Vector Search Memory Safety Guards', () => {
  let backend: SQLiteBackend;
  let dbPath: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-memory-guard-'));
    dbPath = path.join(tempDir, 'test.db');
    backend = new SQLiteBackend();
    await backend.initialize(dbPath);
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('KNN query path verification', () => {
    it('should use MATCH query, not brute-force iteration', async () => {
      const db = (backend as any).getDb();
      
      const plan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT node_id, distance
        FROM node_embeddings_vec
        WHERE embedding MATCH ? AND k = ?
      `).get(new Float32Array(768), 10);
      
      expect(plan).toBeDefined();
    });

    it('should have node_embeddings_vec virtual table after initialization', async () => {
      const db = (backend as any).getDb();
      
      const table = db.prepare(`
        SELECT name, sql FROM sqlite_master 
        WHERE type='table' AND name='node_embeddings_vec'
      `).get();
      
      expect(table).toBeDefined();
      expect(table.name).toBe('node_embeddings_vec');
      expect(table.sql).toContain('vec0');
      expect(table.sql).toContain('float[768]');
      expect(table.sql).toContain('distance_metric=cosine');
    });

    it('should NOT load all embeddings into memory for KNN search', async () => {
      const graph = new KnowledgeGraph();
      
      for (let i = 0; i < 100; i++) {
        const node = new GraphNode({
          label: NodeLabel.FUNCTION,
          name: `func${i}`,
          filePath: `/test/file${i}.ts`,
          content: `function func${i}() {}`,
          language: 'typescript',
        });
        graph.addNode(node);
      }
      await backend.bulkLoad(graph);

      const embeddings = graph.getAllNodes().map((node, i) => ({
        nodeId: node.id,
        embedding: Array(768).fill(0).map((_, j) => Math.sin(i + j * 0.01)),
      }));
      await backend.storeEmbeddings(embeddings);

      const db = (backend as any).getDb();
      
      const queryPlan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT node_id, distance
        FROM node_embeddings_vec
        WHERE embedding MATCH ? AND k = ?
      `).all(new Float32Array(768), 10);
      
      const planStr = JSON.stringify(queryPlan).toLowerCase();
      
      expect(planStr).not.toContain('scan');
      expect(planStr).not.toContain('iterate');
    });
  });

  describe('Memory footprint verification', () => {
    it('should not increase memory significantly for more embeddings', async () => {
      const graph = new KnowledgeGraph();
      
      for (let i = 0; i < 1000; i++) {
        const node = new GraphNode({
          label: NodeLabel.FUNCTION,
          name: `func${i}`,
          filePath: `/test/file${Math.floor(i / 100)}.ts`,
          content: `function func${i}() { return ${i}; }`,
          language: 'typescript',
        });
        graph.addNode(node);
      }
      await backend.bulkLoad(graph);

      const embeddings = graph.getAllNodes().map((node, i) => ({
        nodeId: node.id,
        embedding: Array(768).fill(0).map((_, j) => Math.sin(i + j * 0.01)),
      }));
      await backend.storeEmbeddings(embeddings);

      const heapBefore = process.memoryUsage().heapUsed;
      
      const query = Array(768).fill(0).map((_, i) => Math.sin(i * 0.01));
      const results = await backend.vectorSearch(query, 10);
      
      const heapAfter = process.memoryUsage().heapUsed;
      const heapIncrease = heapAfter - heapBefore;
      
      expect(results.length).toBe(10);
      
      expect(heapIncrease).toBeLessThan(10 * 1024 * 1024);
    });
  });

  describe('Brute-force fallback guard', () => {
    it('should still work when fallback is triggered (graceful degradation)', async () => {
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
      const results = await backend.vectorSearch(query, 10);
      
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].nodeId).toBe(node.id);
    });

    it('should prefer KNN path when virtual table exists', async () => {
      const db = (backend as any).getDb();
      
      const tableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
      `).get();
      
      expect(tableExists).toBeDefined();
      
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

      const results = await backend.vectorSearch(Array(768).fill(0.5), 10);
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Correctness verification', () => {
    it('should return results with correct cosine similarity scores', async () => {
      const graph = new KnowledgeGraph();
      
      const nodeA = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'functionA',
        filePath: '/test/a.ts',
        content: 'function functionA() {}',
        language: 'typescript',
      });
      
      const nodeB = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'functionB',
        filePath: '/test/b.ts',
        content: 'function functionB() {}',
        language: 'typescript',
      });
      
      graph.addNode(nodeA);
      graph.addNode(nodeB);
      await backend.bulkLoad(graph);

      const embA = Array(768).fill(0).map((_, i) => i % 2 === 0 ? 0.5 : -0.5);
      const embB = Array(768).fill(0).map((_, i) => i % 2 === 0 ? -0.5 : 0.5);
      
      await backend.storeEmbeddings([
        { nodeId: nodeA.id, embedding: embA },
        { nodeId: nodeB.id, embedding: embB },
      ]);

      const results = await backend.vectorSearch(embA, 2);
      
      expect(results.length).toBe(2);
      
      expect(results[0].nodeId).toBe(nodeA.id);
      expect(results[0].score).toBeGreaterThan(0.99);
      
      expect(results[1].nodeId).toBe(nodeB.id);
      expect(results[1].score).toBeLessThan(0);
    });

    it('should correctly compute score as 1 - distance', async () => {
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
      
      const embedding = Array(768).fill(0.1);
      await backend.storeEmbeddings([{ nodeId: node.id, embedding }]);
      
      const results = await backend.vectorSearch(embedding, 1);
      
      expect(results[0].score).toBeGreaterThan(0.99);
      expect(results[0].score).toBeLessThanOrEqual(1.0);
    });
  });
});
