/**
 * Hybrid Search - Reciprocal Rank Fusion (RRF) for combining multiple search results
 * 
 * Migrated from Axon's hybrid.py
 * Combines FTS and vector search using RRF algorithm.
 */

import type { StorageBackend, SearchResult } from '../graph/storage-backend.js';

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
    .map(({ result, bestRelevanceScore }) => ({
      ...result,
      score: bestRelevanceScore,
    }));

  return sortedResults;
}

/**
 * Hybrid Search Options
 */
export interface HybridSearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Weight for FTS results */
  ftsWeight?: number;
  /** Weight for vector results */
  vectorWeight?: number;
  /** RRF smoothing constant */
  rrfK?: number;
  /** Whether to use fuzzy search as fallback */
  useFuzzyFallback?: boolean;
  /** Whether to include call graph context */
  includeCallGraph?: boolean;
  /** Call graph traversal depth */
  callGraphDepth?: number;
}

/**
 * Perform hybrid search combining FTS and vector search
 */
export async function hybridSearch(
  query: string,
  storage: StorageBackend,
  queryEmbedding: number[] | null = null,
  options: HybridSearchOptions = {}
): Promise<SearchResult[]> {
  const {
    limit = 20,
    ftsWeight = 1.0,
    vectorWeight = 1.0,
    rrfK = 60,
    useFuzzyFallback = true,
    includeCallGraph = false,
    callGraphDepth = 1,
  } = options;

  const rankedLists: Array<{ results: SearchResult[]; weight: number }> = [];

  // Run FTS search
  let ftsResults = await storage.ftsSearch(query, limit * 2);
  
  // Fallback to fuzzy search if FTS returns no results
  if (ftsResults.length === 0 && useFuzzyFallback) {
    ftsResults = await storage.fuzzySearch(query, limit * 2);
  }
  
  if (ftsResults.length > 0) {
    rankedLists.push({ results: ftsResults, weight: ftsWeight });
  }

  // Run vector search if embedding is provided
  if (queryEmbedding && vectorWeight > 0) {
    const vectorResults = await storage.vectorSearch(queryEmbedding, limit * 2);
    if (vectorResults.length > 0) {
      rankedLists.push({ results: vectorResults, weight: vectorWeight });
    }
  }

  // If no results from any method, return empty
  if (rankedLists.length === 0) {
    return [];
  }

  // Fuse results using RRF
  let fusedResults = reciprocalRankFusion(rankedLists, rrfK);

  // Expand with call graph context if requested
  if (includeCallGraph && fusedResults.length > 0) {
    const expandedResults = await expandWithCallGraph(
      fusedResults.slice(0, Math.ceil(limit / 2)),
      storage,
      callGraphDepth
    );
    
    // Merge and re-rank
    const allResults = new Map<string, SearchResult>();
    for (const result of fusedResults) {
      allResults.set(result.nodeId, result);
    }
    for (const result of expandedResults) {
      if (!allResults.has(result.nodeId)) {
        allResults.set(result.nodeId, { ...result, score: result.score * 0.5 }); // Demote call graph results
      }
    }
    
    fusedResults = Array.from(allResults.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  return fusedResults.slice(0, limit);
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
): Promise<SearchResult[]> {
  // Generate embedding for the query
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embedFn(query);
  } catch {
    // Continue without embedding if it fails
  }

  return hybridSearch(query, storage, queryEmbedding, options);
}
