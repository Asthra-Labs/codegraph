export { hybridSearch, codeAwareSearch, reciprocalRankFusion } from './hybrid.js';
export type { HybridSearchOptions } from './hybrid.js';

export { unifiedSearch } from './unified-search.js';
export type { UnifiedSearchOptions, UnifiedSearchResult, ResultSource } from './unified-search.js';

export {
  simpleRerank,
  rerankResults,
  createRerankInput,
  createRerankInputs,
  DEFAULT_RERANKER_OPTIONS,
} from './reranker.js';
export type { RerankInput, RerankResult, RerankerOptions } from './reranker.js';

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
