import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, NodeLabel } from '../src/graph/index.js';
import type { NodeEmbedding } from '../src/graph/storage-backend.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Vector Search KNN Implementation', () => {
  let backend: SQLiteBackend;
  let dbPath: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-vec-test-'));
    dbPath = path.join(tempDir, 'test.db');
    backend = new SQLiteBackend();
    await backend.initialize(dbPath);
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should store embeddings in both raw and virtual tables', async () => {
    const graph = new KnowledgeGraph();
    const node = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'myFunc',
      filePath: '/test/file.ts',
      content: 'function myFunc() {}',
      language: 'typescript',
    });
    graph.addNode(node);
    await backend.bulkLoad(graph);

    const embedding: number[] = Array(768).fill(0).map((_, i) => i / 768);
    await backend.storeEmbeddings([{
      nodeId: node.id,
      embedding,
    }]);

    const rawResult = await backend.getNode(node.id);
    expect(rawResult).toBeDefined();

    const results = await backend.vectorSearch(embedding, 1);
    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe(node.id);
  });

  it('should perform KNN vector search using virtual table', async () => {
    const graph = new KnowledgeGraph();
    
    for (let i = 0; i < 5; i++) {
      const node = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: `func${i}`,
        filePath: '/test/file.ts',
        content: `function func${i}() {}`,
        language: 'typescript',
      });
      graph.addNode(node);
    }
    await backend.bulkLoad(graph);

    const embeddings: NodeEmbedding[] = [];
    const nodes = graph.getAllNodes();
    for (let i = 0; i < nodes.length; i++) {
      const emb = Array(768).fill(0);
      emb[i * 100] = 1;
      embeddings.push({ nodeId: nodes[i]!.id, embedding: emb });
    }
    await backend.storeEmbeddings(embeddings);

    const queryVector = Array(768).fill(0);
    queryVector[0] = 1;

    const results = await backend.vectorSearch(queryVector, 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].nodeId).toBe(nodes[0]!.id);
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  it('should return results sorted by similarity score', async () => {
    const graph = new KnowledgeGraph();
    
    const highNode = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'high',
      filePath: '/test/file.ts',
      content: 'function high() {}',
      language: 'typescript',
    });
    graph.addNode(highNode);

    const lowNode = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'low',
      filePath: '/test/file.ts',
      content: 'function low() {}',
      language: 'typescript',
    });
    graph.addNode(lowNode);
    
    await backend.bulkLoad(graph);

    const highEmb = Array(768).fill(0.1);
    const lowEmb = Array(768).fill(-0.1);

    await backend.storeEmbeddings([
      { nodeId: highNode.id, embedding: highEmb },
      { nodeId: lowNode.id, embedding: lowEmb },
    ]);

    const query = Array(768).fill(0.1);
    const results = await backend.vectorSearch(query, 2);

    expect(results.length).toBe(2);
    expect(results[0].nodeId).toBe(highNode.id);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('should handle large datasets efficiently (not O(n) scan)', async () => {
    const nodeCount = 100;
    const graph = new KnowledgeGraph();
    
    for (let i = 0; i < nodeCount; i++) {
      const node = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: `func${i}`,
        filePath: `/test/file${Math.floor(i / 10)}.ts`,
        content: `function func${i}() {}`,
        language: 'typescript',
      });
      graph.addNode(node);
    }
    await backend.bulkLoad(graph);

    const embeddings: NodeEmbedding[] = [];
    const nodes = graph.getAllNodes();
    for (let i = 0; i < nodes.length; i++) {
      const emb = Array(768).fill(0).map((_, j) => Math.sin(i + j * 0.01));
      embeddings.push({ nodeId: nodes[i]!.id, embedding: emb });
    }
    await backend.storeEmbeddings(embeddings);

    const query = Array(768).fill(0).map((_, i) => Math.sin(i * 0.01));
    
    const start = performance.now();
    const results = await backend.vectorSearch(query, 10);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(100);
    expect(results.length).toBe(10);
    
    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('should delete embeddings from virtual table when file is removed', async () => {
    const graph = new KnowledgeGraph();
    const node = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'toDelete',
      filePath: '/test/file.ts',
      content: 'function toDelete() {}',
      language: 'typescript',
    });
    graph.addNode(node);
    await backend.bulkLoad(graph);

    const embedding = Array(768).fill(0.5);
    await backend.storeEmbeddings([{ nodeId: node.id, embedding }]);

    const beforeDelete = await backend.vectorSearch(embedding, 1);
    expect(beforeDelete.length).toBe(1);

    await backend.removeNodesByFile('/test/file.ts');

    const afterDelete = await backend.vectorSearch(embedding, 1);
    expect(afterDelete.length).toBe(0);
  });

  it('should fall back to brute-force if virtual table does not exist AND flag is set', async () => {
    process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK = 'true';
    
    const graph = new KnowledgeGraph();
    const node = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'fallback',
      filePath: '/test/file.ts',
      content: 'function fallback() {}',
      language: 'typescript',
    });
    graph.addNode(node);
    await backend.bulkLoad(graph);

    const embedding = Array(768).fill(0.3);
    await backend.storeEmbeddings([{ nodeId: node.id, embedding }]);

    const db = (backend as any).getDb();
    db.exec(`DROP TABLE IF EXISTS node_embeddings_vec`);

    const query = Array(768).fill(0.3);
    const results = await backend.vectorSearch(query, 5);

    expect(results.length).toBe(1);
    expect(results[0].nodeId).toBe(node.id);
    expect(results[0].score).toBeGreaterThan(0.9);
    
    delete process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK;
  });
  
  it('should throw error if virtual table does not exist AND flag is NOT set', async () => {
    delete process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK;
    
    const graph = new KnowledgeGraph();
    const node = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'testNode',
      filePath: '/test/file.ts',
      content: 'function testNode() {}',
      language: 'typescript',
    });
    graph.addNode(node);
    await backend.bulkLoad(graph);

    const embedding = Array(768).fill(0.3);
    await backend.storeEmbeddings([{ nodeId: node.id, embedding }]);

    const db = (backend as any).getDb();
    db.exec(`DROP TABLE IF EXISTS node_embeddings_vec`);

    const query = Array(768).fill(0.3);
    
    await expect(backend.vectorSearch(query, 5)).rejects.toThrow('node_embeddings_vec table does not exist');
  });
});
