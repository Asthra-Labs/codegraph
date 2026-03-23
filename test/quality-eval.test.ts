import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, GraphRelationship, NodeLabel } from '../src/graph/index.js';
import { processQuery, rerankResults, applyGraphExpansion, DEFAULT_RERANKER_OPTIONS, DEFAULT_EXPANSION_OPTIONS } from '../src/search/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface EvalQuery {
  id: string;
  category: 'exact_symbol' | 'semantic_behavior' | 'usage' | 'navigation' | 'large_chunk';
  query: string;
  relevantIds: string[];
  description: string;
}

interface EvalResult {
  queryId: string;
  category: string;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  withRerank: boolean;
  withGraphExpansion: boolean;
}

function computeRecallAtK(retrieved: string[], relevant: string[], k: number): number {
  const retrievedSet = new Set(retrieved.slice(0, k));
  const relevantRetrieved = relevant.filter(id => retrievedSet.has(id));
  return relevantRetrieved.length / relevant.length;
}

function computeMRRAtK(retrieved: string[], relevant: string[], k: number): number {
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    if (relevant.includes(retrieved[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function computeNDCGAtK(retrieved: string[], relevant: string[], k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(retrieved.length, k); i++) {
    const rel = relevant.includes(retrieved[i]) ? 1 : 0;
    dcg += rel / Math.log2(i + 2);
  }
  
  let idcg = 0;
  for (let i = 0; i < Math.min(relevant.length, k); i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  
  return idcg > 0 ? dcg / idcg : 0;
}

describe('P5: Quality Evaluation', () => {
  let backend: SQLiteBackend;
  let dbPath: string;
  let tempDir: string;
  let db: any;
  let evalQueries: EvalQuery[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-eval-'));
    dbPath = path.join(tempDir, 'eval.db');
    backend = new SQLiteBackend();
    await backend.initialize(dbPath);
    db = (backend as any).getDb();
    
    evalQueries = createEvalQueries();
    await setupEvalCorpus(backend);
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Evaluation Metrics', () => {
    it('should compute Recall@10 correctly', () => {
      const retrieved = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
      const relevant = ['a', 'c', 'z'];
      
      const recall = computeRecallAtK(retrieved, relevant, 10);
      expect(recall).toBe(2 / 3);
    });

    it('should compute MRR@10 correctly', () => {
      const retrieved = ['x', 'y', 'a', 'b'];
      const relevant = ['a', 'b'];
      
      const mrr = computeMRRAtK(retrieved, relevant, 10);
      expect(mrr).toBe(1 / 3);
    });

    it('should compute nDCG@10 correctly', () => {
      const retrieved = ['x', 'a', 'y', 'b'];
      const relevant = ['a', 'b'];
      
      const ndcg = computeNDCGAtK(retrieved, relevant, 10);
      expect(ndcg).toBeGreaterThan(0);
      expect(ndcg).toBeLessThanOrEqual(1);
    });
  });

  describe('Category: Exact Symbol', () => {
    it('should find exact symbol matches in top results', async () => {
      const queries = evalQueries.filter(q => q.category === 'exact_symbol');
      const results: EvalResult[] = [];

      for (const q of queries) {
        const ftsResults = await backend.ftsSearch(q.query, 20);
        const retrieved = ftsResults.map(r => r.nodeId || r.id || '');
        
        results.push({
          queryId: q.id,
          category: q.category,
          recallAt10: computeRecallAtK(retrieved, q.relevantIds, 10),
          mrrAt10: computeMRRAtK(retrieved, q.relevantIds, 10),
          ndcgAt10: computeNDCGAtK(retrieved, q.relevantIds, 10),
          withRerank: false,
          withGraphExpansion: false,
        });
      }

      const avgRecall = results.reduce((s, r) => s + r.recallAt10, 0) / results.length;
      const avgMrr = results.reduce((s, r) => s + r.mrrAt10, 0) / results.length;
      
      console.log('\n=== Exact Symbol Results ===');
      console.log(`Avg Recall@10: ${(avgRecall * 100).toFixed(1)}%`);
      console.log(`Avg MRR@10: ${(avgMrr * 100).toFixed(1)}%`);
      
      expect(avgRecall).toBeGreaterThan(0.8);
      expect(avgMrr).toBeGreaterThan(0.7);
    });
  });

  describe('Category: Semantic Behavior', () => {
    it('should find semantic matches', async () => {
      const queries = evalQueries.filter(q => q.category === 'semantic_behavior');
      const results: EvalResult[] = [];

      for (const q of queries) {
        const processed = processQuery(q.query);
        const expandedQuery = processed.expandedTerms.join(' ');
        const ftsResults = await backend.ftsSearch(expandedQuery, 20);
        const retrieved = ftsResults.map(r => r.nodeId || r.id || '');
        
        results.push({
          queryId: q.id,
          category: q.category,
          recallAt10: computeRecallAtK(retrieved, q.relevantIds, 10),
          mrrAt10: computeMRRAtK(retrieved, q.relevantIds, 10),
          ndcgAt10: computeNDCGAtK(retrieved, q.relevantIds, 10),
          withRerank: false,
          withGraphExpansion: false,
        });
      }

      const avgRecall = results.reduce((s, r) => s + r.recallAt10, 0) / results.length;
      
      console.log('\n=== Semantic Behavior Results ===');
      console.log(`Avg Recall@10: ${(avgRecall * 100).toFixed(1)}%`);
      
      expect(avgRecall).toBeGreaterThan(0.4);
    });
  });

  describe('Category: Usage Queries', () => {
    it('should find callers and usages with graph expansion', async () => {
      const queries = evalQueries.filter(q => q.category === 'usage');
      const results: EvalResult[] = [];

      for (const q of queries) {
        const ftsResults = await backend.ftsSearch(q.query, 20);
        const retrieved = ftsResults.map(r => r.nodeId || r.id || '');
        
        results.push({
          queryId: q.id,
          category: q.category,
          recallAt10: computeRecallAtK(retrieved, q.relevantIds, 10),
          mrrAt10: computeMRRAtK(retrieved, q.relevantIds, 10),
          ndcgAt10: computeNDCGAtK(retrieved, q.relevantIds, 10),
          withRerank: false,
          withGraphExpansion: false,
        });
      }

      const avgRecallWithoutExpansion = results.reduce((s, r) => s + r.recallAt10, 0) / results.length;
      
      // With graph expansion
      const resultsWithExpansion: EvalResult[] = [];
      for (const q of queries) {
        const ftsResults = await backend.ftsSearch(q.query, 20);
        const mappedResults = ftsResults.map(r => ({
          id: r.nodeId || r.id || '',
          type: 'symbol' as const,
          source: 'graph' as const,
          symbolName: r.name || '',
          symbolKind: r.label || 'function',
          filePath: r.filePath || '',
          startLine: r.startLine || 0,
          endLine: r.endLine || 0,
          content: r.content || '',
          score: r.score,
          rrfScore: r.score,
          metadata: {},
        }));
        
        const expanded = applyGraphExpansion(db, mappedResults, {
          ...DEFAULT_EXPANSION_OPTIONS,
          includeCallers: true,
        });
        
        const retrieved = expanded.map(r => r.id);
        
        resultsWithExpansion.push({
          queryId: q.id,
          category: q.category,
          recallAt10: computeRecallAtK(retrieved, q.relevantIds, 10),
          mrrAt10: computeMRRAtK(retrieved, q.relevantIds, 10),
          ndcgAt10: computeNDCGAtK(retrieved, q.relevantIds, 10),
          withRerank: false,
          withGraphExpansion: true,
        });
      }

      const avgRecallWithExpansion = resultsWithExpansion.reduce((s, r) => s + r.recallAt10, 0) / resultsWithExpansion.length;
      
      console.log('\n=== Usage Query Results ===');
      console.log(`Avg Recall@10 (no expansion): ${(avgRecallWithoutExpansion * 100).toFixed(1)}%`);
      console.log(`Avg Recall@10 (with expansion): ${(avgRecallWithExpansion * 100).toFixed(1)}%`);
      
      expect(avgRecallWithExpansion).toBeGreaterThanOrEqual(avgRecallWithoutExpansion);
    });
  });

  describe('Full Evaluation Report', () => {
    it('should generate evaluation report for all categories', async () => {
      const allResults: EvalResult[] = [];

      for (const q of evalQueries) {
        let searchQuery = q.query;
        
        if (q.category === 'semantic_behavior') {
          const processed = processQuery(q.query);
          searchQuery = processed.expandedTerms.join(' ');
        }
        
        const ftsResults = await backend.ftsSearch(searchQuery, 20);
        const mappedResults = ftsResults.map(r => ({
          id: r.nodeId || r.id || '',
          type: 'symbol' as const,
          source: 'graph' as const,
          symbolName: r.name || '',
          symbolKind: r.label || 'function',
          filePath: r.filePath || '',
          startLine: r.startLine || 0,
          endLine: r.endLine || 0,
          content: r.content || '',
          score: r.score,
          rrfScore: r.score,
          metadata: {},
        }));

        // Without rerank
        const retrievedNoRerank = mappedResults.map(r => r.id);
        allResults.push({
          queryId: q.id,
          category: q.category,
          recallAt10: computeRecallAtK(retrievedNoRerank, q.relevantIds, 10),
          mrrAt10: computeMRRAtK(retrievedNoRerank, q.relevantIds, 10),
          ndcgAt10: computeNDCGAtK(retrievedNoRerank, q.relevantIds, 10),
          withRerank: false,
          withGraphExpansion: false,
        });

        // With rerank
        const reranked = await rerankResults(mappedResults, q.query, DEFAULT_RERANKER_OPTIONS);
        const retrievedRerank = reranked.results.map(r => r.id);
        allResults.push({
          queryId: q.id,
          category: q.category,
          recallAt10: computeRecallAtK(retrievedRerank, q.relevantIds, 10),
          mrrAt10: computeMRRAtK(retrievedRerank, q.relevantIds, 10),
          ndcgAt10: computeNDCGAtK(retrievedRerank, q.relevantIds, 10),
          withRerank: true,
          withGraphExpansion: false,
        });
      }

      // Aggregate by category
      const categories = ['exact_symbol', 'semantic_behavior', 'usage', 'navigation', 'large_chunk'];
      
      console.log('\n========================================');
      console.log('QUALITY EVALUATION REPORT');
      console.log('========================================\n');
      
      for (const cat of categories) {
        const catResults = allResults.filter(r => r.category === cat);
        if (catResults.length === 0) continue;
        
        const noRerank = catResults.filter(r => !r.withRerank);
        const withRerank = catResults.filter(r => r.withRerank);
        
        const avgRecallNoRerank = noRerank.reduce((s, r) => s + r.recallAt10, 0) / noRerank.length;
        const avgMrrNoRerank = noRerank.reduce((s, r) => s + r.mrrAt10, 0) / noRerank.length;
        const avgNdcgNoRerank = noRerank.reduce((s, r) => s + r.ndcgAt10, 0) / noRerank.length;
        
        const avgRecallRerank = withRerank.reduce((s, r) => s + r.recallAt10, 0) / withRerank.length;
        const avgMrrRerank = withRerank.reduce((s, r) => s + r.mrrAt10, 0) / withRerank.length;
        const avgNdcgRerank = withRerank.reduce((s, r) => s + r.ndcgAt10, 0) / withRerank.length;
        
        console.log(`Category: ${cat}`);
        console.log('  Before Rerank:');
        console.log(`    Recall@10: ${(avgRecallNoRerank * 100).toFixed(1)}%`);
        console.log(`    MRR@10:    ${(avgMrrNoRerank * 100).toFixed(1)}%`);
        console.log(`    nDCG@10:   ${(avgNdcgNoRerank * 100).toFixed(1)}%`);
        console.log('  After Rerank:');
        console.log(`    Recall@10: ${(avgRecallRerank * 100).toFixed(1)}%`);
        console.log(`    MRR@10:    ${(avgMrrRerank * 100).toFixed(1)}%`);
        console.log(`    nDCG@10:   ${(avgNdcgRerank * 100).toFixed(1)}%`);
        console.log('');
      }
      
      // Overall
      const overallNoRerank = allResults.filter(r => !r.withRerank);
      const overallWithRerank = allResults.filter(r => r.withRerank);
      
      console.log('Overall:');
      console.log(`  Before Rerank:`);
      console.log(`    Recall@10: ${(overallNoRerank.reduce((s, r) => s + r.recallAt10, 0) / overallNoRerank.length * 100).toFixed(1)}%`);
      console.log(`    MRR@10:    ${(overallNoRerank.reduce((s, r) => s + r.mrrAt10, 0) / overallNoRerank.length * 100).toFixed(1)}%`);
      console.log(`    nDCG@10:   ${(overallNoRerank.reduce((s, r) => s + r.ndcgAt10, 0) / overallNoRerank.length * 100).toFixed(1)}%`);
      console.log(`  After Rerank:`);
      console.log(`    Recall@10: ${(overallWithRerank.reduce((s, r) => s + r.recallAt10, 0) / overallWithRerank.length * 100).toFixed(1)}%`);
      console.log(`    MRR@10:    ${(overallWithRerank.reduce((s, r) => s + r.mrrAt10, 0) / overallWithRerank.length * 100).toFixed(1)}%`);
      console.log(`    nDCG@10:   ${(overallWithRerank.reduce((s, r) => s + r.ndcgAt10, 0) / overallWithRerank.length * 100).toFixed(1)}%`);
      console.log('========================================\n');
      
      expect(allResults.length).toBeGreaterThan(0);
    }, 20000);
  });
});

function createEvalQueries(): EvalQuery[] {
  return [
    // Exact Symbol (10 queries)
    { id: 'es1', category: 'exact_symbol', query: 'UserService', relevantIds: ['class:/src/services/UserService.ts:UserService'], description: 'Find UserService class' },
    { id: 'es2', category: 'exact_symbol', query: 'authenticate', relevantIds: ['function:/src/auth/authenticate.ts:authenticate'], description: 'Find authenticate function' },
    { id: 'es3', category: 'exact_symbol', query: 'DatabaseConnection', relevantIds: ['class:/src/db/DatabaseConnection.ts:DatabaseConnection'], description: 'Find DatabaseConnection class' },
    { id: 'es4', category: 'exact_symbol', query: 'parseConfig', relevantIds: ['function:/src/config/parser.ts:parseConfig'], description: 'Find parseConfig function' },
    { id: 'es5', category: 'exact_symbol', query: 'HttpClient', relevantIds: ['class:/src/http/HttpClient.ts:HttpClient'], description: 'Find HttpClient class' },
    { id: 'es6', category: 'exact_symbol', query: 'validateInput', relevantIds: ['function:/src/validation/validate.ts:validateInput'], description: 'Find validateInput function' },
    { id: 'es7', category: 'exact_symbol', query: 'CacheManager', relevantIds: ['class:/src/cache/CacheManager.ts:CacheManager'], description: 'Find CacheManager class' },
    { id: 'es8', category: 'exact_symbol', query: 'formatDate', relevantIds: ['function:/src/utils/date.ts:formatDate'], description: 'Find formatDate function' },
    { id: 'es9', category: 'exact_symbol', query: 'Logger', relevantIds: ['class:/src/logging/Logger.ts:Logger'], description: 'Find Logger class' },
    { id: 'es10', category: 'exact_symbol', query: 'encrypt', relevantIds: ['function:/src/crypto/encrypt.ts:encrypt'], description: 'Find encrypt function' },
    
    // Semantic Behavior (10 queries)
    { id: 'sb1', category: 'semantic_behavior', query: 'user authentication login', relevantIds: ['function:/src/auth/authenticate.ts:authenticate', 'class:/src/auth/AuthService.ts:AuthService'], description: 'Find authentication related code' },
    { id: 'sb2', category: 'semantic_behavior', query: 'database connection pool', relevantIds: ['class:/src/db/DatabaseConnection.ts:DatabaseConnection', 'class:/src/db/ConnectionPool.ts:ConnectionPool'], description: 'Find database connection code' },
    { id: 'sb3', category: 'semantic_behavior', query: 'http request response', relevantIds: ['class:/src/http/HttpClient.ts:HttpClient', 'function:/src/http/request.ts:makeRequest'], description: 'Find HTTP code' },
    { id: 'sb4', category: 'semantic_behavior', query: 'cache store retrieve', relevantIds: ['class:/src/cache/CacheManager.ts:CacheManager', 'function:/src/cache/get.ts:cacheGet'], description: 'Find cache code' },
    { id: 'sb5', category: 'semantic_behavior', query: 'error handling exception', relevantIds: ['function:/src/errors/handleError.ts:handleError', 'class:/src/errors/AppError.ts:AppError'], description: 'Find error handling code' },
    { id: 'sb6', category: 'semantic_behavior', query: 'configuration settings', relevantIds: ['function:/src/config/parser.ts:parseConfig', 'class:/src/config/Config.ts:Config'], description: 'Find configuration code' },
    { id: 'sb7', category: 'semantic_behavior', query: 'validation input check', relevantIds: ['function:/src/validation/validate.ts:validateInput', 'function:/src/validation/schemas.ts:validateSchema'], description: 'Find validation code' },
    { id: 'sb8', category: 'semantic_behavior', query: 'logging debug trace', relevantIds: ['class:/src/logging/Logger.ts:Logger', 'function:/src/logging/log.ts:logDebug'], description: 'Find logging code' },
    { id: 'sb9', category: 'semantic_behavior', query: 'encryption security crypto', relevantIds: ['function:/src/crypto/encrypt.ts:encrypt', 'function:/src/crypto/decrypt.ts:decrypt'], description: 'Find crypto code' },
    { id: 'sb10', category: 'semantic_behavior', query: 'date time format', relevantIds: ['function:/src/utils/date.ts:formatDate', 'function:/src/utils/time.ts:parseTime'], description: 'Find date/time code' },
    
    // Usage (10 queries)
    { id: 'u1', category: 'usage', query: 'authenticate', relevantIds: ['function:/src/auth/authenticate.ts:authenticate', 'function:/src/routes/login.ts:login'], description: 'Who uses authenticate' },
    { id: 'u2', category: 'usage', query: 'DatabaseConnection', relevantIds: ['class:/src/db/DatabaseConnection.ts:DatabaseConnection', 'class:/src/repositories/UserRepository.ts:UserRepository'], description: 'Who uses DatabaseConnection' },
    { id: 'u3', category: 'usage', query: 'HttpClient', relevantIds: ['class:/src/http/HttpClient.ts:HttpClient', 'function:/src/services/ExternalService.ts:fetchData'], description: 'Who uses HttpClient' },
    { id: 'u4', category: 'usage', query: 'CacheManager', relevantIds: ['class:/src/cache/CacheManager.ts:CacheManager', 'function:/src/services/CachedService.ts:getCached'], description: 'Who uses CacheManager' },
    { id: 'u5', category: 'usage', query: 'Logger', relevantIds: ['class:/src/logging/Logger.ts:Logger', 'function:/src/middleware/logging.ts:logRequest'], description: 'Who uses Logger' },
    { id: 'u6', category: 'usage', query: 'parseConfig', relevantIds: ['function:/src/config/parser.ts:parseConfig', 'function:/src/app.ts:initializeApp'], description: 'Who uses parseConfig' },
    { id: 'u7', category: 'usage', query: 'validateInput', relevantIds: ['function:/src/validation/validate.ts:validateInput', 'function:/src/routes/api.ts:handleApiRequest'], description: 'Who uses validateInput' },
    { id: 'u8', category: 'usage', query: 'encrypt', relevantIds: ['function:/src/crypto/encrypt.ts:encrypt', 'function:/src/auth/password.ts:hashPassword'], description: 'Who uses encrypt' },
    { id: 'u9', category: 'usage', query: 'formatDate', relevantIds: ['function:/src/utils/date.ts:formatDate', 'function:/src/formatters/output.ts:formatTimestamp'], description: 'Who uses formatDate' },
    { id: 'u10', category: 'usage', query: 'AppError', relevantIds: ['class:/src/errors/AppError.ts:AppError', 'function:/src/errors/validators.ts:throwIfInvalid'], description: 'Who uses AppError' },
    
    // Navigation (10 queries)
    { id: 'n1', category: 'navigation', query: 'src/auth', relevantIds: ['function:/src/auth/authenticate.ts:authenticate', 'class:/src/auth/AuthService.ts:AuthService'], description: 'Navigate to auth module' },
    { id: 'n2', category: 'navigation', query: 'src/db', relevantIds: ['class:/src/db/DatabaseConnection.ts:DatabaseConnection', 'class:/src/db/ConnectionPool.ts:ConnectionPool'], description: 'Navigate to db module' },
    { id: 'n3', category: 'navigation', query: 'src/http', relevantIds: ['class:/src/http/HttpClient.ts:HttpClient', 'function:/src/http/request.ts:makeRequest'], description: 'Navigate to http module' },
    { id: 'n4', category: 'navigation', query: 'src/cache', relevantIds: ['class:/src/cache/CacheManager.ts:CacheManager', 'function:/src/cache/get.ts:cacheGet'], description: 'Navigate to cache module' },
    { id: 'n5', category: 'navigation', query: 'src/config', relevantIds: ['function:/src/config/parser.ts:parseConfig', 'class:/src/config/Config.ts:Config'], description: 'Navigate to config module' },
    { id: 'n6', category: 'navigation', query: 'src/validation', relevantIds: ['function:/src/validation/validate.ts:validateInput', 'function:/src/validation/schemas.ts:validateSchema'], description: 'Navigate to validation module' },
    { id: 'n7', category: 'navigation', query: 'src/logging', relevantIds: ['class:/src/logging/Logger.ts:Logger', 'function:/src/logging/log.ts:logDebug'], description: 'Navigate to logging module' },
    { id: 'n8', category: 'navigation', query: 'src/crypto', relevantIds: ['function:/src/crypto/encrypt.ts:encrypt', 'function:/src/crypto/decrypt.ts:decrypt'], description: 'Navigate to crypto module' },
    { id: 'n9', category: 'navigation', query: 'src/utils', relevantIds: ['function:/src/utils/date.ts:formatDate', 'function:/src/utils/time.ts:parseTime'], description: 'Navigate to utils module' },
    { id: 'n10', category: 'navigation', query: 'src/errors', relevantIds: ['class:/src/errors/AppError.ts:AppError', 'function:/src/errors/handleError.ts:handleError'], description: 'Navigate to errors module' },
    
    // Large Chunk (5 queries) - targeting mid-function behavior in large functions
    { id: 'lc1', category: 'large_chunk', query: 'transform data', relevantIds: ['function:/src/processors/dataProcessor.ts:processLargeDataset'], description: 'Find data transformation logic in large function' },
    { id: 'lc2', category: 'large_chunk', query: 'business rules apply', relevantIds: ['function:/src/processors/dataProcessor.ts:processLargeDataset', 'class:/src/rules/BusinessRuleEngine.ts:BusinessRuleEngine'], description: 'Find business rule application' },
    { id: 'lc3', category: 'large_chunk', query: 'persist batch save', relevantIds: ['function:/src/processors/dataProcessor.ts:processLargeDataset', 'function:/src/persistence/batch.ts:persistBatch'], description: 'Find persistence logic' },
    { id: 'lc4', category: 'large_chunk', query: 'validate input schema', relevantIds: ['function:/src/processors/dataProcessor.ts:processLargeDataset'], description: 'Find validation stage in processor' },
    { id: 'lc5', category: 'large_chunk', query: 'auto fix violations', relevantIds: ['class:/src/rules/BusinessRuleEngine.ts:BusinessRuleEngine'], description: 'Find auto-fix logic in business rules' },
  ];
}

async function setupEvalCorpus(backend: SQLiteBackend): Promise<void> {
  const graph = new KnowledgeGraph();
  
  // Create auth module
  const authService = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'AuthService',
    filePath: '/src/auth/AuthService.ts',
    content: 'class AuthService { async authenticate(credentials) { ... } }',
    language: 'typescript',
  });
  const authenticate = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'authenticate',
    filePath: '/src/auth/authenticate.ts',
    content: 'async function authenticate(user, pass) { ... }',
    language: 'typescript',
  });
  const login = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'login',
    filePath: '/src/routes/login.ts',
    content: 'async function login() { await authenticate(user, pass); }',
    language: 'typescript',
  });
  
  // Create db module
  const dbConnection = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'DatabaseConnection',
    filePath: '/src/db/DatabaseConnection.ts',
    content: 'class DatabaseConnection { connect() { ... } }',
    language: 'typescript',
  });
  const connectionPool = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'ConnectionPool',
    filePath: '/src/db/ConnectionPool.ts',
    content: 'class ConnectionPool { acquire() { ... } }',
    language: 'typescript',
  });
  
  // Create http module
  const httpClient = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'HttpClient',
    filePath: '/src/http/HttpClient.ts',
    content: 'class HttpClient { get() { ... } post() { ... } }',
    language: 'typescript',
  });
  const makeRequest = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'makeRequest',
    filePath: '/src/http/request.ts',
    content: 'async function makeRequest(url, options) { ... }',
    language: 'typescript',
  });
  
  // Create cache module
  const cacheManager = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'CacheManager',
    filePath: '/src/cache/CacheManager.ts',
    content: 'class CacheManager { get() set() delete() }',
    language: 'typescript',
  });
  const cacheGet = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'cacheGet',
    filePath: '/src/cache/get.ts',
    content: 'async function cacheGet(key) { ... }',
    language: 'typescript',
  });
  
  // Create config module
  const config = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'Config',
    filePath: '/src/config/Config.ts',
    content: 'class Config { load() { ... } }',
    language: 'typescript',
  });
  const parseConfig = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'parseConfig',
    filePath: '/src/config/parser.ts',
    content: 'function parseConfig(file) { ... }',
    language: 'typescript',
  });
  
  // Create validation module
  const validateInput = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'validateInput',
    filePath: '/src/validation/validate.ts',
    content: 'function validateInput(data, schema) { ... }',
    language: 'typescript',
  });
  const validateSchema = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'validateSchema',
    filePath: '/src/validation/schemas.ts',
    content: 'function validateSchema(obj, schema) { /* complex validation logic */ }',
    language: 'typescript',
  });
  
  // Create logging module
  const logger = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'Logger',
    filePath: '/src/logging/Logger.ts',
    content: 'class Logger { info() debug() error() }',
    language: 'typescript',
  });
  const logDebug = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'logDebug',
    filePath: '/src/logging/log.ts',
    content: 'function logDebug(message, context) { ... }',
    language: 'typescript',
  });
  
  // Create crypto module
  const encrypt = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'encrypt',
    filePath: '/src/crypto/encrypt.ts',
    content: 'function encrypt(data, key) { ... }',
    language: 'typescript',
  });
  const decrypt = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'decrypt',
    filePath: '/src/crypto/decrypt.ts',
    content: 'function decrypt(encrypted, key) { ... }',
    language: 'typescript',
  });
  
  // Create utils module
  const formatDate = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'formatDate',
    filePath: '/src/utils/date.ts',
    content: 'function formatDate(date, format) { ... }',
    language: 'typescript',
  });
  const parseTime = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'parseTime',
    filePath: '/src/utils/time.ts',
    content: 'function parseTime(timeStr) { ... }',
    language: 'typescript',
  });
  
  // Create errors module
  const appError = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'AppError',
    filePath: '/src/errors/AppError.ts',
    content: 'class AppError extends Error { ... }',
    language: 'typescript',
  });
  const handleError = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'handleError',
    filePath: '/src/errors/handleError.ts',
    content: 'function handleError(error) { ... }',
    language: 'typescript',
  });
  
  // Create user service
  const userService = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'UserService',
    filePath: '/src/services/UserService.ts',
    content: 'class UserService { getUser() createUser() }',
    language: 'typescript',
  });
  
  // Create large chunk test data
  const largeDataProcessor = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'processLargeDataset',
    filePath: '/src/processors/dataProcessor.ts',
    content: `async function processLargeDataset(rawData, options) {
      // Stage 1: Validate input data
      const validatedData = [];
      const validationErrors = [];
      for (const item of rawData) {
        try {
          const schema = await loadValidationSchema(item.type);
          const validated = await validateAgainstSchema(item, schema);
          if (validated.isValid) { validatedData.push(validated.data); }
          else { validationErrors.push({ item, errors: validated.errors }); }
        } catch (err) { validationErrors.push({ item, errors: [err.message] }); }
      }
      if (validationErrors.length > options.maxErrors) {
        throw new ValidationError('Too many validation errors');
      }
      // Stage 2: Transform data
      const transformedData = [];
      const transformer = createTransformer(options.transformConfig);
      for (const item of validatedData) {
        const transformed = await transformer.transform(item);
        if (transformed.needsEnrichment) {
          const enriched = await enrichData(transformed, options.enrichmentSources);
          transformedData.push(enriched);
        } else { transformedData.push(transformed); }
      }
      // Stage 3: Apply business rules
      const processedData = [];
      const ruleEngine = new BusinessRuleEngine(options.rules);
      for (const item of transformedData) {
        const ruleResult = await ruleEngine.apply(item);
        if (ruleResult.passed) {
          processedData.push({ ...item, ruleMetadata: ruleResult.metadata });
        } else if (ruleResult.canAutoFix) {
          const fixed = await ruleEngine.autoFix(item, ruleResult.violations);
          processedData.push({ ...fixed, wasAutoFixed: true });
        }
      }
      // Stage 4: Persist results
      const persistenceResult = await persistBatch(processedData, {
        batchSize: options.batchSize || 100,
        concurrency: options.concurrency || 5,
        retryAttempts: 3
      });
      // Stage 5: Generate report
      const report = await generateReport({ input: rawData.length, validated: validatedData.length });
      return { report, persistenceResult, validationErrors };
    }`,
    language: 'typescript',
  });
  
  const businessRuleEngine = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'BusinessRuleEngine',
    filePath: '/src/rules/BusinessRuleEngine.ts',
    content: `class BusinessRuleEngine {
      constructor(private rules) {}
      async apply(data) {
        for (const rule of this.rules) {
          const result = await rule.evaluate(data);
          if (!result.passed) {
            return { passed: false, violations: result.violations, canAutoFix: rule.canAutoFix };
          }
        }
        return { passed: true };
      }
      async autoFix(data, violations) {
        let fixed = { ...data };
        for (const violation of violations) {
          if (violation.autoFix) { fixed = await violation.autoFix(fixed); }
        }
        return fixed;
      }
    }`,
    language: 'typescript',
  });
  
  const persistBatch = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'persistBatch',
    filePath: '/src/persistence/batch.ts',
    content: `async function persistBatch(items, config) {
      const batches = chunk(items, config.batchSize);
      const results = await Promise.all(
        batches.map((batch, i) => retry(() => saveBatch(batch), config.retryAttempts))
      );
      return { saved: results.reduce((s, r) => s + r.saved, 0) };
    }`,
    language: 'typescript',
  });
  
  // Add all nodes
  const allNodes = [
    authService, authenticate, login,
    dbConnection, connectionPool,
    httpClient, makeRequest,
    cacheManager, cacheGet,
    config, parseConfig,
    validateInput, validateSchema,
    logger, logDebug,
    encrypt, decrypt,
    formatDate, parseTime,
    appError, handleError,
    userService,
    largeDataProcessor, businessRuleEngine, persistBatch,
  ];
  
  for (const node of allNodes) {
    graph.addNode(node);
  }
  
  graph.addRelationship(new GraphRelationship({
    type: 'CALLS' as any, source: login.id, target: authenticate.id,
  }));
  graph.addRelationship(new GraphRelationship({
    type: 'IMPORTS' as any, source: authService.id, target: authenticate.id,
  }));
  
  const userRepository = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'UserRepository',
    filePath: '/src/repositories/UserRepository.ts',
    content: 'class UserRepository { constructor(private db: DatabaseConnection) {} }',
    language: 'typescript',
  });
  graph.addNode(userRepository);
  graph.addRelationship(new GraphRelationship({
    type: 'USES_TYPE' as any, source: userRepository.id, target: dbConnection.id,
  }));
  
  const fetchData = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'fetchData',
    filePath: '/src/services/ExternalService.ts',
    content: 'async function fetchData(url) { const client = new HttpClient(); return client.get(url); }',
    language: 'typescript',
  });
  graph.addNode(fetchData);
  graph.addRelationship(new GraphRelationship({
    type: 'INSTANTIATES' as any, source: fetchData.id, target: httpClient.id,
  }));
  
  const getCached = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'getCached',
    filePath: '/src/services/CachedService.ts',
    content: 'async function getCached(key) { const cache = new CacheManager(); return cache.get(key); }',
    language: 'typescript',
  });
  graph.addNode(getCached);
  graph.addRelationship(new GraphRelationship({
    type: 'INSTANTIATES' as any, source: getCached.id, target: cacheManager.id,
  }));
  
  const logRequest = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'logRequest',
    filePath: '/src/middleware/logging.ts',
    content: 'function logRequest(req, res, next) { Logger.info(req.path); next(); }',
    language: 'typescript',
  });
  graph.addNode(logRequest);
  graph.addRelationship(new GraphRelationship({
    type: 'USES_TYPE' as any, source: logRequest.id, target: logger.id,
  }));
  
  const initializeApp = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'initializeApp',
    filePath: '/src/app.ts',
    content: 'async function initializeApp() { const config = parseConfig("./config.json"); }',
    language: 'typescript',
  });
  graph.addNode(initializeApp);
  graph.addRelationship(new GraphRelationship({
    type: 'CALLS' as any, source: initializeApp.id, target: parseConfig.id,
  }));
  
  const handleApiRequest = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'handleApiRequest',
    filePath: '/src/routes/api.ts',
    content: 'async function handleApiRequest(req) { validateInput(req.body, schema); }',
    language: 'typescript',
  });
  graph.addNode(handleApiRequest);
  graph.addRelationship(new GraphRelationship({
    type: 'CALLS' as any, source: handleApiRequest.id, target: validateInput.id,
  }));
  
  const hashPassword = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'hashPassword',
    filePath: '/src/auth/password.ts',
    content: 'async function hashPassword(pwd) { return encrypt(pwd, salt); }',
    language: 'typescript',
  });
  graph.addNode(hashPassword);
  graph.addRelationship(new GraphRelationship({
    type: 'CALLS' as any, source: hashPassword.id, target: encrypt.id,
  }));
  
  const formatTimestamp = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'formatTimestamp',
    filePath: '/src/formatters/output.ts',
    content: 'function formatTimestamp(ts) { return formatDate(new Date(ts)); }',
    language: 'typescript',
  });
  graph.addNode(formatTimestamp);
  graph.addRelationship(new GraphRelationship({
    type: 'CALLS' as any, source: formatTimestamp.id, target: formatDate.id,
  }));
  
  const throwIfInvalid = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'throwIfInvalid',
    filePath: '/src/errors/validators.ts',
    content: 'function throwIfInvalid(val) { if (!val) throw new AppError("Invalid"); }',
    language: 'typescript',
  });
  graph.addNode(throwIfInvalid);
  graph.addRelationship(new GraphRelationship({
    type: 'USES_TYPE' as any, source: throwIfInvalid.id, target: appError.id,
  }));
  
  await backend.bulkLoad(graph);
  
  // Store embeddings for vector search
  for (const node of allNodes) {
    const embedding = Array(768).fill(0).map((_, i) => 
      Math.sin(node.name.charCodeAt(i % node.name.length) * 0.1)
    );
    await backend.storeEmbeddings([{ nodeId: node.id, embedding }]);
  }
}
