/**
 * Query Type Detector
 * 
 * Classifies search queries into types for rerank method selection.
 * Used by the query-dependent rerank policy to select optimal backend.
 * 
 * Design principles:
 * - Conservative: prefer 'semantic' or 'unknown' over false positives
 * - Fast: O(1) regex-based, no LLM calls
 * - Observable: returns confidence and reason for telemetry
 */

/** Query type classification */
export type QueryType = 'exact_identifier' | 'semantic' | 'bug_error' | 'unknown';

/** Confidence level for detection */
export type DetectionConfidence = 'high' | 'medium' | 'low';

/** Result of query type detection */
export interface QueryTypeDetection {
  /** Detected query type */
  queryType: QueryType;
  
  /** Confidence level of detection */
  confidence: DetectionConfidence;
  
  /** Human-readable reason for the classification */
  reason: string;
}

/** Rerank method for each query type */
export type RerankMethod = 'model' | 'heuristic' | 'none';

/** Policy mapping query types to rerank methods */
export interface RerankPolicy {
  exact_identifier: RerankMethod;
  semantic: RerankMethod;
  bug_error: RerankMethod;
  unknown: RerankMethod;
}

/** Default rerank policy based on evaluation results */
export const DEFAULT_RERANK_POLICY: RerankPolicy = {
  exact_identifier: 'heuristic',  // Model adds latency with no benefit
  semantic: 'model',              // 3.5x MRR improvement
  bug_error: 'heuristic',         // Model adds latency with no benefit
  unknown: 'heuristic',           // Safe default
};

// ============================================================================
// Pattern definitions
// ============================================================================

