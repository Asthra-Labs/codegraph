/**
 * Shared Reranker Abstraction
 * 
 * Provides a unified reranking interface for the active search path.
 * Supports both heuristic and model-based reranking with fallback.
 */

import type { NormalizedSearchResult } from './normalized-result.js';
import type { SearchTelemetry } from './search-telemetry.js';
import {
  runModelRerank,
  checkModelRerankerAvailable,
  DEFAULT_MODEL_RERANK_MODEL,
  DEFAULT_MODEL_RERANK_BATCH_SIZE,
  type ModelRerankInput,
  type ModelRerankOutput,
} from './model-reranker.js';

/** Reranking method */
export type RerankMethod = 'model' | 'heuristic' | 'none';

/** Input for reranking */
export interface RerankInput {
  id: string;
  filePath: string;
  symbolName: string;
  symbolKind: string;
  signature?: string;
  className?: string;
  content: string;
  score: number;
}

/** Output from reranking */
export interface RerankOutput {
  id: string;
  score: number;
}

const ARCHITECTURE_PATH_TERMS = ['factory', 'manager', 'registry', 'builder'];
const TEST_HINT_TERMS = ['test', 'tests', 'spec', 'integration', 'unit', 'e2e', 'regression'];

function isLikelyTestPath(filePathLower: string): boolean {
  return (
    filePathLower.includes('/test/') ||
    filePathLower.includes('/tests/') ||
    filePathLower.includes('__tests__') ||
    filePathLower.includes('.test.') ||
    filePathLower.includes('.spec.') ||
    /(^|[\\/._-])(test|spec)([\\/._-]|$)/.test(filePathLower)
  );
}

function queryTargetsTests(queryTerms: string[], queryLower: string): boolean {
  if (TEST_HINT_TERMS.some(term => queryTerms.includes(term))) {
    return true;
  }
  return /\btest(ing)?\b|\bspec(s)?\b/.test(queryLower);
}

/**
 * File-path prior used to improve exploration ranking quality.
 * - Down-ranks test files for implementation-oriented queries.
 * - Slightly boosts architecture-centric files (factory/manager/registry/builder).
 */
export function computePathPrior(filePath: string, query: string): number {
  const filePathLower = filePath.toLowerCase();
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(Boolean);

  let multiplier = 1.0;

  // Test-file penalty unless the query explicitly asks for tests/specs.
  if (isLikelyTestPath(filePathLower) && !queryTargetsTests(queryTerms, queryLower)) {
    multiplier *= 0.82;
  }

  // Light architecture-file prior to improve discovery of orchestration files.
  for (const term of ARCHITECTURE_PATH_TERMS) {
    if (!filePathLower.includes(term)) continue;
    multiplier *= queryTerms.includes(term) ? 1.25 : 1.15;
  }

  return Math.min(Math.max(multiplier, 0.65), 1.35);
}

/** Options for heuristic reranking */
export interface HeuristicRerankOptions {
  /** Weight for symbol name match */
  alpha?: number;
  /** Weight for signature match */
  beta?: number;
  /** Weight for file path match */
  gamma?: number;
  /** Weight for class name match */
  delta?: number;
  /** Weight for content match */
  epsilon?: number;
}

/** Default heuristic weights */
export const DEFAULT_HEURISTIC_WEIGHTS: Required<HeuristicRerankOptions> = {
  alpha: 0.30,   // symbol name
  beta: 0.25,    // signature
  gamma: 0.20,   // file path
  delta: 0.15,   // class name
  epsilon: 0.10, // content
};

/** Options for reranking */
export interface RerankOptions {
  /** Method to use: 'model', 'heuristic', or 'auto' */
  method?: RerankMethod | 'auto';
  
  /** Maximum candidates to rerank */
  topK?: number;
  
  /** Fall back to heuristic if model fails */
  fallbackToHeuristic?: boolean;
  
  /** Heuristic-specific weights */
  heuristicWeights?: HeuristicRerankOptions;
  
  /** Model name (for future use) */
  model?: string;
}

/** Default rerank options */
export const DEFAULT_RERANK_OPTIONS: Required<RerankOptions> = {
  method: 'auto',
  topK: 50,
  fallbackToHeuristic: true,
  heuristicWeights: DEFAULT_HEURISTIC_WEIGHTS,
  model: '',
};

