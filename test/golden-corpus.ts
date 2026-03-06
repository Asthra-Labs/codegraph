/**
 * Golden Corpus for Quality Evaluation
 * 
 * This is a frozen snapshot of the test corpus used for regression testing.
 * DO NOT MODIFY without updating the golden results.
 * 
 * Last updated: 2026-03-05
 * Usage Recall@10: 100%
 * Overall Recall@10: 77%
 */

import { GraphNode, GraphRelationship, NodeLabel } from '../src/graph/index.js';

export interface GoldenCorpus {
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  evalQueries: EvalQuery[];
  goldenResults: GoldenResults;
}

export interface EvalQuery {
  id: string;
  category: string;
  query: string;
  relevantIds: string[];
  description: string;
}

export interface GoldenResults {
  exact_symbol: { recallAt10: number; mrrAt10: number; ndcgAt10: number };
  semantic_behavior: { recallAt10: number; mrrAt10: number; ndcgAt10: number };
  usage: { recallAt10: number; mrrAt10: number; ndcgAt10: number };
  navigation: { recallAt10: number; mrrAt10: number; ndcgAt10: number };
  large_chunk: { recallAt10: number; mrrAt10: number; ndcgAt10: number };
  overall: { recallAt10: number; mrrAt10: number; ndcgAt10: number };
}

