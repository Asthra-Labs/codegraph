import type { SymbolInfo, ImportInfo, RelationshipInfo, ParseResult } from '../parsers/base.js';
import {
  type RetrievalChunk,
  type ChunkingConfig,
  type ChunkType,
  DEFAULT_CHUNKING_CONFIG,
  estimateTokenCount,
  generateChunkId,
} from './types.js';

export class Chunker {
  private config: ChunkingConfig;

  constructor(config: Partial<ChunkingConfig> = {}) {
    this.config = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  }

  chunk(parseResult: ParseResult, fileContent: string): RetrievalChunk[] {
    const chunks: RetrievalChunk[] = [];

    for (const symbol of parseResult.symbols) {
      const symbolChunks = this.chunkSymbol(symbol);
      chunks.push(...symbolChunks);
    }

    if (this.config.includeFileContext) {
      const fileContextChunks = this.createFileContextChunks(
        parseResult,
        fileContent
      );
      chunks.push(...fileContextChunks);
    }

    if (this.config.includeCallsites) {
      const callsiteChunks = this.createCallsiteChunks(
        parseResult.relationships,
        parseResult.symbols,
        fileContent
      );
      chunks.push(...callsiteChunks);
    }

    return chunks;
  }

  private chunkSymbol(symbol: SymbolInfo): RetrievalChunk[] {
    const tokenCount = estimateTokenCount(symbol.content);

    if (tokenCount <= this.config.maxChunkTokens) {
      return [this.createSymbolChunk(symbol)];
    }

    return this.splitSymbol(symbol);
  }

  private createSymbolChunk(symbol: SymbolInfo): RetrievalChunk {
    const ftsText = this.buildFtsText(symbol);
    const embeddingText = this.buildEmbeddingText(symbol);

    return {
      id: generateChunkId(symbol.filePath, symbol.name, 'symbol'),
      type: 'symbol',
      symbolId: symbol.id,
      symbolName: symbol.name,
      symbolKind: symbol.kind,
      filePath: symbol.filePath,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      content: symbol.content,
      ftsText,
      embeddingText,
      signature: symbol.signature,
      className: symbol.className,
      isExported: symbol.isExported,
      metadata: {
        tokenCount: estimateTokenCount(symbol.content),
      },
    };
  }

  private splitSymbol(symbol: SymbolInfo): RetrievalChunk[] {
    const chunks: RetrievalChunk[] = [];
    const lines = symbol.content.split('\n');
    const totalLines = lines.length;

    const signature = symbol.signature || symbol.name;
    const signatureLines = Math.min(5, totalLines);
    const signatureContent = lines.slice(0, signatureLines).join('\n');

    const avgTokensPerLine = Math.max(1, estimateTokenCount(symbol.content) / Math.max(1, totalLines));
    const targetLinesPerChunk = Math.max(1, Math.ceil(
      this.config.maxChunkTokens / avgTokensPerLine
    ));
    const overlapLines = Math.min(
      Math.max(0, Math.ceil(this.config.overlapTokens / avgTokensPerLine)),
      Math.max(0, targetLinesPerChunk - 1)
    );

    chunks.push({
      id: generateChunkId(symbol.filePath, symbol.name, 'sub_chunk', 0),
      type: 'sub_chunk',
      parentId: symbol.id,
      symbolId: symbol.id,
      symbolName: symbol.name,
      symbolKind: symbol.kind,
      filePath: symbol.filePath,
      startLine: symbol.startLine,
      endLine: symbol.startLine + signatureLines - 1,
      content: signatureContent,
      ftsText: this.buildFtsText(symbol),
      embeddingText: `${symbol.signature}\n\n${signatureContent}`,
      signature: symbol.signature,
      className: symbol.className,
      isExported: symbol.isExported,
      metadata: {
        tokenCount: estimateTokenCount(signatureContent),
        chunkIndex: 0,
        totalChunks: Math.ceil((totalLines - signatureLines) / Math.max(1, targetLinesPerChunk - overlapLines)) + 1,
      },
    });

    let currentLine = signatureLines;
    let chunkIndex = 1;

    while (currentLine < totalLines) {
      const overlapStart = Math.max(0, currentLine - overlapLines);
      const chunkEnd = Math.min(totalLines, currentLine + targetLinesPerChunk);

      const chunkContent = lines.slice(overlapStart, chunkEnd).join('\n');
      const actualStartLine = symbol.startLine + overlapStart;
      const actualEndLine = symbol.startLine + chunkEnd - 1;

      const parentChunk = chunks[chunkIndex - 1];
      const prevContent = parentChunk?.content || '';

      chunks.push({
        id: generateChunkId(symbol.filePath, symbol.name, 'sub_chunk', chunkIndex),
        type: 'sub_chunk',
        parentId: symbol.id,
        symbolId: symbol.id,
        symbolName: symbol.name,
        symbolKind: symbol.kind,
        filePath: symbol.filePath,
        startLine: actualStartLine,
        endLine: actualEndLine,
        content: chunkContent,
        ftsText: chunkContent,
        embeddingText: `${symbol.name} (part ${chunkIndex + 1})\n\n${chunkContent}`,
        signature: symbol.signature,
        className: symbol.className,
        metadata: {
          tokenCount: estimateTokenCount(chunkContent),
          overlapTokens: this.config.overlapTokens,
          chunkIndex,
          totalChunks: 0,
        },
      });

      currentLine = chunkEnd;
      chunkIndex++;
    }

    for (const chunk of chunks) {
      if (chunk.metadata) {
        chunk.metadata.totalChunks = chunkIndex;
      }
    }

    return chunks;
  }

