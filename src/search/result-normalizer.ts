/**
 * Result Normalizer - Converts raw search results to canonical normalized format
 * 
 * Handles conversion from:
 * - storage-backend.ts SearchResult (graph nodes)
 * - store.ts DocumentResult (retrieval documents)
 * 
 * Enforces strict validation rules and symbol identity checks.
 */

import type { SearchResult as GraphSearchResult } from '../graph/storage-backend.js';
import type { DocumentResult } from '../store.js';
import { NodeLabel } from '../graph/model.js';
import {
  type NormalizedSearchResult,
  type ResultSource,
  type RetrievalKind,
  type NormalizationOptions,
  hasStrongSymbolIdentity,
  DEFAULT_NORMALIZATION_OPTIONS,
} from './normalized-result.js';

/** Raw input that can be normalized */
export type RawSearchResult = 
  | { type: 'graph'; result: GraphSearchResult; retrievalKind: RetrievalKind }
  | { type: 'retrieval'; result: DocumentResult & { score: number }; retrievalKind: RetrievalKind }
  | { type: 'unknown'; result: Record<string, unknown> };

/**
 * Normalize a graph SearchResult to canonical format
 */
export function normalizeGraphResult(
  result: GraphSearchResult,
  retrievalKind: RetrievalKind = 'graph_fts',
  options: NormalizationOptions = DEFAULT_NORMALIZATION_OPTIONS
): NormalizedSearchResult | null {
  const normalized: NormalizedSearchResult = {
    id: result.nodeId,
    filePath: result.filePath,
    score: result.score,
    source: 'graph',
    retrievalKind,
    symbolName: result.nodeName || undefined,
    symbolKind: result.label || undefined,
    signature: result.signature,
    startLine: result.startLine,
    endLine: result.endLine,
    snippet: result.snippet || undefined,
    metadata: {
      originalScore: result.score,
    },
  };

  return validateAndFinalize(normalized, options);
}

/**
 * Normalize a retrieval DocumentResult to canonical format
 */
export function normalizeRetrievalResult(
  result: DocumentResult & { score: number; source?: 'fts' | 'vec' },
  retrievalKind: RetrievalKind = 'retrieval_fts',
  options: NormalizationOptions = DEFAULT_NORMALIZATION_OPTIONS
): NormalizedSearchResult | null {
  const normalized: NormalizedSearchResult = {
    id: result.docid || result.hash?.slice(0, 6) || `doc_${Date.now()}`,
    filePath: result.filepath,
    score: result.score,
    source: 'retrieval',
    retrievalKind,
    content: result.body,
    snippet: result.body ? result.body.slice(0, options.maxSnippetLength || 500) : undefined,
    metadata: {
      originalScore: result.score,
      chunkId: result.docid,
      language: inferLanguageFromPath(result.filepath),
    },
  };

  return validateAndFinalize(normalized, options);
}

/**
 * Normalize an unknown result type (best-effort conversion)
 */
export function normalizeUnknownResult(
  result: Record<string, unknown>,
  options: NormalizationOptions = DEFAULT_NORMALIZATION_OPTIONS
): NormalizedSearchResult | null {
  const id = extractString(result, 'nodeId', 'id', 'docid', 'docId');
  const filePath = extractString(result, 'filePath', 'filepath', 'path', 'file');
  const score = extractNumber(result, 'score', 'relevanceScore', 'relevance');

  if (!id || !filePath || score === null) {
    return null;
  }

  const normalized: NormalizedSearchResult = {
    id,
    filePath,
    score,
    source: inferSource(result),
    retrievalKind: inferRetrievalKind(result),
    symbolName: extractString(result, 'nodeName', 'symbolName', 'name'),
    symbolKind: extractString(result, 'label', 'symbolKind', 'kind'),
    signature: extractString(result, 'signature'),
    startLine: extractNumber(result, 'startLine', 'start_line', 'lineStart') ?? undefined,
    endLine: extractNumber(result, 'endLine', 'end_line', 'lineEnd') ?? undefined,
    content: extractString(result, 'body', 'content', 'text'),
    snippet: extractString(result, 'snippet', 'preview'),
    metadata: {
      originalScore: score,
    },
  };

  return validateAndFinalize(normalized, options);
}

/**
 * Normalize an array of raw results
 */
export function normalizeResults(
  results: unknown[],
  options: NormalizationOptions = DEFAULT_NORMALIZATION_OPTIONS
): NormalizedSearchResult[] {
  const normalized: NormalizedSearchResult[] = [];

  for (const raw of results) {
    const result = normalizeAnyResult(raw, options);
    if (result) {
      normalized.push(result);
    }
  }

  return normalized;
}

/**
 * Normalize any result type (auto-detect)
 */
export function normalizeAnyResult(
  raw: unknown,
  options: NormalizationOptions = DEFAULT_NORMALIZATION_OPTIONS
): NormalizedSearchResult | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const result = raw as Record<string, unknown>;

  if (isGraphSearchResult(result)) {
    return normalizeGraphResult(
      result as GraphSearchResult,
      inferRetrievalKind(result),
      options
    );
  }

  if (isDocumentResult(result)) {
    return normalizeRetrievalResult(
      result as DocumentResult & { score: number },
      inferRetrievalKind(result),
      options
    );
  }

  return normalizeUnknownResult(result, options);
}