export function createGoldenCorpus(): GoldenCorpus {
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];

  // Auth module
  const authenticate = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'authenticate',
    filePath: '/src/auth/authenticate.ts',
    content: 'async function authenticate(user, pass) { return verify(user, pass); }',
    language: 'typescript',
  });
  const authService = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'AuthService',
    filePath: '/src/auth/AuthService.ts',
    content: 'class AuthService { async login(u, p) { return authenticate(u, p); } }',
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
  const connectionPool = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'ConnectionPool',
    filePath: '/src/db/ConnectionPool.ts',
    content: 'class ConnectionPool { acquire() { return this.pool.pop(); } release(conn) { this.pool.push(conn); } }',
    language: 'typescript',
  });
  const userRepository = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'UserRepository',
    filePath: '/src/repositories/UserRepository.ts',
    content: 'class UserRepository { constructor(private db: DatabaseConnection) {} }',
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
  const makeRequest = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'makeRequest',
    filePath: '/src/http/request.ts',
    content: 'async function makeRequest(url, options) { return fetch(url, options); }',
    language: 'typescript',
  });
  const fetchData = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'fetchData',
    filePath: '/src/services/ExternalService.ts',
    content: 'async function fetchData(url) { const client = new HttpClient(); return client.get(url); }',
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
  const cacheGet = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'cacheGet',
    filePath: '/src/cache/get.ts',
    content: 'async function cacheGet(key) { return cache.get(key); }',
    language: 'typescript',
  });
  const getCached = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'getCached',
    filePath: '/src/services/CachedService.ts',
    content: 'async function getCached(key) { const cache = new CacheManager(); return cache.get(key); }',
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
  const handleError = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'handleError',
    filePath: '/src/errors/handleError.ts',
    content: 'function handleError(err) { if (err instanceof AppError) { return { code: err.code, message: err.message }; } return { code: 500, message: "Unknown error" }; }',
    language: 'typescript',
  });
  const throwIfInvalid = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'throwIfInvalid',
    filePath: '/src/errors/validators.ts',
    content: 'function throwIfInvalid(val) { if (!val) throw new AppError("Invalid"); }',
    language: 'typescript',
  });

  // Config module
  const config = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'Config',
    filePath: '/src/config/Config.ts',
    content: 'class Config { constructor(private data) {} get(key) { return this.data[key]; } }',
    language: 'typescript',
  });
  const parseConfig = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'parseConfig',
    filePath: '/src/config/parser.ts',
    content: 'function parseConfig(path) { const content = fs.readFileSync(path); return JSON.parse(content); }',
    language: 'typescript',
  });
  const initializeApp = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'initializeApp',
    filePath: '/src/app.ts',
    content: 'async function initializeApp() { const config = parseConfig("./config.json"); }',
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
  const validateSchema = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'validateSchema',
    filePath: '/src/validation/schemas.ts',
    content: 'function validateSchema(data, schema) { for (const field of schema.fields) { if (!data[field]) return false; } return true; }',
    language: 'typescript',
  });
  const handleApiRequest = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'handleApiRequest',
    filePath: '/src/routes/api.ts',
    content: 'async function handleApiRequest(req) { validateInput(req.body, schema); }',
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
  const logDebug = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'logDebug',
    filePath: '/src/logging/log.ts',
    content: 'function logDebug(msg) { Logger.info(msg); }',
    language: 'typescript',
  });
  const logRequest = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'logRequest',
    filePath: '/src/middleware/logging.ts',
    content: 'function logRequest(req, res, next) { Logger.info(req.path); next(); }',
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
  const decrypt = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'decrypt',
    filePath: '/src/crypto/decrypt.ts',
    content: 'function decrypt(data, key) { return crypto.createDecipher("aes-256-gcm", key).update(data, "hex", "utf8"); }',
    language: 'typescript',
  });
  const hashPassword = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'hashPassword',
    filePath: '/src/auth/password.ts',
    content: 'async function hashPassword(pwd) { return encrypt(pwd, salt); }',
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
  const parseTime = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'parseTime',
    filePath: '/src/utils/time.ts',
    content: 'function parseTime(str) { return new Date(str).getTime(); }',
    language: 'typescript',
  });
  const formatTimestamp = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'formatTimestamp',
    filePath: '/src/formatters/output.ts',
    content: 'function formatTimestamp(ts) { return formatDate(new Date(ts)); }',
    language: 'typescript',
  });

  // Services module
  const userService = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'UserService',
    filePath: '/src/services/UserService.ts',
    content: 'class UserService { async getUser(id) { return this.db.find(id); } async createUser(data) { return this.db.create(data); } }',
    language: 'typescript',
  });

  // Large chunk module - synthetic large function for chunk testing
  const largeDataProcessor = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'processLargeDataset',
    filePath: '/src/processors/dataProcessor.ts',
    content: `/**
 * Process large dataset with multiple stages
 * Handles data validation, transformation, and persistence
 */
async function processLargeDataset(rawData: RawData[], options: ProcessOptions): Promise<ProcessResult> {
  // Stage 1: Validate input data
  const validatedData: ValidatedData[] = [];
  const validationErrors: ValidationError[] = [];
  
  for (const item of rawData) {
    try {
      const schema = await loadValidationSchema(item.type);
      const validated = await validateAgainstSchema(item, schema);
      if (validated.isValid) {
        validatedData.push(validated.data);
      } else {
        validationErrors.push({ item, errors: validated.errors });
      }
    } catch (err) {
      validationErrors.push({ item, errors: [err.message] });
    }
  }

  if (validationErrors.length > options.maxErrors) {
    throw new ValidationError(\`Too many validation errors: \${validationErrors.length}\`);
  }

  // Stage 2: Transform data
  const transformedData: TransformedData[] = [];
  const transformer = createTransformer(options.transformConfig);
  
  for (const item of validatedData) {
    const transformed = await transformer.transform(item);
    if (transformed.needsEnrichment) {
      const enriched = await enrichData(transformed, options.enrichmentSources);
      transformedData.push(enriched);
    } else {
      transformedData.push(transformed);
    }
  }

  // Stage 3: Apply business rules
  const processedData: ProcessedData[] = [];
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
    retryAttempts: 3,
    onBatchComplete: (batch) => {
      logger.info(\`Batch \${batch.index} completed: \${batch.count} items\`);
    }
  });

  // Stage 5: Generate report
  const report = await generateReport({
    input: rawData.length,
    validated: validatedData.length,
    transformed: transformedData.length,
    processed: processedData.length,
    persisted: persistenceResult.saved,
    errors: validationErrors,
    duration: Date.now() - startTime
  });

  return { report, persistenceResult, validationErrors };
}`,
    language: 'typescript',
  });

  const businessRuleEngine = new GraphNode({
    label: NodeLabel.CLASS,
    name: 'BusinessRuleEngine',
    filePath: '/src/rules/BusinessRuleEngine.ts',
    content: `class BusinessRuleEngine {
  constructor(private rules: Rule[]) {}
  
  async apply(data: any): Promise<RuleResult> {
    for (const rule of this.rules) {
      const result = await rule.evaluate(data);
      if (!result.passed) {
        return { passed: false, violations: result.violations, canAutoFix: rule.canAutoFix };
      }
    }
    return { passed: true };
  }
  
  async autoFix(data: any, violations: Violation[]): Promise<any> {
    let fixed = { ...data };
    for (const violation of violations) {
      if (violation.autoFix) {
        fixed = await violation.autoFix(fixed);
      }
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
    content: `async function persistBatch(items: any[], config: PersistConfig): Promise<PersistResult> {
  const batches = chunk(items, config.batchSize);
  const results = await Promise.all(
    batches.map((batch, i) => retry(() => saveBatch(batch), config.retryAttempts))
  );
  return { saved: results.reduce((s, r) => s + r.saved, 0) };
}`,
    language: 'typescript',
  });

  // Add all nodes
  nodes.push(
    authenticate, authService, login,
    dbConnection, connectionPool, userRepository,
    httpClient, makeRequest, fetchData,
    cacheManager, cacheGet, getCached,
    appError, handleError, throwIfInvalid,
    config, parseConfig, initializeApp,
    validateInput, validateSchema, handleApiRequest,
    logger, logDebug, logRequest,
    encrypt, decrypt, hashPassword,
    formatDate, parseTime, formatTimestamp,
    userService,
    largeDataProcessor, businessRuleEngine, persistBatch
  );

  // Add relationships
  relationships.push(new GraphRelationship({ type: 'CALLS' as any, source: login.id, target: authenticate.id }));
  relationships.push(new GraphRelationship({ type: 'IMPORTS' as any, source: authService.id, target: authenticate.id }));
  relationships.push(new GraphRelationship({ type: 'USES_TYPE' as any, source: userRepository.id, target: dbConnection.id }));
  relationships.push(new GraphRelationship({ type: 'INSTANTIATES' as any, source: fetchData.id, target: httpClient.id }));
  relationships.push(new GraphRelationship({ type: 'INSTANTIATES' as any, source: getCached.id, target: cacheManager.id }));
  relationships.push(new GraphRelationship({ type: 'USES_TYPE' as any, source: logRequest.id, target: logger.id }));
  relationships.push(new GraphRelationship({ type: 'CALLS' as any, source: initializeApp.id, target: parseConfig.id }));
  relationships.push(new GraphRelationship({ type: 'CALLS' as any, source: handleApiRequest.id, target: validateInput.id }));
  relationships.push(new GraphRelationship({ type: 'CALLS' as any, source: hashPassword.id, target: encrypt.id }));
  relationships.push(new GraphRelationship({ type: 'CALLS' as any, source: formatTimestamp.id, target: formatDate.id }));
  relationships.push(new GraphRelationship({ type: 'USES_TYPE' as any, source: throwIfInvalid.id, target: appError.id }));

  const evalQueries: EvalQuery[] = [
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
    
    // Large Chunk (5 queries) - targeting mid-function behavior
    { id: 'lc1', category: 'large_chunk', query: 'transform data', relevantIds: ['function:/src/processors/dataProcessor.ts:processLargeDataset'], description: 'Find data transformation logic in large function' },
    { id: 'lc2', category: 'large_chunk', query: 'business rules apply', relevantIds: ['function:/src/processors/dataProcessor.ts:processLargeDataset', 'class:/src/rules/BusinessRuleEngine.ts:BusinessRuleEngine'], description: 'Find business rule application' },
    { id: 'lc3', category: 'large_chunk', query: 'persist batch save', relevantIds: ['function:/src/processors/dataProcessor.ts:processLargeDataset', 'function:/src/persistence/batch.ts:persistBatch'], description: 'Find persistence logic' },
    { id: 'lc4', category: 'large_chunk', query: 'validate input schema', relevantIds: ['function:/src/processors/dataProcessor.ts:processLargeDataset'], description: 'Find validation stage in processor' },
    { id: 'lc5', category: 'large_chunk', query: 'auto fix violations', relevantIds: ['class:/src/rules/BusinessRuleEngine.ts:BusinessRuleEngine'], description: 'Find auto-fix logic in business rules' },
  ];

  const goldenResults: GoldenResults = {
    exact_symbol: { recallAt10: 1.00, mrrAt10: 1.00, ndcgAt10: 1.00 },
    semantic_behavior: { recallAt10: 0.90, mrrAt10: 0.85, ndcgAt10: 0.86 },
    usage: { recallAt10: 1.00, mrrAt10: 1.00, ndcgAt10: 0.99 },
    navigation: { recallAt10: 1.00, mrrAt10: 1.00, ndcgAt10: 1.00 },
    large_chunk: { recallAt10: 0.80, mrrAt10: 0.75, ndcgAt10: 0.77 },
    overall: { recallAt10: 0.94, mrrAt10: 0.92, ndcgAt10: 0.93 },
  };

  return { nodes, relationships, evalQueries, goldenResults };
}

export const CI_THRESHOLDS = {
  usage: {
    recallAt10: 0.95,  // Usage Recall@10 must be >= 95%
    description: 'Usage queries require proper graph relationships for callers',
  },
  exact_symbol: {
    recallAt10: 0.90,  // Exact symbol lookup should be >= 90%
    description: 'Exact symbol queries should be highly reliable',
  },
  overall: {
    recallAt10: 0.70,  // Overall should be >= 70%
    description: 'Overall retrieval quality threshold',
  },
  coverage: {
    minNodes: 10,
    minEdges: 5,
    minCallsEdges: 3,
    minNodesWithInboundCalls: 10,  // percentage
    minNodesWithOutboundCalls: 10,  // percentage
    minRelationshipTypes: 2,
    description: 'Graph coverage thresholds for relationship extraction',
  },
};
