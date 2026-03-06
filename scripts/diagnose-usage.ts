#!/usr/bin/env bun
/**
 * Diagnose Usage Query Failures
 * 
 * Runs the evaluation set and prints detailed failure analysis for usage queries.
 */

import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, GraphRelationship, NodeLabel } from '../src/graph/index.js';
import { processQuery, applyGraphExpansion, DEFAULT_EXPANSION_OPTIONS } from '../src/search/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface EvalQuery {
  id: string;
  category: string;
  query: string;
  relevantIds: string[];
  description: string;
}

interface FailureAnalysis {
  queryId: string;
  query: string;
  relevantIds: string[];
  retrievedIds: string[];
  missedIds: string[];
  top10Results: { id: string; name: string; score: number }[];
  failureType: 'missing_callsite' | 'ranking' | 'graph_expansion' | 'not_indexed';
  diagnosis: string;
}

async function diagnoseUsageFailures() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-diagnose-'));
  const dbPath = path.join(tempDir, 'diagnose.db');
  
  const backend = new SQLiteBackend();
  await backend.initialize(dbPath);
  const db = (backend as any).getDb();
  
  // Setup corpus
  await setupCorpus(backend);
  
  // Usage queries from eval set
  const usageQueries: EvalQuery[] = [
    { id: 'u1', category: 'usage', query: 'authenticate', relevantIds: ['function:/src/auth/authenticate.ts:authenticate', 'function:/src/routes/login.ts:login'], description: 'Who uses authenticate' },
    { id: 'u2', category: 'usage', query: 'DatabaseConnection', relevantIds: ['class:/src/db/DatabaseConnection.ts:DatabaseConnection', 'class:/src/repositories/UserRepository.ts:UserRepository'], description: 'Who uses DatabaseConnection' },
    { id: 'u3', category: 'usage', query: 'HttpClient', relevantIds: ['class:/src/http/HttpClient.ts:HttpClient', 'function:/src/services/ExternalService.ts:fetchData'], description: 'Who uses HttpClient' },
    { id: 'u4', category: 'usage', query: 'CacheManager', relevantIds: ['class:/src/cache/CacheManager.ts:CacheManager', 'function:/src/services/CachedService.ts:getCached'], description: 'Who uses CacheManager' },
    { id: 'u5', category: 'usage', query: 'Logger', relevantIds: ['class:/src/logging/Logger.ts:Logger'], description: 'Who uses Logger' },
    { id: 'u6', category: 'usage', query: 'parseConfig', relevantIds: ['function:/src/config/parser.ts:parseConfig', 'function:/src/app.ts:initialize'], description: 'Who uses parseConfig' },
    { id: 'u7', category: 'usage', query: 'validateInput', relevantIds: ['function:/src/validation/validate.ts:validateInput', 'function:/src/routes/api.ts:handleRequest'], description: 'Who uses validateInput' },
    { id: 'u8', category: 'usage', query: 'encrypt', relevantIds: ['function:/src/crypto/encrypt.ts:encrypt', 'function:/src/auth/password.ts:hashPassword'], description: 'Who uses encrypt' },
    { id: 'u9', category: 'usage', query: 'formatDate', relevantIds: ['function:/src/utils/date.ts:formatDate', 'function:/src/formatters/output.ts:formatTimestamp'], description: 'Who uses formatDate' },
    { id: 'u10', category: 'usage', query: 'AppError', relevantIds: ['class:/src/errors/AppError.ts:AppError'], description: 'Who uses AppError' },
  ];
  
  const failures: FailureAnalysis[] = [];
  
  console.log('========================================');
  console.log('Usage Query Failure Diagnosis');
  console.log('========================================\n');
  
  for (const q of usageQueries) {
    const ftsResults = await backend.ftsSearch(q.query, 20);
    
    const retrievedIds = ftsResults.map(r => r.nodeId || r.id || '');
    const missedIds = q.relevantIds.filter(id => !retrievedIds.includes(id));
    
    const top10 = ftsResults.slice(0, 10).map(r => ({
      id: r.nodeId || r.id || '',
      name: r.name || 'unknown',
      score: r.score,
    }));
    
    // Determine failure type
    let failureType: FailureAnalysis['failureType'] = 'ranking';
    let diagnosis = '';
    
    if (missedIds.length === q.relevantIds.length) {
      // Check if the relevant symbol exists at all
      const symbolExists = ftsResults.some(r => 
        q.relevantIds.includes(r.nodeId || r.id || '')
      );
      
      if (!symbolExists) {
        failureType = 'not_indexed';
        diagnosis = `Symbol not indexed. Expected: ${q.relevantIds.join(', ')}`;
      } else {
        failureType = 'missing_callsite';
        diagnosis = `Symbol found but callers not in top 10. Callers: ${missedIds.join(', ')}`;
      }
    } else if (missedIds.length > 0) {
      // Partial match - some relevant found, some missed
      const foundCallers = q.relevantIds.filter(id => retrievedIds.includes(id));
      
      if (foundCallers.some(id => id.includes('login') || id.includes('UserRepository') || id.includes('fetchData'))) {
        failureType = 'ranking';
        diagnosis = `Caller found but ranked too low. Found at position ${retrievedIds.findIndex(id => missedIds.includes(id))}`;
      } else {
        failureType = 'missing_callsite';
        diagnosis = `Definition found but callers not indexed. Missing: ${missedIds.join(', ')}`;
      }
    }
    
    // Check graph expansion
    const processed = processQuery(q.query);
    if (processed.intent === 'usage') {
      diagnosis += ` | Intent: usage, includeCallers: ${processed.routingHints.includeCallers}`;
    }
    
    failures.push({
      queryId: q.id,
      query: q.query,
      relevantIds: q.relevantIds,
      retrievedIds,
      missedIds,
      top10Results: top10,
      failureType,
      diagnosis,
    });
    
    // Print details
    console.log(`\n--- Query: ${q.id} (${q.query}) ---`);
    console.log(`Expected: ${q.relevantIds.join(', ')}`);
    console.log(`Found: ${retrievedIds.slice(0, 5).join(', ')}...`);
    console.log(`Missed: ${missedIds.join(', ')}`);
    console.log(`Failure: ${failureType}`);
    console.log(`Diagnosis: ${diagnosis}`);
    console.log(`\nTop 10:`);
    top10.forEach((r, i) => {
      const isRelevant = q.relevantIds.includes(r.id) ? '✓' : ' ';
      console.log(`  ${i + 1}. [${isRelevant}] ${r.name} (${r.score.toFixed(3)})`);
    });
  }
  
  // Summary
  console.log('\n\n========================================');
  console.log('Failure Summary');
  console.log('========================================');
  
  const byType = failures.reduce((acc, f) => {
    acc[f.failureType] = (acc[f.failureType] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  
  console.log('\nBy failure type:');
  Object.entries(byType).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
  });
  
  const recallAt10 = failures.reduce((sum, f) => {
    const found = f.relevantIds.filter(id => f.top10Results.some(r => r.id === id)).length;
    return sum + found / f.relevantIds.length;
  }, 0) / failures.length;
  
  console.log(`\nRecall@10: ${(recallAt10 * 100).toFixed(1)}%`);
  
  await backend.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function setupCorpus(backend: SQLiteBackend): Promise<void> {
  const graph = new KnowledgeGraph();
  
  // Auth module
  const authenticate = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'authenticate',
    filePath: '/src/auth/authenticate.ts',
    content: 'async function authenticate(user, pass) { return verify(user, pass); }',
    language: 'typescript',
  });
  const login = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'login',
    filePath: '/src/routes/login.ts',
    content: 'async function login(req, res) { const token = await authenticate(req.user, req.pass); res.json({ token }); }',
    language: 'typescript',
  });
  
  // DB module
  const dbConnection = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'DatabaseConnection',
    filePath: '/src/db/DatabaseConnection.ts',
    content: 'class DatabaseConnection { async query(sql) { return this.pool.execute(sql); } }',
    language: 'typescript',
  });
  const userRepo = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'UserRepository',
    filePath: '/src/repositories/UserRepository.ts',
    content: 'class UserRepository { constructor(private db: DatabaseConnection) {} async findById(id) { return this.db.query(`SELECT * FROM users WHERE id = ?`); } }',
    language: 'typescript',
  });
  
  // HTTP module
  const httpClient = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'HttpClient',
    filePath: '/src/http/HttpClient.ts',
    content: 'class HttpClient { async get(url) { return fetch(url); } async post(url, body) { return fetch(url, { method: "POST", body }); } }',
    language: 'typescript',
  });
  const fetchData = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'fetchData',
    filePath: '/src/services/ExternalService.ts',
    content: 'async function fetchData(endpoint) { const client = new HttpClient(); return client.get(endpoint); }',
    language: 'typescript',
  });
  
  // Cache module
  const cacheManager = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'CacheManager',
    filePath: '/src/cache/CacheManager.ts',
    content: 'class CacheManager { async get(key) { return this.store.get(key); } async set(key, value) { return this.store.set(key, value); } }',
    language: 'typescript',
  });
  const getCached = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'getCached',
    filePath: '/src/services/CachedService.ts',
    content: 'async function getCached(key, fetcher) { const cache = new CacheManager(); const cached = await cache.get(key); if (cached) return cached; const value = await fetcher(); await cache.set(key, value); return value; }',
    language: 'typescript',
  });
  
  // Logging module
  const logger = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'Logger',
    filePath: '/src/logging/Logger.ts',
    content: 'class Logger { info(msg) { console.log("[INFO]", msg); } error(msg) { console.error("[ERROR]", msg); } }',
    language: 'typescript',
  });
  
  // Config module
  const parseConfig = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'parseConfig',
    filePath: '/src/config/parser.ts',
    content: 'function parseConfig(path) { const content = fs.readFileSync(path); return JSON.parse(content); }',
    language: 'typescript',
  });
  const initialize = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'initialize',
    filePath: '/src/app.ts',
    content: 'async function initialize() { const config = parseConfig("./config.json"); await connectDB(config.db); }',
    language: 'typescript',
  });
  
  // Validation module
  const validateInput = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'validateInput',
    filePath: '/src/validation/validate.ts',
    content: 'function validateInput(data, schema) { return schema.validate(data); }',
    language: 'typescript',
  });
  const handleRequest = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'handleRequest',
    filePath: '/src/routes/api.ts',
    content: 'async function handleRequest(req, res) { const valid = validateInput(req.body, requestSchema); if (!valid) return res.status(400).json({ error: "Invalid input" }); }',
    language: 'typescript',
  });
  
  // Crypto module
  const encrypt = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'encrypt',
    filePath: '/src/crypto/encrypt.ts',
    content: 'function encrypt(data, key) { return crypto.createCipher("aes-256-gcm", key).update(data, "utf8", "hex"); }',
    language: 'typescript',
  });
  const hashPassword = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'hashPassword',
    filePath: '/src/auth/password.ts',
    content: 'async function hashPassword(password) { const salt = generateSalt(); return encrypt(password, salt); }',
    language: 'typescript',
  });
  
  // Utils module
  const formatDate = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'formatDate',
    filePath: '/src/utils/date.ts',
    content: 'function formatDate(date, format = "YYYY-MM-DD") { return moment(date).format(format); }',
    language: 'typescript',
  });
  const formatTimestamp = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'formatTimestamp',
    filePath: '/src/formatters/output.ts',
    content: 'function formatTimestamp(timestamp) { return formatDate(new Date(timestamp), "YYYY-MM-DD HH:mm:ss"); }',
    language: 'typescript',
  });
  
  // Errors module
  const appError = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'AppError',
    filePath: '/src/errors/AppError.ts',
    content: 'class AppError extends Error { constructor(message, code) { super(message); this.code = code; } }',
    language: 'typescript',
  });
  
  // Add all nodes
  const allNodes = [
    authenticate, login,
    dbConnection, userRepo,
    httpClient, fetchData,
    cacheManager, getCached,
    logger,
    parseConfig, initialize,
    validateInput, handleRequest,
    encrypt, hashPassword,
    formatDate, formatTimestamp,
    appError,
  ];
  
  for (const node of allNodes) {
    graph.addNode(node);
  }
  
  // Add CALLS relationships
  graph.addRelationship(new GraphRelationship({ type: 'CALLS' as any, source: login.id, target: authenticate.id }));
  graph.addRelationship(new GraphRelationship({ type: 'USES_TYPE' as any, source: userRepo.id, target: dbConnection.id }));
  graph.addRelationship(new GraphRelationship({ type: 'INSTANTIATES' as any, source: fetchData.id, target: httpClient.id }));
  graph.addRelationship(new GraphRelationship({ type: 'INSTANTIATES' as any, source: getCached.id, target: cacheManager.id }));
  graph.addRelationship(new GraphRelationship({ type: 'CALLS' as any, source: initialize.id, target: parseConfig.id }));
  graph.addRelationship(new GraphRelationship({ type: 'CALLS' as any, source: handleRequest.id, target: validateInput.id }));
  graph.addRelationship(new GraphRelationship({ type: 'CALLS' as any, source: hashPassword.id, target: encrypt.id }));
  graph.addRelationship(new GraphRelationship({ type: 'CALLS' as any, source: formatTimestamp.id, target: formatDate.id }));
  
  await backend.bulkLoad(graph);
}

diagnoseUsageFailures().catch(console.error);
