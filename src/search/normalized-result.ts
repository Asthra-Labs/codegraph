/**
 * Normalized Search Result - Canonical schema for active-path search results
 * 
 * This type serves as the stable contract between:
 * - hybrid.ts (search pipeline)
 * - reranker.ts (heuristic reranking)
 * - shared-reranker.ts (future model reranking)
 * - xyne-cli formatters
 * 
 * Design principles:
 * 1. Required fields must be present or result is dropped
 * 2. Optional fields may be undefined but have clear semantics
 * 3. Provenance fields enable debugging and weight tuning
 * 4. Validation rules enforce strong symbol identity
 */

/** Source of the search result */
export type ResultSource = 'graph' | 'retrieval' | 'both';

/** Specific retrieval method that produced this result */
export type RetrievalKind = 
  | 'graph_fts'      // Graph full-text search (BM25)
  | 'graph_vec'      // Graph vector similarity search
  | 'retrieval_fts'  // Retrieval document full-text search
  | 'retrieval_vec'  // Retrieval document vector search
  | 'call_graph';    // Graph expansion (caller/callee)

/** Metadata for normalized search results */
export interface NormalizedResultMetadata {
  /** Whether this result represents a code symbol (function, class, etc.) */
  isSymbol?: boolean;
  
  /** Programming language detected from file extension */
  language?: string;
  
  /** Chunk identifier for retrieval documents */
  chunkId?: string;
  
  /** Original score before any normalization/reranking */
  originalScore?: number;
  
  /** Raw source IDs that contributed to this result (for provenance) */
  rawSourceIds?: string[];
  
  /** Class or module context for the symbol */
  className?: string;
  
  /** File type classification */
  fileType?: 'code' | 'config' | 'docs' | 'test' | 'lock' | 'default';
  
  /** Whether this result came from graph expansion */
  fromExpansion?: boolean;
  
  /** Depth in call graph if from expansion */
  expansionDepth?: number;
}

/**
 * Canonical normalized search result
 * 
 * All search paths should normalize to this type before:
 * - Reranking
 * - Formatting
 * - Return to callers
 */
export interface NormalizedSearchResult {
  // ==================== REQUIRED FIELDS ====================
  // These must be present or the result is dropped during validation
  
  /** Unique identifier for this result (typically nodeId or docId) */
  id: string;
  
  /** File path (absolute or relative to repo root) */
  filePath: string;
  
  /** Relevance score [0-1 range recommended, but not enforced] */
  score: number;
  
  // ==================== SYMBOL FIELDS (optional) ====================
  // Present when result represents a code symbol
  
  /** Unique symbol identifier in the graph */
  symbolId?: string;
  
  /** Symbol name (function, class, method, variable name) */
  symbolName?: string;
  
  /** Symbol kind (FUNCTION, CLASS, METHOD, VARIABLE, etc.) */
  symbolKind?: string;
  
  /** Function/method signature */
  signature?: string;
  
  /** Starting line number in the file */
  startLine?: number;
  
  /** Ending line number in the file */
  endLine?: number;
  
  // ==================== CONTENT FIELDS (optional) ====================
  
  /** Full content of the result (may be truncated for large files) */
  content?: string;
  
  /** Short preview/snippet of the content */
  snippet?: string;
  
  // ==================== PROVENANCE FIELDS ====================
  
  /** Primary source of this result */
  source: ResultSource;
  
  /** Specific retrieval method that produced this result */
  retrievalKind?: RetrievalKind;
  
  /** Additional metadata */
  metadata?: NormalizedResultMetadata;
  
  // ==================== SCORE FIELDS (for reranking) ====================
  
  /** Original RRF fusion score (before reranking) */
  rrfScore?: number;
  
  /** Score from reranking step */
  rerankScore?: number;
  
  /** Final blended score used for ranking */
  finalScore?: number;
}

/**
 * Score information for a normalized result
 * Used for blended scoring between RRF and rerank scores
 */
export interface ScoreInfo {
  /** Raw score from search */
  rawScore: number;
  
  /** RRF fusion score */
  rrfScore: number;
  
  /** Reranker score (if reranking was applied) */
  rerankScore?: number;
  
  /** Final blended score */
  finalScore: number;
}

/**
 * Options for normalizing search results
 */
export interface NormalizationOptions {
  /** Whether to include full content in results */
  includeContent?: boolean;
  
  /** Maximum snippet length */
  maxSnippetLength?: number;
  
  /** Whether to derive isSymbol from weak indicators */
  inferSymbolFromMetadata?: boolean;
}

/**
 * Default normalization options
 */
export const DEFAULT_NORMALIZATION_OPTIONS: NormalizationOptions = {
  includeContent: true,
  maxSnippetLength: 500,
  inferSymbolFromMetadata: true,
};

/**
 * Type guard to check if a result has strong symbol identity
 */
export function hasStrongSymbolIdentity(result: Partial<NormalizedSearchResult> | null | undefined): boolean {
  if (!result) return false;
  
  return (
    !!result.symbolId ||
    (!!result.symbolName && !!result.filePath && typeof result.startLine === 'number') ||
    (!!result.symbolKind && !!result.symbolName && !!result.filePath && result.symbolKind !== 'FILE')
  );
}

/**
 * Type guard for valid normalized result
 */
export function isValidNormalizedResult(result: unknown): result is NormalizedSearchResult {
  if (!result || typeof result !== 'object') {
    return false;
  }
  
  const r = result as Partial<NormalizedSearchResult>;
  
  // Required fields must be present and valid
  if (typeof r.id !== 'string' || r.id.length === 0) {
    return false;
  }
  
  if (typeof r.filePath !== 'string' || r.filePath.length === 0) {
    return false;
  }
  
  if (typeof r.score !== 'number' || !Number.isFinite(r.score)) {
    return false;
  }
  
  // Source must be valid
  if (!['graph', 'retrieval', 'both'].includes(r.source || '')) {
    return false;
  }
  
  return true;
}
