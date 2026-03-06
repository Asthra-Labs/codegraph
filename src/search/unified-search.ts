import type { Database } from '../db.js';
import type { StorageBackend, SearchResult, SearchFilters } from '../graph/storage-backend.js';
import {
  ftsSearchRetrievalDocs,
  vectorSearchRetrievalDocs,
  type RetrievalSearchResult,
} from '../retrieval/document-store.js';
import { reciprocalRankFusion } from '../search/hybrid.js';

export type ResultSource = 'graph' | 'retrieval';

export interface UnifiedSearchResult extends SearchResult {
  source: ResultSource;
  chunkType?: string;
  rrfScore?: number;
  ftsRank?: number;
  vectorRank?: number;
}

export interface UnifiedSearchOptions {
  limit?: number;
  candidateMultiplier?: number;
  semanticMultiplier?: number;
  ftsWeight?: number;
  vectorWeight?: number;
  graphWeight?: number;
  retrievalWeight?: number;
  rrfK?: number;
  useFuzzyFallback?: boolean;
  includeCallGraph?: boolean;
  callGraphDepth?: number;
  includeRetrievalDocs?: boolean;
  boostCallsites?: boolean;
  callsiteBoostFactor?: number;
  isSemanticIntent?: boolean;
  filters?: SearchFilters;
}

interface InternalResult {
  id: string;
  result: SearchResult;
  source: ResultSource;
  chunkType?: string;
}

const DEFAULT_OPTIONS: Required<UnifiedSearchOptions> = {
  limit: 20,
  candidateMultiplier: 3,
  semanticMultiplier: 5,
  ftsWeight: 1.0,
  vectorWeight: 1.0,
  graphWeight: 1.0,
  retrievalWeight: 1.0,
  rrfK: 60,
  useFuzzyFallback: true,
  includeCallGraph: false,
  callGraphDepth: 1,
  includeRetrievalDocs: true,
  boostCallsites: false,
  callsiteBoostFactor: 1.5,
  isSemanticIntent: false,
  filters: {},
};

export async function unifiedSearch(
  query: string,
  db: Database,
  storage: StorageBackend,
  queryEmbedding: number[] | null,
  options: UnifiedSearchOptions = {}
): Promise<UnifiedSearchResult[]> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const effectiveMultiplier = opts.isSemanticIntent 
    ? Math.max(opts.candidateMultiplier, opts.semanticMultiplier)
    : opts.candidateMultiplier;
  const candidateLimit = opts.limit * effectiveMultiplier;

  const rankedLists: Array<{ results: InternalResult[]; weight: number }> = [];

  const graphFtsResults = await storage.ftsSearch(query, candidateLimit, opts.filters);
  if (graphFtsResults.length === 0 && opts.useFuzzyFallback) {
    const fuzzyResults = await storage.fuzzySearch(query, candidateLimit);
    if (fuzzyResults.length > 0) {
      rankedLists.push({
        results: fuzzyResults.map(r => ({ id: r.nodeId, result: r, source: 'graph' as const })),
        weight: opts.ftsWeight * opts.graphWeight,
      });
    }
  } else if (graphFtsResults.length > 0) {
    rankedLists.push({
      results: graphFtsResults.map(r => ({ id: r.nodeId, result: r, source: 'graph' as const })),
      weight: opts.ftsWeight * opts.graphWeight,
    });
  }

  if (queryEmbedding) {
    const graphVectorResults = await storage.vectorSearch(queryEmbedding, candidateLimit, opts.filters);
    if (graphVectorResults.length > 0) {
      rankedLists.push({
        results: graphVectorResults.map(r => ({ id: r.nodeId, result: r, source: 'graph' as const })),
        weight: opts.vectorWeight * opts.graphWeight,
      });
    }
  }

  if (opts.includeRetrievalDocs) {
    const retrievalFtsResults = ftsSearchRetrievalDocs(db, query, candidateLimit, opts.filters);
    if (retrievalFtsResults.length > 0) {
      const mappedResults = retrievalFtsResults.map(r => {
        return {
          id: r.docId,
          result: retrievalToSearchResult(r),
          source: 'retrieval' as const,
          chunkType: r.type,
        };
      });
      rankedLists.push({
        results: mappedResults,
        weight: opts.ftsWeight * opts.retrievalWeight,
      });
    }

    if (queryEmbedding) {
      const retrievalVectorResults = vectorSearchRetrievalDocs(db, queryEmbedding, candidateLimit, opts.filters);
      if (retrievalVectorResults.length > 0) {
        const mappedResults = retrievalVectorResults.map(r => {
          return {
            id: r.docId,
            result: retrievalToSearchResult(r),
            source: 'retrieval' as const,
            chunkType: r.type,
          };
        });
        rankedLists.push({
          results: mappedResults,
          weight: opts.vectorWeight * opts.retrievalWeight,
        });
      }
    }
  }

  if (rankedLists.length === 0) {
    return [];
  }

  const fusedResults = unifiedRRF(rankedLists, opts.rrfK, opts.boostCallsites ? opts.callsiteBoostFactor : 1.0);

  if (opts.includeCallGraph && fusedResults.length > 0) {
    await expandWithCallGraph(db, fusedResults, storage, opts.callGraphDepth, opts.limit, opts.filters);
  }

  return fusedResults.slice(0, opts.limit);
}