/** Model reranker status */
export type ModelRerankerStatus = 
  | 'available'
  | 'not_loaded'
  | 'not_implemented'
  | 'error';

/** Model reranker info */
export interface ModelRerankerInfo {
  status: ModelRerankerStatus;
  modelName?: string;
  error?: string;
}

let _modelRerankerStatus: ModelRerankerInfo = { status: 'not_implemented' };
let _modelAvailabilityCache: { available: boolean; timestamp: number } | null = null;
const AVAILABILITY_CACHE_TTL_MS = 60000;

/** Check if model reranker is available */
export function getModelRerankerStatus(): ModelRerankerInfo {
  return _modelRerankerStatus;
}

/**
 * Check model availability with caching
 * This is CHEAP if cached, potentially EXPENSIVE on first call (model load check)
 */
async function checkModelAvailability(): Promise<boolean> {
  const now = Date.now();
  if (_modelAvailabilityCache && (now - _modelAvailabilityCache.timestamp) < AVAILABILITY_CACHE_TTL_MS) {
    return _modelAvailabilityCache.available;
  }
  
  const status = await checkModelRerankerAvailable();
  const available = status.available && status.status === 'ready';
  
  _modelAvailabilityCache = { available, timestamp: now };
  _modelRerankerStatus = {
    status: available ? 'available' : 'not_loaded',
    modelName: status.model,
    error: status.error,
  };
  
  return available;
}

/** Set model reranker status (for testing/override) */
export function setModelRerankerStatus(status: ModelRerankerInfo): void {
  _modelRerankerStatus = status;
  _modelAvailabilityCache = null;
}

/**
 * Convert RerankInput to ModelRerankInput format
 */
function toModelRerankInput(input: RerankInput): ModelRerankInput {
  return {
    id: input.id,
    filePath: input.filePath,
    symbolName: input.symbolName,
    symbolKind: input.symbolKind,
    signature: input.signature,
    className: input.className,
    content: input.content,
    score: input.score,
  };
}

/**
 * Try to use model reranker
 * Returns null if model unavailable or on error
 */
async function tryModelRerank(
  inputs: RerankInput[],
  query: string,
  options: { modelName?: string; topK?: number } = {}
): Promise<{ outputs: RerankOutput[]; modelUsed: string; modelLoadMs: number; inferenceMs: number } | null> {
  const loadStart = Date.now();
  const available = await checkModelAvailability();
  const modelLoadMs = Date.now() - loadStart;
  
  if (!available) {
    return null;
  }
  
  const modelInputs = inputs.map(toModelRerankInput);
  
  const inferenceStart = Date.now();
  const result = await runModelRerank(query, modelInputs, {
    topK: options.topK || DEFAULT_MODEL_RERANK_BATCH_SIZE,
    model: options.modelName || DEFAULT_MODEL_RERANK_MODEL,
  });
  const inferenceMs = Date.now() - inferenceStart;
  
  if (!result) {
    return null;
  }
  
  return {
    outputs: result.map(r => ({ id: r.id, score: r.score })),
    modelUsed: DEFAULT_MODEL_RERANK_MODEL,
    modelLoadMs,
    inferenceMs,
  };
}

/**
 * Convert NormalizedSearchResult to RerankInput
 */
export function toRerankInput(result: NormalizedSearchResult): RerankInput {
  return {
    id: result.id,
    filePath: result.filePath,
    symbolName: result.symbolName || '',
    symbolKind: result.symbolKind || '',
    signature: result.signature,
    className: result.metadata?.className,
    content: result.content || result.snippet || '',
    score: result.score,
  };
}

/**
 * Heuristic reranking based on query matching
 */