/** Strong code identifier patterns (high confidence) */
const CODE_IDENTIFIER_STRONG = [
  // camelCase: lowercase start, followed by uppercase (e.g., hybridSearch, normalizeResults)
  /^[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*$/,
  // PascalCase: uppercase start, followed by uppercase (e.g., TelemetryCollector, HybridSearchResult)
  /^[A-Z][a-z]+[A-Z][a-zA-Z0-9]*$/,
  // snake_case with underscore: (e.g., hybrid_search, normalize_results)
  /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/,
  // SCREAMING_SNAKE_CASE: (e.g., MAX_RESULTS, DEFAULT_TIMEOUT)
  /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/,
  // Single ALL_CAPS word that looks like a constant
  /^[A-Z][A-Z0-9_]{2,}$/,
];

/** Medium confidence code patterns */
const CODE_IDENTIFIER_MEDIUM = [
  // Contains camelCase or PascalCase word within query
  /\b[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*\b/,
  /\b[A-Z][a-z]+[A-Z][a-zA-Z0-9]*\b/,
  // Path-like with extensions (e.g., "hybrid.ts", "src/search")
  /[a-zA-Z0-9_-]+\.[a-zA-Z]{1,4}$/,
  /[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+/,
  // Signature-like patterns (e.g., "function(arg1, arg2)", "className.methodName")
  /\w+\([^)]*\)/,
  /\w+\.\w+\([^)]*\)/,
  // snake_case identifier
  /\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b/,
];

/** Bug/error keywords (exact match required for high confidence) */
const BUG_ERROR_KEYWORDS_HIGH = [
  'error', 'exception', 'crash', 'fail', 'failed', 'failure',
  'timeout', 'timed out', 'bug', 'broken', 'panic',
];

/** Bug/error phrases for medium confidence */
const BUG_ERROR_PHRASES_MEDIUM = [
  /\b(error|exception|crash|fail(ure|ed)?|timeout|bug|broken|panic)\b/i,
  /not work(ing)?/i,
  /doesn'?t work/i,
  /something wrong/i,
  /unexpected behavior/i,
  /got (an? )?error/i,
];

/** Natural language indicators (suggest semantic) */
const NATURAL_LANGUAGE_INDICATORS = [
  // Question words
  /\b(how|what|why|when|where|which|who)\b/i,
  // Action verbs common in natural queries
  /\b(find|search|look|show|get|list|display|explain|describe)\b/i,
  // Prepositions and articles
  /\b(the|a|an|for|with|from|into|about)\b/i,
  // Common phrase patterns
  /\b(looking for|trying to|want to|need to|help me)\b/i,
];

// ============================================================================
// Detection functions
// ============================================================================

/**
 * Check if query matches code identifier patterns
 */
function checkCodeIdentifier(query: string): { matched: boolean; confidence: DetectionConfidence; reason: string } {
  const trimmed = query.trim();
  const normalized = trimmed.replace(/\s+/g, ' ');
  
  // Single token - check strong patterns
  if (!normalized.includes(' ')) {
    for (const pattern of CODE_IDENTIFIER_STRONG) {
      if (pattern.test(trimmed)) {
        return { 
          matched: true, 
          confidence: 'high', 
          reason: `Single token matches ${pattern.source.includes('A-Z') ? 'CamelCase/PascalCase' : 'snake_case'} pattern` 
        };
      }
    }
    
    // Single lowercase word - NOT an identifier (could be natural language)
    if (/^[a-z]+$/.test(trimmed)) {
      return { matched: false, confidence: 'low', reason: 'Single lowercase word' };
    }
    
    // Single PascalCase but very short (e.g., "Api", "Http") - low confidence
    if (/^[A-Z][a-z]{1,3}$/.test(trimmed)) {
      return { matched: false, confidence: 'low', reason: 'Short PascalCase, ambiguous' };
    }
  }
  
  // Multi-token - check medium patterns
  for (const pattern of CODE_IDENTIFIER_MEDIUM) {
    if (pattern.test(normalized)) {
      return { 
        matched: true, 
        confidence: 'medium', 
        reason: 'Contains code-like pattern (path, signature, or camelCase)' 
      };
    }
  }
  
  return { matched: false, confidence: 'low', reason: 'No code identifier patterns detected' };
}

/**
 * Check if query matches bug/error patterns
 */
function checkBugError(query: string): { matched: boolean; confidence: DetectionConfidence; reason: string } {
  const trimmed = query.trim().toLowerCase();
  
  // Check exact keyword matches (high confidence)
  for (const keyword of BUG_ERROR_KEYWORDS_HIGH) {
    if (trimmed === keyword || trimmed.startsWith(keyword + ' ') || trimmed.endsWith(' ' + keyword)) {
      return { matched: true, confidence: 'high', reason: `Exact error keyword: "${keyword}"` };
    }
  }
  
  // Check phrase patterns (medium confidence)
  for (const pattern of BUG_ERROR_PHRASES_MEDIUM) {
    if (pattern.test(query)) {
      return { matched: true, confidence: 'medium', reason: `Error-related phrase matched` };
    }
  }
  
  return { matched: false, confidence: 'low', reason: 'No error patterns detected' };
}

/**
 * Check if query has natural language characteristics
 */
function checkNaturalLanguage(query: string): { matched: boolean; confidence: DetectionConfidence; reason: string } {
  const trimmed = query.trim();
  const wordCount = trimmed.split(/\s+/).length;
  
  // Long queries are likely natural language
  if (wordCount >= 5) {
    return { matched: true, confidence: 'high', reason: `Long query (${wordCount} words)` };
  }
  
  // Check for natural language indicators
  for (const pattern of NATURAL_LANGUAGE_INDICATORS) {
    if (pattern.test(trimmed)) {
      return { matched: true, confidence: 'medium', reason: 'Contains natural language patterns' };
    }
  }
  
  // Multi-word query without code patterns
  if (wordCount >= 2 && !/[A-Z][a-z]+[A-Z]/.test(trimmed)) {
    return { matched: true, confidence: 'low', reason: 'Multi-word query without code patterns' };
  }
  
  return { matched: false, confidence: 'low', reason: 'No natural language indicators' };
}

/**
 * Detect query type for rerank method selection
 * 
 * @param query - The search query to classify
 * @returns QueryTypeDetection with type, confidence, and reason
 */
export function detectQueryType(query: string): QueryTypeDetection {
  if (!query || query.trim().length === 0) {
    return {
      queryType: 'unknown',
      confidence: 'low',
      reason: 'Empty or whitespace-only query',
    };
  }
  
  const trimmed = query.trim();
  
  // Priority 1: Check for code identifier patterns (most specific)
  const identifierResult = checkCodeIdentifier(trimmed);
  if (identifierResult.matched && identifierResult.confidence !== 'low') {
    return {
      queryType: 'exact_identifier',
      confidence: identifierResult.confidence,
      reason: identifierResult.reason,
    };
  }
  
  // Priority 2: Check for bug/error patterns
  const bugResult = checkBugError(trimmed);
  if (bugResult.matched && bugResult.confidence !== 'low') {
    return {
      queryType: 'bug_error',
      confidence: bugResult.confidence,
      reason: bugResult.reason,
    };
  }
  
  // Priority 3: Check for natural language patterns (semantic)
  const nlResult = checkNaturalLanguage(trimmed);
  if (nlResult.matched) {
    return {
      queryType: 'semantic',
      confidence: nlResult.confidence,
      reason: nlResult.reason,
    };
  }
  
  // Fallback: Check if identifier had low-confidence match
  if (identifierResult.matched) {
    return {
      queryType: 'exact_identifier',
      confidence: 'low',
      reason: identifierResult.reason,
    };
  }
  
  // Unknown - could be short query, ambiguous, or edge case
  return {
    queryType: 'unknown',
    confidence: 'low',
    reason: 'Ambiguous or unrecognized query pattern',
  };
}

/**
 * Get rerank method for a detected query type based on policy
 * 
 * @param queryType - The detected query type
 * @param policy - Optional custom policy (defaults to DEFAULT_RERANK_POLICY)
 * @returns The rerank method to use
 */
export function getRerankMethodForQueryType(
  queryType: QueryType,
  policy: RerankPolicy = DEFAULT_RERANK_POLICY
): RerankMethod {
  return policy[queryType];
}

/**
 * Select rerank method based on query type detection
 * 
 * This is the main entry point for query-dependent rerank selection.
 * It combines detection with policy lookup.
 * 
 * @param query - The search query
 * @param explicitMethod - If provided, skip detection and use this method
 * @param policy - Optional custom policy
 * @returns Detection result with selected rerank method
 */
export function selectRerankMethod(
  query: string,
  explicitMethod?: RerankMethod | 'auto',
  policy: RerankPolicy = DEFAULT_RERANK_POLICY
): QueryTypeDetection & { selectedMethod: RerankMethod } {
  // If explicit method provided and not 'auto', use it directly
  if (explicitMethod && explicitMethod !== 'auto') {
    return {
      queryType: 'unknown',
      confidence: 'high',
      reason: `Explicit method override: ${explicitMethod}`,
      selectedMethod: explicitMethod,
    };
  }
  
  // Detect query type and select method from policy
  const detection = detectQueryType(query);
  const selectedMethod = getRerankMethodForQueryType(detection.queryType, policy);
  
  return {
    ...detection,
    selectedMethod,
  };
}
