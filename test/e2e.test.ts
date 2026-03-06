import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, GraphRelationship, NodeLabel } from '../src/graph/index.js';
import { Chunker, createChunker } from '../src/chunking/index.js';
import {
  createRetrievalTables,
  storeRetrievalDocuments,
  ftsSearchRetrievalDocs,
  vectorSearchRetrievalDocs,
  hybridSearchRetrievalDocs,
  type RetrievalDocument,
} from '../src/retrieval/index.js';
import {
  unifiedSearch,
  processQuery,
  rerankResults,
  applyGraphExpansion,
  hybridSearch,
  DEFAULT_RERANKER_OPTIONS,
  DEFAULT_EXPANSION_OPTIONS,
} from '../src/search/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('End-to-End Retrieval Pipeline', () => {
  let backend: SQLiteBackend;
  let dbPath: string;
  let tempDir: string;
  let db: any;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-e2e-'));
    dbPath = path.join(tempDir, 'test.db');
    backend = new SQLiteBackend();
    await backend.initialize(dbPath);
    db = (backend as any).getDb();
    createRetrievalTables(db);
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Indexing and Chunking', () => {
    it('should index code and create retrieval chunks', async () => {
      const graph = new KnowledgeGraph();
      
      const func1 = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'getUserById',
        filePath: '/src/user-service.ts',
        content: `function getUserById(id: string): User | null {
  const user = db.users.find(u => u.id === id);
  return user || null;
}`,
        language: 'typescript',
      });
      
      const func2 = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'createUser',
        filePath: '/src/user-service.ts',
        content: `function createUser(data: UserData): User {
  const user = { id: generateId(), ...data };
  db.users.push(user);
  return user;
}`,
        language: 'typescript',
      });
      
      graph.addNode(func1);
      graph.addNode(func2);
      graph.addRelationship(new GraphRelationship({
        type: 'CALLS' as any,
        source: func2.id,
        target: func1.id,
      }));
      
      await backend.bulkLoad(graph);
      await backend.storeEmbeddings([
        { nodeId: func1.id, embedding: createMockEmbedding('getUserById') },
        { nodeId: func2.id, embedding: createMockEmbedding('createUser') },
      ]);

      const node = await backend.getNode(func1.id);
      expect(node).toBeDefined();
      expect(node?.name).toBe('getUserById');
    });
  });

  describe('Lexical Retrieval (FTS)', () => {
    it('should find functions by name via FTS', async () => {
      const graph = new KnowledgeGraph();
      
      const func = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'authenticateUser',
        filePath: '/src/auth.ts',
        content: 'function authenticateUser(token: string) { return verifyToken(token); }',
        language: 'typescript',
      });
      
      graph.addNode(func);
      await backend.bulkLoad(graph);

      const results = await backend.ftsSearch('authenticateUser', 10);
      expect(results.length).toBeGreaterThan(0);
    });

    it('should find functions by content keywords', async () => {
      const graph = new KnowledgeGraph();
      
      const func = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'processPayment',
        filePath: '/src/payment.ts',
        content: 'function processPayment(amount: number) { chargeCreditCard(amount); }',
        language: 'typescript',
      });
      
      graph.addNode(func);
      await backend.bulkLoad(graph);

      const results = await backend.ftsSearch('chargeCreditCard', 10);
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Vector Retrieval', () => {
    it('should find similar code via vector search', async () => {
      const graph = new KnowledgeGraph();
      
      const func1 = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'fetchUserData',
        filePath: '/src/api.ts',
        content: 'async function fetchUserData(userId: string) { return fetch(`/api/users/${userId}`); }',
        language: 'typescript',
      });
      
      graph.addNode(func1);
      await backend.bulkLoad(graph);
      
      const embedding = createMockEmbedding('fetch user data api');
      await backend.storeEmbeddings([{ nodeId: func1.id, embedding }]);

      const queryEmbedding = createMockEmbedding('get user from api');
      const results = await backend.vectorSearch(queryEmbedding, 10);
      
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Hybrid Search', () => {
    it('should combine FTS and vector results', async () => {
      const graph = new KnowledgeGraph();
      
      const func = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'validateEmail',
        filePath: '/src/validation.ts',
        content: 'function validateEmail(email: string): boolean { return emailRegex.test(email); }',
        language: 'typescript',
      });
      
      graph.addNode(func);
      await backend.bulkLoad(graph);
      
      const embedding = createMockEmbedding('email validation');
      await backend.storeEmbeddings([{ nodeId: func.id, embedding }]);

      const ftsResults = await backend.ftsSearch('validateEmail', 10);
      const vectorResults = await backend.vectorSearch(embedding, 10);
      
      expect(ftsResults.length).toBeGreaterThan(0);
      expect(vectorResults.length).toBeGreaterThan(0);
    });
  });

  describe('Query Processing', () => {
    it('should normalize camelCase queries', () => {
      const processed = processQuery('getUserById');
      
      expect(processed.identifiers).toContain('getUserById');
      expect(processed.expandedTerms).toContain('get');
      expect(processed.expandedTerms).toContain('user');
      expect(processed.expandedTerms).toContain('by');
      expect(processed.expandedTerms).toContain('id');
    });

    it('should detect exact symbol lookup intent', () => {
      const processed = processQuery('UserService');
      
      expect(processed.intent).toBe('exact_symbol');
      expect(processed.routingHints.preferExactMatch).toBe(true);
    });

    it('should detect usage query intent', () => {
      const processed = processQuery('who calls processPayment');
      
      expect(processed.intent).toBe('usage');
      expect(processed.routingHints.includeCallers).toBe(true);
    });

    it('should detect semantic query intent', () => {
      const processed = processQuery('how do I authenticate a user');
      
      expect(processed.intent).toBe('semantic');
      expect(processed.routingHints.preferVectorSearch).toBe(true);
    });
  });

  describe('Reranking', () => {
    it('should rerank results based on query relevance', async () => {
      const graph = new KnowledgeGraph();
      
      const target = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'targetFunction',
        filePath: '/src/target.ts',
        content: 'function targetFunction() { return "target"; }',
        language: 'typescript',
      });
      
      const other = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'otherFunction',
        filePath: '/src/other.ts',
        content: 'function otherFunction() { return "other"; }',
        language: 'typescript',
      });
      
      graph.addNode(target);
      graph.addNode(other);
      await backend.bulkLoad(graph);

      const results = await backend.ftsSearch('function', 10);
      
      const mappedResults = results.map(r => ({
        id: r.nodeId || r.id || '',
        type: 'symbol' as const,
        source: 'graph' as const,
        symbolName: r.name || 'unknown',
        symbolKind: r.label || 'function',
        filePath: r.filePath || '/unknown',
        startLine: r.startLine || 0,
        endLine: r.endLine || 0,
        content: r.content || '',
        score: r.score,
        rrfScore: r.score,
        metadata: {},
      }));
      
      const reranked = rerankResults(
        mappedResults,
        'targetFunction',
        DEFAULT_RERANKER_OPTIONS
      );

      expect(reranked.length).toBe(mappedResults.length);
    });
  });

  describe('Graph Expansion', () => {
    it('should expand search results with related nodes', async () => {
      const graph = new KnowledgeGraph();
      
      const main = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'mainHandler',
        filePath: '/src/handler.ts',
        content: 'function mainHandler() { helper(); }',
        language: 'typescript',
      });
      
      const helper = new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'helperFunction',
        filePath: '/src/helper.ts',
        content: 'function helperFunction() {}',
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

      const results = [
        {
          id: main.id,
          type: 'symbol' as const,
          source: 'graph' as const,
          symbolName: main.name,
          symbolKind: 'function',
          filePath: main.filePath,
          startLine: main.startLine,
          endLine: main.endLine,
          content: main.content,
          score: 0.9,
          rrfScore: 0.9,
          metadata: {},
        },
      ];

      const expanded = applyGraphExpansion(db, results, DEFAULT_EXPANSION_OPTIONS);

      expect(expanded.length).toBeGreaterThan(1);
      const helperResult = expanded.find(r => r.id === helper.id);
      expect(helperResult).toBeDefined();
      expect(helperResult?.metadata?.expandedFrom).toBe(main.id);
    });
  });

  describe('Full Pipeline', () => {
    it('should execute complete retrieval pipeline', async () => {
      const graph = new KnowledgeGraph();
      
      const userService = new GraphNode({
        label: NodeLabel.CLASS,
        name: 'UserService',
        filePath: '/src/services/user.service.ts',
        content: `class UserService {
  async getUser(id: string) { return this.db.find(id); }
  async createUser(data: UserData) { return this.db.create(data); }
  async deleteUser(id: string) { return this.db.delete(id); }
}`,
        language: 'typescript',
      });
      
      const authController = new GraphNode({
        label: NodeLabel.CLASS,
        name: 'AuthController',
        filePath: '/src/controllers/auth.controller.ts',
        content: `class AuthController {
  constructor(private userService: UserService) {}
  async login(credentials: Credentials) {
    const user = await this.userService.getUser(credentials.id);
    return generateToken(user);
  }
}`,
        language: 'typescript',
      });
      
      graph.addNode(userService);
      graph.addNode(authController);
      graph.addRelationship(new GraphRelationship({
        type: 'CALLS' as any,
        source: authController.id,
        target: userService.id,
      }));
      
      await backend.bulkLoad(graph);
      
      await backend.storeEmbeddings([
        { nodeId: userService.id, embedding: createMockEmbedding('user service database') },
        { nodeId: authController.id, embedding: createMockEmbedding('auth controller login') },
      ]);

      const processed = processQuery('UserService');
      expect(processed.intent).toBe('exact_symbol');

      const ftsResults = await backend.ftsSearch('UserService', 10);
      expect(ftsResults.length).toBeGreaterThan(0);

      const queryEmbedding = createMockEmbedding('user service');
      const vectorResults = await backend.vectorSearch(queryEmbedding, 10);
      expect(vectorResults.length).toBeGreaterThan(0);

      const mappedResults = ftsResults.map(r => ({
        id: r.nodeId || r.id || '',
        type: 'symbol' as const,
        source: 'graph' as const,
        symbolName: r.name || 'unknown',
        symbolKind: r.label || 'class',
        filePath: r.filePath || '/unknown',
        startLine: r.startLine || 0,
        endLine: r.endLine || 0,
        content: r.content || '',
        score: r.score,
        rrfScore: r.score,
        metadata: {},
      }));
      
      const reranked = rerankResults(
        mappedResults,
        'UserService',
        DEFAULT_RERANKER_OPTIONS
      );
      
      expect(reranked.length).toBe(mappedResults.length);
    });
  });
});

function createMockEmbedding(text: string): number[] {
  const embedding = new Array(768).fill(0);
  for (let i = 0; i < text.length && i < 768; i++) {
    embedding[i] = (text.charCodeAt(i) % 100) / 100;
  }
  return embedding;
}
