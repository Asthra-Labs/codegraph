export { hybridSearch, codeAwareSearch, reciprocalRankFusion } from './hybrid.js';
export type { HybridSearchOptions, HybridSearchResult } from './hybrid.js';

export { unifiedSearch } from './unified-search.js';
export type { UnifiedSearchOptions, UnifiedSearchResult } from './unified-search.js';

// Canonical normalized result schema
export {
  hasStrongSymbolIdentity,
  isValidNormalizedResult,
  DEFAULT_NORMALIZATION_OPTIONS,
} from './normalized-result.js';
export type {
  NormalizedSearchResult,
  NormalizedResultMetadata,
  NormalizationOptions,
  ScoreInfo,
  ResultSource,
  RetrievalKind,
} from './normalized-result.js';

// Result normalization
export {
  normalizeGraphResult,
  normalizeRetrievalResult,
  normalizeUnknownResult,
  normalizeResults,
  normalizeAnyResult,
  normalizedToSearchResult,
  normalizedToSearchResults,
} from './result-normalizer.js';
export type { RawSearchResult } from './result-normalizer.js';

// Search telemetry
export {
  DEFAULT_TELEMETRY,
  DEFAULT_DEBUG_OPTIONS,
  TelemetryCollector,
  isDebugEnabled,
  formatTelemetry,
  logTelemetry,
} from './search-telemetry.js';
export type {
  SearchTelemetry,
  SearchPhaseTimings,
  SearchResultCounts,
  RerankingDetails,
  RerankMethod,
  TelemetryOptions,
  DebugLogOptions,
} from './search-telemetry.js';

// Shared reranker
export {
  heuristicRerank,
  rerankResults,
  toRerankInput,
  blendScores,
  blendScoresBatch,
  DEFAULT_RERANK_OPTIONS,
  DEFAULT_HEURISTIC_WEIGHTS,
  getModelRerankerStatus,
  setModelRerankerStatus,
} from './shared-reranker.js';
export type {
  RerankInput,
  RerankOutput,
  RerankOptions,
  HeuristicRerankOptions,
  ModelRerankerInfo,
} from './shared-reranker.js';

// Model reranker adapter (Qwen3-Reranker-0.6B)
export {
  runModelRerank,
  checkModelRerankerAvailable,
  getModelRerankerStatusSync,
  DEFAULT_MODEL_RERANK_MODEL,
  DEFAULT_MODEL_RERANK_BATCH_SIZE,
} from './model-reranker.js';
export type {
  ModelRerankInput,
  ModelRerankOutput,
  ModelRerankOptions,
  ModelRerankerStatus,
} from './model-reranker.js';

// Legacy reranker (from store.ts) - use shared-reranker.js for new code
export {
  simpleRerank,
  createRerankInput,
  createRerankInputs,
  DEFAULT_RERANKER_OPTIONS,
} from './reranker.js';
export type { RerankResult, RerankerOptions } from './reranker.js';

export {
  processQuery,
  extractIdentifiers,
  DEFAULT_PROCESSING_OPTIONS,
} from './query-processor.js';
export type {
  ProcessedQuery,
  QueryIntent,
  RoutingHints,
  QueryProcessingOptions,
} from './query-processor.js';

// Query type detection for rerank policy
export {
  detectQueryType,
  getRerankMethodForQueryType,
  selectRerankMethod,
  DEFAULT_RERANK_POLICY,
} from './query-type-detector.js';
export type {
  QueryType,
  DetectionConfidence,
  QueryTypeDetection,
  RerankPolicy,
} from './query-type-detector.js';

export {
  expandGraphNeighbors,
  computeGraphBoosts,
  applyGraphExpansion,
  getCallers,
  getCallees,
  getImportedNodes,
  getInheritanceChain,
  DEFAULT_EXPANSION_OPTIONS,
} from './graph-expansion.js';
export type {
  GraphExpansionOptions,
  ExpandedNode,
  GraphBoostResult,
} from './graph-expansion.js';