  private createFileContextChunks(
    parseResult: ParseResult,
    fileContent: string
  ): RetrievalChunk[] {
    const chunks: RetrievalChunk[] = [];
    const filePath = parseResult.symbols[0]?.filePath || '';

    if (parseResult.imports.length > 0) {
      const importText = parseResult.imports
        .map((imp) => `import { ${imp.names.join(', ')} } from '${imp.module}'`)
        .join('\n');

      chunks.push({
        id: generateChunkId(filePath, '_imports', 'file_context'),
        type: 'file_context',
        symbolName: '_imports',
        symbolKind: 'constant',
        filePath,
        startLine: 1,
        endLine: parseResult.imports.length,
        content: importText,
        ftsText: importText,
        embeddingText: `Imports for ${filePath}:\n${importText}`,
        metadata: {
          contextType: 'imports',
        },
      });
    }

    if (parseResult.exports.length > 0) {
      const exportText = parseResult.exports
        .map((exp) => `export ${exp}`)
        .join('\n');

      chunks.push({
        id: generateChunkId(filePath, '_exports', 'file_context'),
        type: 'file_context',
        symbolName: '_exports',
        symbolKind: 'constant',
        filePath,
        startLine: 1,
        endLine: parseResult.exports.length,
        content: exportText,
        ftsText: exportText,
        embeddingText: `Exports for ${filePath}:\n${exportText}`,
        metadata: {
          contextType: 'exports',
        },
      });
    }

    return chunks;
  }