function unifiedRRF(
  rankedLists: Array<{ results: InternalResult[]; weight: number }>,
  k: number,
  callsiteBoost: number = 1.0
): UnifiedSearchResult[] {
  const scoreMap = new Map<string, {
    result: InternalResult;
    rrfScore: number;
    bestRelevanceScore: number;
    ftsRank?: number;
    vectorRank?: number;
  }>();

  let ftsListIndex = 0;
  let vecListIndex = 0;

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const listEntry = rankedLists[listIdx];
    if (!listEntry) continue;
    
    const { results, weight } = listEntry;
    const isFts = listIdx % 2 === 0;
    
    for (let rank = 0; rank < results.length; rank++) {
      const item = results[rank];
      if (!item) continue;
      
      let effectiveWeight = weight;
      if (callsiteBoost > 1.0 && item.chunkType === 'callsite') {
        effectiveWeight *= callsiteBoost;
      }
      
      const rrfContribution = effectiveWeight / (k + rank + 1);
      const existing = scoreMap.get(item.id);

      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.bestRelevanceScore = Math.max(existing.bestRelevanceScore, item.result.score);
        
        if (item.result.score > existing.result.result.score) {
          existing.result = item;
        }
        
        if (isFts) {
          existing.ftsRank = rank + 1;
        } else {
          existing.vectorRank = rank + 1;
        }
      } else {
        scoreMap.set(item.id, {
          result: item,
          rrfScore: rrfContribution,
          bestRelevanceScore: item.result.score,
          ftsRank: isFts ? rank + 1 : undefined,
          vectorRank: isFts ? undefined : rank + 1,
        });
      }
    }
  }

  const sortedResults = Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore);

  return sortedResults.map(({ result, rrfScore, bestRelevanceScore, ftsRank, vectorRank }) => ({
    ...result.result,
    source: result.source,
    chunkType: result.chunkType,
    score: bestRelevanceScore,
    rrfScore,
    ftsRank,
    vectorRank,
  }));
}

function retrievalToSearchResult(r: RetrievalSearchResult): SearchResult {
  return {
    nodeId: r.docId,
    score: r.score,
    nodeName: r.symbolName,
    filePath: r.filePath,
    label: r.symbolKind as any,
    snippet: r.content.substring(0, 200),
    signature: r.signature,
    startLine: r.startLine,
    endLine: r.endLine,
  };
}

function nodePassesFilters(db: Database, nodeId: string, filters: SearchFilters | undefined): boolean {
  if (!filters || Object.keys(filters).length === 0) return true;

  const conditions: string[] = ['id = ?'];
  const params: any[] = [nodeId];

  if (filters.repoId) {
    conditions.push('repo_id = ?');
    params.push(filters.repoId);
  }
  if (filters.branch) {
    conditions.push('branch = ?');
    params.push(filters.branch);
  }
  if (filters.commitSha) {
    conditions.push('commit_sha = ?');
    params.push(filters.commitSha);
  }
  if (filters.pathPrefix) {
    conditions.push('file_path LIKE ?');
    params.push(`${filters.pathPrefix}%`);
  }

  const row = db.prepare(`
    SELECT id
    FROM graph_nodes
    WHERE ${conditions.join(' AND ')}
    LIMIT 1
  `).get(...params) as { id?: string } | undefined;

  return !!row?.id;
}

async function expandWithCallGraph(
  db: Database,
  results: UnifiedSearchResult[],
  storage: StorageBackend,
  depth: number,
  limit: number,
  filters?: SearchFilters
): Promise<void> {
  const seen = new Set(results.map(r => r.nodeId));

  for (const result of results.slice(0, Math.ceil(limit / 2))) {
    if (result.source !== 'graph') continue;

    try {
      const callers = await storage.traverseWithDepth(result.nodeId, depth, 'callers');
      const callees = await storage.traverseWithDepth(result.nodeId, depth, 'callees');

      for (const { node, depth: d } of callers) {
        if (!nodePassesFilters(db, node.id, filters)) continue;
        if (!seen.has(node.id)) {
          seen.add(node.id);
          results.push({
            nodeId: node.id,
            score: result.score * Math.pow(0.5, d),
            nodeName: node.name,
            filePath: node.filePath,
            label: node.label,
            snippet: node.content?.substring(0, 200) ?? '',
            signature: node.signature ?? undefined,
            startLine: node.startLine ?? undefined,
            endLine: node.endLine ?? undefined,
            source: 'graph',
            rrfScore: result.rrfScore! * Math.pow(0.5, d),
          });
        }
      }

      for (const { node, depth: d } of callees) {
        if (!nodePassesFilters(db, node.id, filters)) continue;
        if (!seen.has(node.id)) {
          seen.add(node.id);
          results.push({
            nodeId: node.id,
            score: result.score * Math.pow(0.5, d),
            nodeName: node.name,
            filePath: node.filePath,
            label: node.label,
            snippet: node.content?.substring(0, 200) ?? '',
            signature: node.signature ?? undefined,
            startLine: node.startLine ?? undefined,
            endLine: node.endLine ?? undefined,
            source: 'graph',
            rrfScore: result.rrfScore! * Math.pow(0.5, d),
          });
        }
      }
    } catch {
      // Continue if call graph expansion fails
    }
  }

  results.sort((a, b) => (b.rrfScore ?? b.score) - (a.rrfScore ?? a.score));
}
