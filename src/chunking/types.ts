import type { SymbolKind } from '../parsers/base.js';

export type ChunkType =
  | 'symbol'
  | 'sub_chunk'
  | 'file_context'
  | 'callsite'
  | 'reference';

export interface RetrievalChunk {
  id: string;
  type: ChunkType;
  parentId?: string;
  symbolId?: string;
  symbolName: string;
  symbolKind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  ftsText: string;
  embeddingText: string;
  signature?: string;
  className?: string;
  isExported?: boolean;
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  tokenCount?: number;
  overlapTokens?: number;
  chunkIndex?: number;
  totalChunks?: number;
  callerSymbolId?: string;
  callerSymbolName?: string;
  contextType?: 'imports' | 'exports' | 'file_header' | 'module_decl';
}

export interface ChunkingConfig {
  maxChunkTokens: number;
  overlapTokens: number;
  minChunkTokens: number;
  includeFileContext: boolean;
  includeCallsites: boolean;
  maxCallsitesPerSymbol: number;
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxChunkTokens: 512,
  overlapTokens: 50,
  minChunkTokens: 100,
  includeFileContext: true,
  includeCallsites: true,
  maxCallsitesPerSymbol: 10,
};

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function generateChunkId(
  filePath: string,
  symbolName: string,
  type: ChunkType,
  index?: number
): string {
  const base = `${type}:${filePath}:${symbolName}`;
  return index !== undefined ? `${base}:${index}` : base;
}