export function heuristicRerank(
  inputs: RerankInput[],
  query: string,
  options: HeuristicRerankOptions = {}
): RerankOutput[] {
  const weights = { ...DEFAULT_HEURISTIC_WEIGHTS, ...options };
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 0);

  const results = inputs.map(input => {
    let symbolNameScore = 0;
    let signatureScore = 0;
    let filePathScore = 0;
    let classNameScore = 0;
    let contentScore = 0;

    const symbolLower = input.symbolName.toLowerCase();
    const filePathLower = input.filePath.toLowerCase();
    const classNameLower = (input.className || '').toLowerCase();
    const contentLower = input.content.toLowerCase();

    // Symbol name: exact match or contains query
    if (symbolLower === queryLower) {
      symbolNameScore = 1.0;
    } else if (symbolLower.includes(queryLower)) {
      symbolNameScore = 0.8;
    } else {
      const matchedTerms = queryTerms.filter(t => symbolLower.includes(t)).length;
      symbolNameScore = matchedTerms / Math.max(queryTerms.length, 1) * 0.5;
    }

    // File path: contains query or terms
    if (filePathLower.includes(queryLower)) {
      filePathScore = 0.8;
    } else {
      const matchedTerms = queryTerms.filter(t => filePathLower.includes(t)).length;
      filePathScore = matchedTerms / Math.max(queryTerms.length, 1) * 0.4;
    }

    // Signature: contains query
    if (input.signature) {
      const sigLower = input.signature.toLowerCase();
      if (sigLower.includes(queryLower)) {
        signatureScore = 0.7;
      }
    }

    // Class name: exact or partial match
    if (classNameLower) {
      if (classNameLower === queryLower) {
        classNameScore = 0.9;
      } else if (classNameLower.includes(queryLower)) {
        classNameScore = 0.6;
      }
    }

    // Content: term frequency
    const contentMatches = queryTerms.reduce((sum, term) => {
      const count = (contentLower.match(new RegExp(term, 'g')) || []).length;
      return sum + Math.min(count, 5);
    }, 0);
    contentScore = Math.min(contentMatches / (queryTerms.length * 3), 1.0);

    const finalScore =
      weights.alpha * symbolNameScore +
      weights.beta * signatureScore +
      weights.gamma * filePathScore +
      weights.delta * classNameScore +
      weights.epsilon * contentScore;

    return {
      id: input.id,
      score: finalScore,
    };
  });

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Rerank normalized search results
 */
export async function rerankResults(
  results: NormalizedSearchResult[],
  query: string,
  options: RerankOptions = {}
): Promise<{ 
  results: NormalizedSearchResult[]; 
  method: RerankMethod; 
  fallbackReason?: string; 
  modelUsed?: string;
  modelLoadMs: number;
  inferenceMs: number;
}> {
  const opts = { ...DEFAULT_RERANK_OPTIONS, ...options };
  
  if (results.length === 0) {
    return { results, method: 'none', modelLoadMs: 0, inferenceMs: 0 };
  }

  const candidates = results.slice(0, opts.topK);
  const inputs = candidates.map(toRerankInput);
  const inputById = new Map(inputs.map(input => [input.id, input]));
  
  let method: RerankMethod = 'heuristic';
  let fallbackReason: string | undefined;
  let modelUsed: string | undefined;
  let modelLoadMs = 0;
  let inferenceMs = 0;
  let reranked: RerankOutput[];

  // Try model reranker if requested
  if (opts.method === 'model' || opts.method === 'auto') {
    const modelResult = await tryModelRerank(inputs, query, {
      modelName: opts.model,
      topK: opts.topK,
    });
    
    if (modelResult) {
      reranked = modelResult.outputs;
      method = 'model';
      modelUsed = modelResult.modelUsed;
      modelLoadMs = modelResult.modelLoadMs;
      inferenceMs = modelResult.inferenceMs;
    } else {
      // Model unavailable or failed
      if (!opts.fallbackToHeuristic && opts.method === 'model') {
        // Model explicitly requested, no fallback allowed
        return { 
          results, 
          method: 'none', 
          fallbackReason: 'Model reranker unavailable and fallbackToHeuristic=false',
          modelLoadMs: 0,
          inferenceMs: 0,
        };
      }
      // Will fall through to heuristic
      fallbackReason = 'Model reranker unavailable, falling back to heuristic';
    }
  }

  // Use heuristic reranker (either requested or as fallback)
  if (method !== 'model') {
    const heuristicStart = Date.now();
    reranked = heuristicRerank(inputs, query, opts.heuristicWeights);
    inferenceMs = Date.now() - heuristicStart;
    method = 'heuristic';
    // modelLoadMs stays 0 for heuristic
  }

  // Apply path priors after reranking so both heuristic and model paths benefit.
  reranked = reranked
    .map(output => {
      const input = inputById.get(output.id);
      if (!input) return output;
      const prior = computePathPrior(input.filePath, query);
      return {
        ...output,
        score: output.score * prior,
      };
    })
    .sort((a, b) => b.score - a.score);
  
  // Create result map for quick lookup
  const resultMap = new Map(results.map(r => [r.id, r]));
  
  // Reorder and score results
  const rerankedResults: NormalizedSearchResult[] = [];
  for (const output of reranked) {
    const original = resultMap.get(output.id);
    if (original) {
      rerankedResults.push({
        ...original,
        rerankScore: output.score,
        finalScore: output.score,
      });
    }
  }

  // Append remaining results that weren't reranked
  const rerankedIds = new Set(reranked.map(r => r.id));
  for (const result of results) {
    if (!rerankedIds.has(result.id)) {
      rerankedResults.push(result);
    }
  }

  return { results: rerankedResults, method, fallbackReason, modelUsed, modelLoadMs, inferenceMs };
}

