import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { GraphNode, GraphRelationship, NodeLabel, RelType, KnowledgeGraph } from '../src/graph/index.js';
import { createChunker } from '../src/chunking/chunker.js';
import { createGoldenCorpus } from './golden-corpus.js';
import { processQuery } from '../src/search/query-processor.js';

describe('audit invariants', () => {
  let tempDir: string;
  let dbPath: string;
  let backend: SQLiteBackend;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-audit-'));
    dbPath = path.join(tempDir, 'audit.db');
    backend = new SQLiteBackend();
    await backend.initialize(dbPath);
  });

  afterEach(async () => {
    delete process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK;
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('uses sqlite-vec KNN query when vector table exists', async () => {
    const graph = new KnowledgeGraph();
    const node = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'knnTarget',
      filePath: '/src/knn.ts',
      content: 'function knnTarget() {}',
      language: 'typescript',
    });
    graph.addNode(node);
    await backend.bulkLoad(graph);
    await backend.storeEmbeddings([{ nodeId: node.id, embedding: new Array(768).fill(0.01) }]);

    const db = (backend as any).getDb();
    const table = db.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
    `).get() as { sql: string };
    expect(table.sql).toContain('vec0');

    const results = await backend.vectorSearch(new Array(768).fill(0.01), 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.nodeId).toBe(node.id);
  });

  it('blocks brute-force fallback unless explicit dev flag is set', async () => {
    const db = (backend as any).getDb();
    db.exec(`DROP TABLE IF EXISTS node_embeddings_vec`);

    await expect(backend.vectorSearch(new Array(768).fill(0.1), 5)).rejects.toThrow(
      'ALLOW_BRUTE_FORCE_VECTOR_FALLBACK=true'
    );

    process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK = 'true';
    await expect(backend.vectorSearch(new Array(768).fill(0.1), 5)).resolves.toEqual([]);
  });

  it('applies repo/branch/commit filters to both FTS and vector search', async () => {
    const nodeMain = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'filteredFunc',
      filePath: '/src/main.ts',
      content: 'function filteredFunc() {}',
      language: 'typescript',
    });
    const nodeOther = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'filteredFunc',
      filePath: '/src/other.ts',
      content: 'function filteredFunc() { return 1; }',
      language: 'typescript',
    });
    await backend.addNodes([nodeMain, nodeOther]);
    await backend.storeEmbeddings([
      { nodeId: nodeMain.id, embedding: new Array(768).fill(0.2) },
      { nodeId: nodeOther.id, embedding: new Array(768).fill(0.2) },
    ]);

    const db = (backend as any).getDb();
    db.prepare(`UPDATE graph_nodes SET repo_id='repoA', branch='main', commit_sha='aaa111' WHERE id=?`).run(nodeMain.id);
    db.prepare(`UPDATE graph_nodes SET repo_id='repoB', branch='dev', commit_sha='bbb222' WHERE id=?`).run(nodeOther.id);

    const filters = { repoId: 'repoA', branch: 'main', commitSha: 'aaa111' };
    const fts = await backend.ftsSearch('filteredFunc', 10, filters);
    const vec = await backend.vectorSearch(new Array(768).fill(0.2), 10, filters);

    expect(fts.every(r => r.filePath === '/src/main.ts')).toBe(true);
    expect(vec.every(r => r.filePath === '/src/main.ts')).toBe(true);
  });

  it('splits large symbols into sub-chunks with overlap metadata', () => {
    const chunker = createChunker({ maxChunkTokens: 40, overlapTokens: 10 });
    const largeBody = [
      'function processLargeDataset(items) {',
      ...new Array(120).fill('  const next = normalize(items);'),
      '  return next;',
      '}',
    ].join('\n');

    const chunks = chunker.chunk(
      {
        symbols: [{
          id: 'function:/src/processor.ts:processLargeDataset',
          name: 'processLargeDataset',
          kind: 'function',
          filePath: '/src/processor.ts',
          startLine: 1,
          endLine: 123,
          content: largeBody,
          signature: 'processLargeDataset(items)',
        }],
        imports: [],
        relationships: [],
        exports: [],
        language: 'typescript',
      },
      largeBody
    );

    const subChunks = chunks.filter(c => c.type === 'sub_chunk');
    expect(subChunks.length).toBeGreaterThan(1);
    expect(subChunks.every(c => c.parentId === 'function:/src/processor.ts:processLargeDataset')).toBe(true);
    expect(subChunks.some(c => (c.metadata?.overlapTokens ?? 0) > 0)).toBe(true);
  });

  it('maintains graph extraction coverage above baseline on fixture corpus', async () => {
    const corpus = createGoldenCorpus();
    await backend.bulkLoad({ getAllNodes: () => corpus.nodes, getAllRelationships: () => corpus.relationships } as any);
    const stats = await backend.getStats();
    const calls = Object.entries(stats.relationshipsByType)
      .filter(([k]) => k.toLowerCase() === 'calls')
      .reduce((acc, [, v]) => acc + v, 0);

    expect(stats.nodeCount).toBeGreaterThan(20);
    expect(stats.relationshipCount).toBeGreaterThan(10);
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  it('supports end-to-end DB write/read/search workflow', async () => {
    const auth = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'authenticate',
      filePath: '/src/auth.ts',
      content: 'function authenticate(user, pass) { return true; }',
      language: 'typescript',
    });
    const login = new GraphNode({
      label: NodeLabel.FUNCTION,
      name: 'login',
      filePath: '/src/login.ts',
      content: 'function login(req) { return authenticate(req.user, req.pass); }',
      language: 'typescript',
    });
    await backend.addNodes([auth, login]);
    await backend.addRelationships([
      new GraphRelationship({ type: RelType.CALLS, source: login.id, target: auth.id }),
    ]);
    await backend.storeEmbeddings([
      { nodeId: auth.id, embedding: new Array(768).fill(0.3) },
      { nodeId: login.id, embedding: new Array(768).fill(0.31) },
    ]);

    const fts = await backend.ftsSearch('authenticate', 5);
    const vec = await backend.vectorSearch(new Array(768).fill(0.3), 5);
    const callers = await backend.getCallers(auth.id);

    expect(fts.some(r => r.nodeId === auth.id)).toBe(true);
    expect(vec.length).toBeGreaterThan(0);
    expect(callers.some(c => c.id === login.id)).toBe(true);
  });

  it('routes semantic intent from phrase-based queries', () => {
    const processed = processQuery('how to implement retry backoff');
    expect(processed.intent).toBe('semantic');
    expect(processed.routingHints.preferVectorSearch).toBe(true);
  });
});
