import type { UnifiedSearchResult } from '../search/unified-search.js';

export interface RerankInput {
  id: string;
  symbolName: string;
  symbolKind: string;
  filePath: string;
  signature?: string;
  className?: string;
  content: string;
  metadata: Record<string, unknown>;
}

export interface RerankResult {
  id: string;
  score: number;
  originalRank: number;
}

export interface RerankerOptions {
  enabled: boolean;
  topK: number;
  alpha: number;
  beta: number;
  gamma: number;
  delta: number;
  epsilon: number;
}

export const DEFAULT_RERANKER_OPTIONS: RerankerOptions = {
  enabled: true,
  topK: 30,
  alpha: 0.3,    // Symbol name match weight
  beta: 0.25,    // Signature match weight
  gamma: 0.2,    // File path relevance weight
  delta: 0.15,   // Class/module context weight
  epsilon: 0.1,  // Content relevance weight
};

export function createRerankInput(result: UnifiedSearchResult): RerankInput {
  return {
    id: result.id,
    symbolName: result.symbolName,
    symbolKind: result.symbolKind,
    filePath: result.filePath,
    signature: result.signature,
    className: result.className,
    content: result.content,
    metadata: result.metadata,
  };
}

export function createRerankInputs(results: UnifiedSearchResult[]): RerankInput[] {
  return results.map(createRerankInput);
}

export function simpleRerank(
  inputs: RerankInput[],
  query: string,
  options: RerankerOptions = DEFAULT_RERANKER_OPTIONS
): RerankResult[] {
  if (!options.enabled || inputs.length === 0) {
    return inputs.map((input, index) => ({
      id: input.id,
      score: 1.0 - index / inputs.length,
      originalRank: index,
    }));
  }

  const queryLower = query.toLowerCase();
  const queryTerms = new Set(queryLower.split(/\s+/).filter(t => t.length > 1));
  const queryIdentifiers = extractIdentifiers(query);

  const scored = inputs.map((input, index) => {
    const scores = computeRerankScores(input, queryLower, queryTerms, queryIdentifiers);
    
    const finalScore = 
      options.alpha * scores.symbolNameScore +
      options.beta * scores.signatureScore +
      options.gamma * scores.filePathScore +
      options.delta * scores.classNameScore +
      options.epsilon * scores.contentScore;

    return {
      id: input.id,
      score: finalScore,
      originalRank: index,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

interface RerankScores {
  symbolNameScore: number;
  signatureScore: number;
  filePathScore: number;
  classNameScore: number;
  contentScore: number;
}

function computeRerankScores(
  input: RerankInput,
  queryLower: string,
  queryTerms: Set<string>,
  queryIdentifiers: string[]
): RerankScores {
  const symbolNameLower = input.symbolName.toLowerCase();
  const signatureLower = (input.signature || '').toLowerCase();
  const filePathLower = input.filePath.toLowerCase();
  const classNameLower = (input.className || '').toLowerCase();
  const contentLower = input.content.toLowerCase();

  const symbolNameScore = computeMatchScore(symbolNameLower, queryLower, queryTerms, queryIdentifiers);
  const signatureScore = computeMatchScore(signatureLower, queryLower, queryTerms, queryIdentifiers);
  const filePathScore = computePathRelevanceScore(filePathLower, queryTerms);
  const classNameScore = computeMatchScore(classNameLower, queryLower, queryTerms, queryIdentifiers);
  const contentScore = computeContentScore(contentLower, queryTerms);

  return { symbolNameScore, signatureScore, filePathScore, classNameScore, contentScore };
}

function computeMatchScore(
  text: string,
  queryLower: string,
  queryTerms: Set<string>,
  queryIdentifiers: string[]
): number {
  if (!text) return 0;

  let score = 0;

  if (text === queryLower) {
    score += 1.0;
  } else if (text.includes(queryLower)) {
    score += 0.8;
  }

  let termMatches = 0;
  for (const term of queryTerms) {
    if (text.includes(term)) {
      termMatches++;
    }
  }
  score += (termMatches / Math.max(queryTerms.size, 1)) * 0.5;

  for (const identifier of queryIdentifiers) {
    if (text.includes(identifier.toLowerCase())) {
      score += 0.3;
    }
  }

  return Math.min(score, 1.0);
}

function computePathRelevanceScore(filePath: string, queryTerms: Set<string>): number {
  if (!filePath) return 0;

  const pathParts = filePath.split(/[/\\]/);
  const fileName = pathParts[pathParts.length - 1] || '';
  const fileNameLower = fileName.toLowerCase();

  let score = 0;

  for (const term of queryTerms) {
    if (fileNameLower.includes(term)) {
      score += 0.5;
    }
  }

  const dirNames = pathParts.slice(0, -1).map(p => p.toLowerCase());
  for (const dirName of dirNames) {
    for (const term of queryTerms) {
      if (dirName.includes(term)) {
        score += 0.2;
      }
    }
  }

  return Math.min(score, 1.0);
}

function computeContentScore(content: string, queryTerms: Set<string>): number {
  if (!content) return 0;

  const contentLower = content.toLowerCase();
  let termMatches = 0;

  for (const term of queryTerms) {
    const regex = new RegExp(`\\b${escapeRegex(term)}\\b`, 'gi');
    const matches = contentLower.match(regex);
    if (matches) {
      termMatches += matches.length;
    }
  }

  const maxMatches = queryTerms.size * 3;
  return Math.min(termMatches / Math.max(maxMatches, 1), 1.0);
}

function extractIdentifiers(query: string): string[] {
  const identifiers: string[] = [];

  const camelCase = query.match(/[a-z][A-Z][a-z]+/g) || [];
  identifiers.push(...camelCase);

  const snakeCase = query.match(/[a-z]+_[a-z]+/g) || [];
  identifiers.push(...snakeCase);

  const pascalCase = query.match(/[A-Z][a-z]+[A-Z]/g) || [];
  identifiers.push(...pascalCase);

  return identifiers;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function rerankResults(
  results: UnifiedSearchResult[],
  query: string,
  options: RerankerOptions = DEFAULT_RERANKER_OPTIONS
): UnifiedSearchResult[] {
  if (!options.enabled || results.length === 0) {
    return results;
  }

  const topK = results.slice(0, options.topK);
  const remaining = results.slice(options.topK);

  const inputs = createRerankInputs(topK);
  const reranked = simpleRerank(inputs, query, options);

  const rerankedMap = new Map(reranked.map(r => [r.id, r]));

  const reorderedTopK: UnifiedSearchResult[] = [];
  for (const rerankResult of reranked) {
    const original = topK.find(r => r.id === rerankResult.id);
    if (original) {
      reorderedTopK.push({
        ...original,
        score: rerankResult.score,
        metadata: {
          ...original.metadata,
          reranked: true,
          originalRank: rerankResult.originalRank,
        },
      });
    }
  }

  return [...reorderedTopK, ...remaining];
}