/**
 * Normalize score to [0, 1] range using min-max scaling
 */
function normalizeScore(score: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return Math.min(Math.max((score - min) / (max - min), 0), 1);
}

/**
 * Convert scores to percentile ranks within a result set
 * Used for model reranker scores to make them comparable to RRF scores
 */
function scoresToPercentileRanks(results: NormalizedSearchResult[]): Map<string, number> {
  const scored = results
    .filter(r => r.rerankScore !== undefined && r.rerankScore !== null)
    .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0));
  
  const percentileMap = new Map<string, number>();
  const total = scored.length;
  
  if (total === 0) return percentileMap;
  
  scored.forEach((r, index) => {
    // Percentile rank: 1.0 for top result, decreasing to 1/total for last
    const percentile = (total - index) / total;
    percentileMap.set(r.id, percentile);
  });
  
  return percentileMap;
}

/**
 * Blend RRF score with rerank score
 * 
 * SCORE CALIBRATION STRATEGY:
 * - RRF scores: Already normalized [0, 1], used as-is
 * - Heuristic scores: Already in comparable range [0, 0.2], used as-is
 * - Model scores: Converted to percentile ranks before blending
 *   (because model scores are 5-10x higher magnitude than RRF/heuristic)
 */
export function blendScores(
  rrfScore: number,
  rerankScore: number,
  options: { 
    rrfWeight?: number; 
    rerankWeight?: number;
    rerankMethod?: RerankMethod;
  } = {}
): number {
  const { 
    rrfWeight = 0.7, 
    rerankWeight = 0.3,
    rerankMethod = 'heuristic',
  } = options;
  
  // Normalize RRF to [0, 1]
  const normalizedRrf = Math.min(Math.max(rrfScore, 0), 1);
  
  // For model reranker, rerankScore is already calibrated to percentile rank
  // For heuristic reranker, use score as-is (already in comparable range)
  const normalizedRerank = Math.min(Math.max(rerankScore, 0), 1);
  
  return rrfWeight * normalizedRrf + rerankWeight * normalizedRerank;
}

/**
 * Blend scores for a batch of results with proper calibration
 * Uses percentile rank normalization for model reranker scores
 */
export function blendScoresBatch(
  results: NormalizedSearchResult[],
  options: {
    rrfWeight?: number;
    rerankWeight?: number;
    rerankMethod?: RerankMethod;
  } = {}
): NormalizedSearchResult[] {
  const { rrfWeight = 0.7, rerankWeight = 0.3, rerankMethod = 'heuristic' } = options;
  
  if (results.length === 0) return results;
  
  // For model reranker, convert to percentile ranks
  let percentileMap: Map<string, number> | null = null;
  if (rerankMethod === 'model') {
    percentileMap = scoresToPercentileRanks(results);
  }
  
  return results.map(r => {
    const rrfScore = r.rrfScore ?? r.score ?? 0;
    let rerankScore = r.rerankScore ?? 0;
    
    // Calibrate model scores to percentile ranks
    if (rerankMethod === 'model' && percentileMap) {
      const percentile = percentileMap.get(r.id);
      if (percentile !== undefined) {
        rerankScore = percentile;
      }
    }
    
    // Normalize RRF to [0, 1]
    const normalizedRrf = Math.min(Math.max(rrfScore, 0), 1);
    const normalizedRerank = Math.min(Math.max(rerankScore, 0), 1);
    
    const finalScore = rrfWeight * normalizedRrf + rerankWeight * normalizedRerank;
    
    return {
      ...r,
      rrfScore,
      rerankScore: r.rerankScore, // Keep original for telemetry
      finalScore,
    };
  });
}
