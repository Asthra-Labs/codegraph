/**
 * Hybrid Search - Reciprocal Rank Fusion (RRF) for combining multiple search results
 * 
 * Migrated from Axon's hybrid.py
 * Combines FTS and vector search using RRF algorithm.
 */

import type { StorageBackend, SearchResult } from '../graph/storage-backend.js';
import { normalizeResults, normalizedToSearchResults } from './result-normalizer.js';
import type { NormalizedSearchResult } from './normalized-result.js';
import { TelemetryCollector } from './search-telemetry.js';
import type { SearchTelemetry, RerankMethod } from './search-telemetry.js';
import { rerankResults, blendScoresBatch } from './shared-reranker.js';
import type { RerankOptions } from './shared-reranker.js';
import { selectRerankMethod, DEFAULT_RERANK_POLICY } from './query-type-detector.js';
import type { RerankPolicy } from './query-type-detector.js';

/**
 * Reciprocal Rank Fusion (RRF) algorithm
 * 
 * RRF_score(d) = sum_r weight_r / (k + rank_r(d))
 * 
 * Where:
 * - d is a document
 * - r is a ranker (FTS, vector, etc.)
 * - weight_r is the weight for ranker r
 * - k is the smoothing constant (default 60)
 * - rank_r(d) is the rank of d in ranker r's results
 */
export function reciprocalRankFusion(
  rankedLists: Array<{ results: SearchResult[]; weight: number }>,
  k: number = 60
): SearchResult[] {
  const scores = new Map<string, { rrfScore: number; bestRelevanceScore: number; result: SearchResult }>();

  for (const { results, weight } of rankedLists) {
    for (let rank = 0; rank < results.length; rank++) {
      const result = results[rank];
      if (!result) continue;

      const existing = scores.get(result.nodeId);
      const rrfContribution = weight / (k + rank + 1);

      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.bestRelevanceScore = Math.max(existing.bestRelevanceScore, result.score);
        if (result.score > existing.result.score) {
          existing.result = result;
        }
      } else {
        scores.set(result.nodeId, {
          rrfScore: rrfContribution,
          bestRelevanceScore: result.score,
          result: result
        });
      }
    }
  }

  const sortedResults = Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(({ result, rrfScore }) => ({
      ...result,
      score: rrfScore,
    }));

  return sortedResults;
}

/**
 * Hybrid Search Options
 */
export interface HybridSearchOptions {
  limit?: number;
  ftsWeight?: number;
  vectorWeight?: number;
  rrfK?: number;
  useFuzzyFallback?: boolean;
  includeCallGraph?: boolean;
  callGraphDepth?: number;
  normalize?: boolean;
  collectTelemetry?: boolean;
  rerank?: boolean;
  rerankMethod?: 'heuristic' | 'model' | 'auto';
  heuristicRerankTopK?: number;
  modelRerankTopK?: number;
  rerankFallbackToHeuristic?: boolean;
  rrfScoreWeight?: number;
  rerankScoreWeight?: number;
  rerankPolicy?: RerankPolicy;
}

export interface HybridSearchResult {
  results: SearchResult[];
  telemetry: SearchTelemetry;
}

/**
 * Perform hybrid search combining FTS and vector search
 */