/**
 * Validate and finalize a normalized result
 */
function validateAndFinalize(
  result: NormalizedSearchResult,
  options: NormalizationOptions
): NormalizedSearchResult | null {
  if (!isValidRequiredFields(result)) {
    return null;
  }

  result.metadata = result.metadata || {};

  if (result.score < 0 || !Number.isFinite(result.score)) {
    result.score = 0;
  }

  if (hasStrongSymbolIdentity(result)) {
    result.metadata.isSymbol = true;
    result.metadata.language = result.metadata.language || inferLanguageFromPath(result.filePath);
  } else {
    result.metadata.isSymbol = false;
    if (result.symbolKind === 'FILE' || result.symbolKind === 'file') {
      result.symbolName = undefined;
      result.symbolKind = undefined;
      result.signature = undefined;
    }
  }

  result.rrfScore = result.score;
  result.finalScore = result.score;

  return result;
}

/**
 * Check if required fields are valid
 */
function isValidRequiredFields(result: Partial<NormalizedSearchResult>): boolean {
  if (!result.id || typeof result.id !== 'string' || result.id.length === 0) {
    return false;
  }

  if (!result.filePath || typeof result.filePath !== 'string' || result.filePath.length === 0) {
    return false;
  }

  if (typeof result.score !== 'number' || !Number.isFinite(result.score)) {
    return false;
  }

  if (!result.source || !['graph', 'retrieval', 'both'].includes(result.source)) {
    return false;
  }

  return true;
}

/**
 * Type guard for graph SearchResult
 */
function isGraphSearchResult(result: Record<string, unknown>): boolean {
  return (
    typeof result.nodeId === 'string' &&
    typeof result.filePath === 'string' &&
    'nodeName' in result &&
    'label' in result
  );
}

/**
 * Type guard for DocumentResult
 */
function isDocumentResult(result: Record<string, unknown>): boolean {
  return (
    typeof result.filepath === 'string' &&
    typeof result.docid === 'string' &&
    'displayPath' in result
  );
}

/**
 * Infer ResultSource from raw result
 */
function inferSource(result: Record<string, unknown>): ResultSource {
  if (typeof result.nodeId === 'string' && 'label' in result) {
    if (typeof result.docid === 'string' || 'displayPath' in result) {
      return 'both';
    }
    return 'graph';
  }
  
  if (typeof result.docid === 'string' || 'displayPath' in result) {
    return 'retrieval';
  }

  return 'retrieval';
}

/**
 * Infer RetrievalKind from raw result
 */
function inferRetrievalKind(result: Record<string, unknown>): RetrievalKind {
  if (typeof result.source === 'string') {
    if (result.source === 'fts') {
      return typeof result.nodeId === 'string' ? 'graph_fts' : 'retrieval_fts';
    }
    if (result.source === 'vec') {
      return typeof result.nodeId === 'string' ? 'graph_vec' : 'retrieval_vec';
    }
  }

  if (typeof result.nodeId === 'string') {
    return 'graph_fts';
  }

  return 'retrieval_fts';
}

/**
 * Extract string from object with multiple possible keys
 */
function extractString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Extract number from object with multiple possible keys
 */
function extractNumber(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

/**
 * Infer programming language from file path
 */
function inferLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  const languageMap: Record<string, string> = {
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'jsx': 'javascript',
    'py': 'python',
    'rs': 'rust',
    'go': 'go',
    'java': 'java',
    'kt': 'kotlin',
    'swift': 'swift',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'rb': 'ruby',
    'php': 'php',
    'scala': 'scala',
    'clj': 'clojure',
    'ex': 'elixir',
    'exs': 'elixir',
    'erl': 'erlang',
    'hs': 'haskell',
    'lua': 'lua',
    'r': 'r',
    'sql': 'sql',
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'ps1': 'powershell',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'xml': 'xml',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'md': 'markdown',
    'markdown': 'markdown',
  };

  return ext ? languageMap[ext] : undefined;
}

/**
 * Convert NormalizedSearchResult back to SearchResult format
 * Used for backward compatibility with existing callers
 */
export function normalizedToSearchResult(normalized: NormalizedSearchResult): SearchResult {
  return {
    nodeId: normalized.id,
    filePath: normalized.filePath,
    score: normalized.finalScore ?? normalized.rrfScore ?? normalized.score,
    nodeName: normalized.symbolName,
    label: normalized.symbolKind,
    snippet: normalized.snippet ?? normalized.content?.substring(0, 200) ?? '',
    signature: normalized.signature,
    startLine: normalized.startLine,
    endLine: normalized.endLine,
  };
}

/**
 * Convert array of NormalizedSearchResult back to SearchResult[]
 */
export function normalizedToSearchResults(normalized: NormalizedSearchResult[]): SearchResult[] {
  return normalized.map(normalizedToSearchResult);
}
