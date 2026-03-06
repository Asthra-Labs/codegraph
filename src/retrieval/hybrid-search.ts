import type { Database } from '../db.js';
import {
  ftsSearchRetrievalDocs,
  vectorSearchRetrievalDocs,
  type RetrievalSearchResult,
} from '../retrieval/document-store.js';

export interface HybridRetrievalOptions {
  limit?: number;
  ftsWeight?: number;
  vectorWeight?: number;
  rrfK?: number;
  includeVector?: boolean;
  includeFts?: boolean;
}

export interface HybridRetrievalResult extends RetrievalSearchResult {
  rrfScore: number;
  ftsRank?: number;
  vectorRank?: number;
}

const DEFAULT_OPTIONS: Required<HybridRetrievalOptions> = {
  limit: 20,
  ftsWeight: 1.0,
  vectorWeight: 1.0,
  rrfK: 60,
  includeVector: true,
  includeFts: true,
};

export function hybridSearchRetrievalDocs(
  db: Database,
  query: string,
  embedding: number[] | null,
  options: HybridRetrievalOptions = {}
): HybridRetrievalResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  
  const ftsResults = opts.includeFts 
    ? ftsSearchRetrievalDocs(db, query, opts.limit * 2)
    : [];
  
  const vectorResults = (opts.includeVector && embedding)
    ? vectorSearchRetrievalDocs(db, embedding, opts.limit * 2)
    : [];

  return reciprocalRankFusion(
    [
      { results: ftsResults, weight: opts.ftsWeight },
      { results: vectorResults, weight: opts.vectorWeight },
    ],
    opts.rrfK,
    opts.limit
  );
}

function reciprocalRankFusion(
  rankedLists: Array<{ results: RetrievalSearchResult[]; weight: number }>,
  k: number,
  limit: number
): HybridRetrievalResult[] {
  const scoreMap = new Map<string, {
    result: RetrievalSearchResult;
    rrfScore: number;
    bestRelevanceScore: number;
    ftsRank?: number;
    vectorRank?: number;
  }>();

  for (const { results, weight } of rankedLists) {
    for (let rank = 0; rank < results.length; rank++) {
      const result = results[rank];
      if (!result) continue;
      
      const existing = scoreMap.get(result.docId);
      const rrfContribution = weight / (k + rank + 1);
      
      if (existing) {
        existing.rrfScore += rrfContribution;
        existing.bestRelevanceScore = Math.max(existing.bestRelevanceScore, result.score);
        
        if (result.source === 'fts') {
          existing.ftsRank = rank + 1;
        } else {
          existing.vectorRank = rank + 1;
        }
      } else {
        scoreMap.set(result.docId, {
          result,
          rrfScore: rrfContribution,
          bestRelevanceScore: result.score,
          ftsRank: result.source === 'fts' ? rank + 1 : undefined,
          vectorRank: result.source === 'vector' ? rank + 1 : undefined,
        });
      }
    }
  }

  const sortedResults = Array.from(scoreMap.values())
    .sort((a, b) => b.rrfScore - a.rrfScore);

  return sortedResults.slice(0, limit).map(({ result, rrfScore, bestRelevanceScore, ftsRank, vectorRank }) => ({
    ...result,
    score: bestRelevanceScore,
    rrfScore,
    ftsRank,
    vectorRank,
  }));
}

export function searchRetrievalDocsBySymbol(
  db: Database,
  symbolId: string,
  options: HybridRetrievalOptions = {}
): HybridRetrievalResult[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const query = symbolId.split(':').pop() || symbolId;
  
  const ftsResults = ftsSearchRetrievalDocs(db, query, opts.limit * 2);
  
  const filteredResults = ftsResults.filter(r => r.symbolId === symbolId);
  
  return filteredResults.slice(0, opts.limit).map(result => ({
    ...result,
    rrfScore: result.score,
    ftsRank: 1,
  }));
}