  private createCallsiteChunks(
    relationships: RelationshipInfo[],
    symbols: SymbolInfo[],
    fileContent: string
  ): RetrievalChunk[] {
    const chunks: RetrievalChunk[] = [];
    const lines = fileContent.split('\n');
    const contextLines = 20;

    const callsitesByTarget = new Map<string, RelationshipInfo[]>();
    for (const rel of relationships) {
      if (rel.type === 'calls') {
        const existing = callsitesByTarget.get(rel.target) || [];
        existing.push(rel);
        callsitesByTarget.set(rel.target, existing);
      }
    }

    for (const [targetName, callsites] of callsitesByTarget) {
      const limitedCallsites = callsites.slice(0, this.config.maxCallsitesPerSymbol);

      for (const callsite of limitedCallsites) {
        const callerSymbol = symbols.find(
          (s) =>
            s.startLine <= callsite.line &&
            s.endLine >= callsite.line
        );

        if (!callerSymbol) continue;

        const contextStartLine = Math.max(1, callsite.line - contextLines);
        const contextEndLine = Math.min(lines.length, callsite.line + contextLines);
        
        const contextContent = lines
          .slice(contextStartLine - 1, contextEndLine)
          .join('\n');

        const callsiteDescription = `Call to ${targetName} from ${callerSymbol.name} at line ${callsite.line}`;
        
        const ftsText = [
          targetName,
          callerSymbol.name,
          'call',
          'usage',
          callerSymbol.className || '',
          callerSymbol.kind,
        ].filter(Boolean).join(' ');

        const embeddingText = [
          `Callsite: ${targetName}`,
          `Caller: ${callerSymbol.name}${callerSymbol.className ? ` (${callerSymbol.className})` : ''}`,
          `Location: line ${callsite.line}`,
          '',
          'Context:',
          contextContent,
        ].join('\n');

        chunks.push({
          id: generateChunkId(
            callerSymbol.filePath,
            `${callerSymbol.name}_calls_${targetName}`,
            'callsite',
            callsite.line
          ),
          type: 'callsite',
          parentId: `call:${callerSymbol.filePath}:${callsite.line}`,
          symbolId: callerSymbol.id,
          symbolName: targetName,
          symbolKind: callerSymbol.kind,
          filePath: callerSymbol.filePath,
          startLine: contextStartLine,
          endLine: contextEndLine,
          content: contextContent,
          ftsText,
          embeddingText,
          signature: callerSymbol.signature,
          className: callerSymbol.className,
          metadata: {
            callerSymbolId: callerSymbol.id,
            callerSymbolName: callerSymbol.name,
            tokenCount: estimateTokenCount(contextContent),
          },
        });
      }
    }

    return chunks;
  }

  private buildFtsText(symbol: SymbolInfo): string {
    const parts: string[] = [symbol.name];

    if (symbol.signature) {
      parts.push(symbol.signature);
    }

    if (symbol.className) {
      parts.push(symbol.className);
    }

    if (symbol.docstring) {
      parts.push(symbol.docstring);
    }

    const normalizedIdentifiers = this.normalizeIdentifiers(symbol.name);
    if (normalizedIdentifiers.length > 0) {
      parts.push(normalizedIdentifiers.join(' '));
    }

    const contentPreview = symbol.content.slice(0, 500);
    parts.push(contentPreview);

    return parts.join(' ');
  }

  private buildEmbeddingText(symbol: SymbolInfo): string {
    const parts: string[] = [];

    parts.push(`Symbol: ${symbol.name}`);
    parts.push(`Kind: ${symbol.kind}`);

    if (symbol.className) {
      parts.push(`Class: ${symbol.className}`);
    }

    if (symbol.signature) {
      parts.push(`Signature: ${symbol.signature}`);
    }

    if (symbol.docstring) {
      parts.push(`Description: ${symbol.docstring}`);
    }

    if (symbol.isExported) {
      parts.push('Exported: true');
    }

    const normalizedIdentifiers = this.normalizeIdentifiers(symbol.name);
    if (normalizedIdentifiers.length > 0) {
      parts.push(`Keywords: ${normalizedIdentifiers.join(', ')}`);
    }

    parts.push('');
    parts.push(symbol.content);

    return parts.join('\n');
  }

  private normalizeIdentifiers(name: string): string[] {
    const result: string[] = [];
    
    const camelSplit = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const snakeSplit = name.replace(/_/g, ' ').toLowerCase();
    
    const words = new Set<string>();
    camelSplit.split(/\s+/).forEach(w => { if (w.length > 1) words.add(w); });
    snakeSplit.split(/\s+/).forEach(w => { if (w.length > 1) words.add(w); });
    
    words.forEach(w => {
      if (w !== name.toLowerCase()) {
        result.push(w);
      }
    });

    return result;
  }
}

export function createChunker(config?: Partial<ChunkingConfig>): Chunker {
  return new Chunker(config);
}
