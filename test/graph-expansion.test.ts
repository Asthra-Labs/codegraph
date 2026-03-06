import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  expandGraphNeighbors,
  computeGraphBoosts,
  applyGraphExpansion,
  getCallers,
  getCallees,
  DEFAULT_EXPANSION_OPTIONS,
  type GraphExpansionOptions,
} from '../src/search/graph-expansion.js';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, GraphRelationship, NodeLabel } from '../src/graph/index.js';
import type { UnifiedSearchResult } from '../src/search/unified-search.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('GraphExpansion', () => {
  let backend: SQLiteBackend;
  let dbPath: string;
  let tempDir: string;
  let db: any;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-graph-exp-'));
    dbPath = path.join(tempDir, 'test.db');
    backend = new SQLiteBackend();
    await backend.initialize(dbPath);
    db = (backend as any).getDb();
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockResult(overrides: Partial<UnifiedSearchResult> = {}): UnifiedSearchResult {
    return {
      id: 'function:/test/file.ts:testFunc',
      type: 'symbol',
      source: 'graph',
      symbolName: 'testFunc',
      symbolKind: 'function',
      filePath: '/test/file.ts',
      startLine: 1,
      endLine: 10,
      content: 'function testFunc() {}',
      score: 0.8,
      rrfScore: 0.016,
      metadata: {},
      ...overrides,
    };
  }

  describe('expandGraphNeighbors', () => {
    it('should return empty array when disabled', () => {
      const options: GraphExpansionOptions = { ...DEFAULT_EXPANSION_OPTIONS, enabled: false };
      const result = expandGraphNeighbors(db, ['node1'], options);
      expect(result.length).toBe(0);
    });

    it('should return empty array for empty input', () => {
      const result = expandGraphNeighbors(db, [], DEFAULT_EXPANSION_OPTIONS);
      expect(result.length).toBe(0);
    });

    it('should expand callers when enabled', async () => {
      const graph = new KnowledgeGraph();
      
      const target = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'targetFunc',
        filePath: '/test/file.ts',
        content: 'function targetFunc() {}',
        language: 'typescript',
      });
      
      const caller = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'callerFunc',
        filePath: '/test/file.ts',
        content: 'function callerFunc() { targetFunc(); }',
        language: 'typescript',
      });
      
      graph.addNode(target);
      graph.addNode(caller);
      graph.addRelationship(new GraphRelationship({
        type: 'CALLS' as any,
        source: caller.id,
        target: target.id,
      }));
      
      await backend.bulkLoad(graph);

      const expanded = expandGraphNeighbors(db, [target.id], {
        ...DEFAULT_EXPANSION_OPTIONS,
        includeCallers: true,
        includeCallees: false,
      });

      expect(expanded.length).toBe(1);
      expect(expanded[0].id).toBe(caller.id);
    });

    it('should expand callees when enabled', async () => {
      const graph = new KnowledgeGraph();
      
      const caller = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'callerFunc',
        filePath: '/test/file.ts',
        content: 'function callerFunc() { targetFunc(); }',
        language: 'typescript',
      });
      
      const callee = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'targetFunc',
        filePath: '/test/file.ts',
        content: 'function targetFunc() {}',
        language: 'typescript',
      });
      
      graph.addNode(caller);
      graph.addNode(callee);
      graph.addRelationship(new GraphRelationship({
        type: 'CALLS' as any,
        source: caller.id,
        target: callee.id,
      }));
      
      await backend.bulkLoad(graph);

      const expanded = expandGraphNeighbors(db, [caller.id], {
        ...DEFAULT_EXPANSION_OPTIONS,
        includeCallers: false,
        includeCallees: true,
      });

      expect(expanded.length).toBe(1);
      expect(expanded[0].id).toBe(callee.id);
    });

    it('should respect maxNeighborsPerNode limit', async () => {
      const graph = new KnowledgeGraph();
      
      const target = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'targetFunc',
        filePath: '/test/file.ts',
        content: 'function targetFunc() {}',
        language: 'typescript',
      });
      graph.addNode(target);
      
      for (let i = 0; i < 10; i++) {
        const caller = new GraphNode({
          label: NodeLabel.FUNCTION,
          name: `caller${i}`,
          filePath: '/test/file.ts',
          content: `function caller${i}() { targetFunc(); }`,
          language: 'typescript',
        });
        graph.addNode(caller);
        graph.addRelationship(new GraphRelationship({
          type: 'CALLS' as any,
          source: caller.id,
          target: target.id,
        }));
      }
      
      await backend.bulkLoad(graph);

      const expanded = expandGraphNeighbors(db, [target.id], {
        ...DEFAULT_EXPANSION_OPTIONS,
        maxNeighborsPerNode: 3,
      });

      expect(expanded.length).toBeLessThanOrEqual(3);
    });
  });

  describe('computeGraphBoosts', () => {
    it('should return identity boosts when disabled', () => {
      const results = [createMockResult({ id: 'node1', score: 0.8 })];
      const options: GraphExpansionOptions = { ...DEFAULT_EXPANSION_OPTIONS, enabled: false };
      
      const boosts = computeGraphBoosts(db, results, options);
      
      expect(boosts.length).toBe(1);
      expect(boosts[0].boostScore).toBe(0);
      expect(boosts[0].finalScore).toBe(0.8);
    });

    it('should compute boost for connected nodes', async () => {
      const graph = new KnowledgeGraph();
      
      const highScore = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'highScoreFunc',
        filePath: '/test/file.ts',
        content: 'function highScoreFunc() {}',
        language: 'typescript',
      });
      
      const connected = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'connectedFunc',
        filePath: '/test/file.ts',
        content: 'function connectedFunc() {}',
        language: 'typescript',
      });
      
      graph.addNode(highScore);
      graph.addNode(connected);
      graph.addRelationship(new GraphRelationship({
        type: 'CALLS' as any,
        source: highScore.id,
        target: connected.id,
      }));
      
      await backend.bulkLoad(graph);

      const rels = db.prepare(`SELECT * FROM graph_relationships`).all();
      expect(rels.length).toBeGreaterThan(0);

      const results: UnifiedSearchResult[] = [
        createMockResult({ id: highScore.id, score: 0.9 }),
        createMockResult({ id: connected.id, score: 0.6 }),
      ];

      const boosts = computeGraphBoosts(db, results, DEFAULT_EXPANSION_OPTIONS);

      const highScoreBoost = boosts.find(b => b.nodeId === highScore.id);
      const connectedBoost = boosts.find(b => b.nodeId === connected.id);
      
      expect(connectedBoost?.boostScore).toBeGreaterThanOrEqual(0);
      expect(connectedBoost?.finalScore).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe('applyGraphExpansion', () => {
    it('should return unchanged results when disabled', () => {
      const results = [createMockResult()];
      const options: GraphExpansionOptions = { ...DEFAULT_EXPANSION_OPTIONS, enabled: false };
      
      const applied = applyGraphExpansion(db, results, options);
      
      expect(applied.length).toBe(1);
      expect(applied[0].score).toBe(results[0].score);
    });

    it('should add expanded nodes to results', async () => {
      const graph = new KnowledgeGraph();
      
      const main = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'mainFunc',
        filePath: '/test/file.ts',
        content: 'function mainFunc() { helper(); }',
        language: 'typescript',
      });
      
      const helper = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'helperFunc',
        filePath: '/test/file.ts',
        content: 'function helperFunc() {}',
        language: 'typescript',
      });
      
      graph.addNode(main);
      graph.addNode(helper);
      graph.addRelationship(new GraphRelationship({
        type: 'CALLS' as any,
        source: main.id,
        target: helper.id,
      }));
      
      await backend.bulkLoad(graph);

      const results: UnifiedSearchResult[] = [
        createMockResult({ id: main.id, score: 0.9, symbolName: 'mainFunc' }),
      ];

      const expanded = applyGraphExpansion(db, results, DEFAULT_EXPANSION_OPTIONS);

      expect(expanded.length).toBeGreaterThan(1);
      const helperResult = expanded.find(r => r.id === helper.id);
      expect(helperResult).toBeDefined();
      expect(helperResult?.metadata?.expandedFrom).toBe(main.id);
    });
  });

  describe('getCallers', () => {
    it('should return callers of a function', async () => {
      const graph = new KnowledgeGraph();
      
      const target = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'targetFunc',
        filePath: '/test/file.ts',
        content: 'function targetFunc() {}',
        language: 'typescript',
      });
      
      const caller = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'callerFunc',
        filePath: '/test/caller.ts',
        content: 'function callerFunc() { targetFunc(); }',
        language: 'typescript',
      });
      
      graph.addNode(target);
      graph.addNode(caller);
      graph.addRelationship(new GraphRelationship({
        type: 'CALLS' as any,
        source: caller.id,
        target: target.id,
      }));
      
      await backend.bulkLoad(graph);

      const callers = getCallers(db, target.id);

      expect(callers.length).toBe(1);
      expect(callers[0].name).toBe('callerFunc');
    });
  });

  describe('getCallees', () => {
    it('should return callees of a function', async () => {
      const graph = new KnowledgeGraph();
      
      const caller = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'callerFunc',
        filePath: '/test/file.ts',
        content: 'function callerFunc() { helper(); }',
        language: 'typescript',
      });
      
      const callee = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'helperFunc',
        filePath: '/test/helper.ts',
        content: 'function helperFunc() {}',
        language: 'typescript',
      });
      
      graph.addNode(caller);
      graph.addNode(callee);
      graph.addRelationship(new GraphRelationship({
        type: 'CALLS' as any,
        source: caller.id,
        target: callee.id,
      }));
      
      await backend.bulkLoad(graph);

      const callees = getCallees(db, caller.id);

      expect(callees.length).toBe(1);
      expect(callees[0].name).toBe('helperFunc');
    });
  });
});