export async function hybridSearch(
  query: string,
  storage: StorageBackend,
  queryEmbedding: number[] | null = null,
  options: HybridSearchOptions = {}
): Promise<HybridSearchResult> {
  const {
    limit = 20,
    ftsWeight = 1.0,
    vectorWeight = 1.0,
    rrfK = 60,
    useFuzzyFallback = true,
    includeCallGraph = false,
    callGraphDepth = 1,
    normalize = true,
    collectTelemetry = true,
    rerank = true,
    rerankMethod = 'heuristic',
    heuristicRerankTopK = 50,
    modelRerankTopK = 20,
    rerankFallbackToHeuristic = true,
    rrfScoreWeight = 0.7,
    rerankScoreWeight = 0.3,
    rerankPolicy = DEFAULT_RERANK_POLICY,
  } = options;

  const telemetry = new TelemetryCollector();
  const rankedLists: Array<{ results: SearchResult[]; weight: number }> = [];

  try {
    await telemetry.timeAsync('graph_fts_ms', async () => {
      let ftsResults = await storage.ftsSearch(query, limit * 2);
      
      if (ftsResults.length === 0 && useFuzzyFallback) {
        ftsResults = await storage.fuzzySearch(query, limit * 2);
      }
      
      if (ftsResults.length > 0) {
        rankedLists.push({ results: ftsResults, weight: ftsWeight });
        telemetry.setCount('graph_hits', ftsResults.length);
      }
    });

    if (queryEmbedding && vectorWeight > 0) {
      await telemetry.timeAsync('graph_vec_ms', async () => {
        const vectorResults = await storage.vectorSearch(queryEmbedding, limit * 2);
        if (vectorResults.length > 0) {
          rankedLists.push({ results: vectorResults, weight: vectorWeight });
        }
      });
    }

    if (rankedLists.length === 0) {
      return {
        results: [],
        telemetry: telemetry.build(query),
      };
    }

    let fusedResults: SearchResult[];
    telemetry.time('rrf_ms', () => {
      fusedResults = reciprocalRankFusion(rankedLists, rrfK);
      telemetry.setCount('fused_hits', fusedResults.length);
    });
    fusedResults = fusedResults!;

    let normalizedResults: NormalizedSearchResult[] = [];
    
    if (normalize && fusedResults.length > 0) {
      telemetry.time('normalize_ms', () => {
        normalizedResults = normalizeResults(fusedResults);
        telemetry.setCount('fused_hits', normalizedResults.length);
      });
    }

    // Rerank results
    if (rerank && normalizedResults.length > 0) {
      let effectiveMethod: 'model' | 'heuristic' | 'none' = rerankMethod === 'auto' ? 'heuristic' : rerankMethod;
      
      if (rerankMethod === 'auto') {
        const selection = selectRerankMethod(query, 'auto', rerankPolicy);
        effectiveMethod = selection.selectedMethod;
        
        telemetry.setQueryDetection({
          queryType: selection.queryType,
          confidence: selection.confidence,
          reason: selection.reason,
          selectedMethod: selection.selectedMethod,
        });
      }
      
      const rerankTopK = effectiveMethod === 'model' ? modelRerankTopK : heuristicRerankTopK;
      
      const rerankStart = Date.now();
      const rerankResult = await rerankResults(normalizedResults, query, {
        method: effectiveMethod,
        topK: rerankTopK,
        fallbackToHeuristic: rerankFallbackToHeuristic,
      });
      
      telemetry.setReranking({
        rerank_method: rerankResult.method,
        rerank_fallback_reason: rerankResult.fallbackReason,
        rerank_input_count: Math.min(normalizedResults.length, rerankTopK),
        rerank_output_count: rerankResult.results.length,
        model_used: rerankResult.modelUsed,
        rerank_model_load_ms: rerankResult.modelLoadMs,
        rerank_inference_ms: rerankResult.inferenceMs,
      });
      
      // Apply blended scoring with proper calibration
      // For model reranker: converts scores to percentile ranks before blending
      // For heuristic reranker: uses scores as-is
      normalizedResults = blendScoresBatch(rerankResult.results, {
        rrfWeight: rrfScoreWeight,
        rerankWeight: rerankScoreWeight,
        rerankMethod: rerankResult.method,
      });
      
      // Sort by final score
      normalizedResults.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
      
      telemetry.setCount('reranked_hits', normalizedResults.length);
    }

    // Convert back to SearchResult format
    fusedResults = normalizedResults.length > 0 
      ? normalizedToSearchResults(normalizedResults)
      : fusedResults;

    if (includeCallGraph && fusedResults.length > 0) {
      const expandedResults = await expandWithCallGraph(
        fusedResults.slice(0, Math.ceil(limit / 2)),
        storage,
        callGraphDepth
      );
      
      const allResults = new Map<string, SearchResult>();
      for (const result of fusedResults) {
        allResults.set(result.nodeId, result);
      }
      for (const result of expandedResults) {
        if (!allResults.has(result.nodeId)) {
          allResults.set(result.nodeId, { ...result, score: result.score * 0.5 });
        }
      }
      
      fusedResults = Array.from(allResults.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }

    const finalResults = fusedResults.slice(0, limit);
    telemetry.setCount('final_hits', finalResults.length);

    return {
      results: finalResults,
      telemetry: telemetry.build(query),
    };
  } catch (error) {
    telemetry.markFailed(String(error));
    return {
      results: [],
      telemetry: telemetry.build(query),
    };
  }
}

/**
 * Expand search results with call graph context
 */
async function expandWithCallGraph(
  results: SearchResult[],
  storage: StorageBackend,
  depth: number
): Promise<SearchResult[]> {
  const expanded: SearchResult[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    seen.add(result.nodeId);

    // Get callers and callees
    const callers = await storage.traverseWithDepth(result.nodeId, depth, 'callers');
    const callees = await storage.traverseWithDepth(result.nodeId, depth, 'callees');

    // Add with decayed scores based on depth
    for (const { node, depth: d } of callers) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        expanded.push({
          nodeId: node.id,
          score: result.score * Math.pow(0.5, d), // Decay by depth
          nodeName: node.name,
          filePath: node.filePath,
          label: node.label,
          snippet: node.content?.substring(0, 200) ?? '',
          signature: node.signature ?? undefined,
          startLine: node.startLine ?? undefined,
          endLine: node.endLine ?? undefined,
        });
      }
    }

    for (const { node, depth: d } of callees) {
      if (!seen.has(node.id)) {
        seen.add(node.id);
        expanded.push({
          nodeId: node.id,
          score: result.score * Math.pow(0.5, d), // Decay by depth
          nodeName: node.name,
          filePath: node.filePath,
          label: node.label,
          snippet: node.content?.substring(0, 200) ?? '',
          signature: node.signature ?? undefined,
          startLine: node.startLine ?? undefined,
          endLine: node.endLine ?? undefined,
        });
      }
    }
  }

  return expanded;
}

/**
 * Code-aware search that expands technical terms
 * 
 * @param query - The search query
 * @param storage - The storage backend
 * @param embedFn - Function to generate embeddings
 * @param options - Search options
 */
export async function codeAwareSearch(
  query: string,
  storage: StorageBackend,
  embedFn: (text: string) => Promise<number[]>,
  options: HybridSearchOptions = {}
): Promise<HybridSearchResult> {
  const telemetry = new TelemetryCollector();
  let queryEmbedding: number[] | null = null;

  try {
    await telemetry.timeAsync('embed_ms', async () => {
      try {
        queryEmbedding = await embedFn(query);
      } catch {
        // Continue without embedding if it fails
      }
    });

    const result = await hybridSearch(query, storage, queryEmbedding, options);
    
    return {
      results: result.results,
      telemetry: {
        ...result.telemetry,
        embed_ms: telemetry.build().embed_ms,
      },
    };
  } catch (error) {
    telemetry.markFailed(String(error));
    return {
      results: [],
      telemetry: telemetry.build(query),
    };
  }
}
