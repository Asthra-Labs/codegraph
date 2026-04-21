/**
 * Unified QMD Interface
 * 
 * Single entry point for all QMD functionality:
 * - Document indexing and search (existing QMD)
 * - Code graph indexing and search (migrated from Axon)
 * - Hybrid search combining both
 * 
 * This is the main API for xyne-cli integration.
 */

import * as path from 'path';
import * as fs from 'fs';
import { openDatabase, type Database as DatabaseType } from './db.js';
import {
  GraphNode,
  GraphRelationship,
  NodeLabel,
  RelType,
  KnowledgeGraph,
  SQLiteBackend,
  generateNodeId,
} from './graph/index.js';
import type {
  SearchResult,
  NodeEmbedding,
  StorageBackend,
} from './graph/storage-backend.js';
import {
  IngestionPipeline,
  ingestRepository,
} from './ingestion/index.js';
import type { PipelineOptions, PipelineResult } from './ingestion/index.js';
import {
  hybridSearch,
  codeAwareSearch,
} from './search/index.js';
import type { HybridSearchOptions } from './search/index.js';
import {
  embedGraph,
  embedGraphBatch,
  embedNodesForFiles,
  generateNodeText,
} from './embeddings/index.js';
import { LlamaCpp } from './llm.js';

/** QMD configuration */
export interface QMDConfig {
  /** Path to the database file */
  dbPath?: string;
  /** Path to the embedding model */
  embeddingModelPath?: string;
  /** Whether to enable graph search */
  enableGraph?: boolean;
  /** Whether to enable document search */
  enableDocuments?: boolean;
}

/** Result of indexing a repository */
export interface IndexResult {
  /** Number of files processed */
  filesProcessed: number;
  /** Number of symbols extracted */
  symbolsExtracted: number;
  /** Number of relationships created */
  relationshipsCreated: number;
  /** Number of embeddings generated */
  embeddingsGenerated: number;
  /** Duration in seconds */
  durationSeconds: number;
}

/** Search result with unified format */
export interface UnifiedSearchResult {
  /** Unique identifier */
  id: string;
  /** Type of result */
  type: 'symbol' | 'document' | 'chunk';
  /** Name or title */
  name: string;
  /** File path */
  filePath: string;
  /** Content snippet */
  snippet: string;
  /** Relevance score */
  score: number;
  /** Additional metadata */
  metadata?: {
    label?: string;
    signature?: string;
    startLine?: number;
    endLine?: number;
    language?: string;
    callers?: string[];
    callees?: string[];
  };
}

/**
 * Unified QMD - Single interface for code intelligence
 * 
 * Combines:
 * - Document indexing (RAG chunks)
 * - Code graph (symbols, call graph, heritage)
 * - Hybrid search (FTS + vector + graph)
 */
export class UnifiedQMD {
  private db: DatabaseType | null = null;
  private graphBackend: SQLiteBackend | null = null;
  private llm: LlamaCpp | null = null;
  private config: Required<QMDConfig>;
  private initialized = false;

  constructor(config: QMDConfig = {}) {
    this.config = {
      dbPath: config.dbPath ?? './qmd.db',
      embeddingModelPath: config.embeddingModelPath ?? '',
      enableGraph: config.enableGraph ?? true,
      enableDocuments: config.enableDocuments ?? true,
    };
  }

  /**
   * Initialize QMD
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure directory exists
    const dbDir = path.dirname(this.config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Initialize database
    this.db = openDatabase(this.config.dbPath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // Ignore if PRAGMA is not supported
    }

    // Create tables
    this.createTables();

    // Initialize graph backend
    if (this.config.enableGraph) {
      this.graphBackend = new SQLiteBackend();
      await this.graphBackend.initialize(this.config.dbPath);
    }

    // Initialize LLM for embeddings
    // If no path provided, LlamaCpp will use its default model and auto-download if needed
    const embedModelPath = this.config.embeddingModelPath || undefined;
    this.llm = new LlamaCpp({
      embedModel: embedModelPath,
    });

    this.initialized = true;
  }

  /**
   * Close QMD and release resources
   */
  async close(): Promise<void> {
    if (this.graphBackend) {
      await this.graphBackend.close();
      this.graphBackend = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    if (this.llm) {
      this.llm = null;
    }
    this.initialized = false;
  }

  // ==================== Indexing ====================

  /**
   * Index a repository
   */
  async indexRepository(
    repoPath: string,
    options?: {
      generateEmbeddings?: boolean;
      detectDeadCode?: boolean;
      extensions?: string[];
      ignorePatterns?: string[];
      onProgress?: (phase: string, progress: number, message?: string) => void;
    }
  ): Promise<IndexResult> {
    await this.ensureInitialized();

    const pipeline = new IngestionPipeline({
      storage: this.graphBackend!,
      generateEmbeddings: options?.generateEmbeddings ?? true,
      detectDeadCode: options?.detectDeadCode ?? true,
      extensions: options?.extensions,
      ignorePatterns: options?.ignorePatterns,
      onProgress: options?.onProgress,
    });

    const { graph, result } = await pipeline.run(repoPath);

    // Generate embeddings if LLM is available — use batch for efficiency
    let embeddingsGenerated = 0;
    if (options?.generateEmbeddings !== false && this.llm) {
      const embeddings = await embedGraphBatch(graph, async (texts) => {
        const results = await this.llm!.embedBatch(texts);
        return results.map(r => r?.embedding ?? []);
      }, {
        batchSize: 32,
        onProgress: (processed, total) => {
          options?.onProgress?.('embeddings', processed / total, `Embedded ${processed}/${total} symbols`);
        },
      });

      await this.graphBackend!.storeEmbeddings(embeddings);
      embeddingsGenerated = embeddings.length;
    }

    return {
      filesProcessed: result.filesProcessed,
      symbolsExtracted: result.symbolsExtracted,
      relationshipsCreated: result.relationshipsCreated,
      embeddingsGenerated,
      durationSeconds: result.durationSeconds,
    };
  }

  // ==================== Search ====================

  /**
   * Search for code symbols
   */
  async search(
    query: string,
    options?: HybridSearchOptions & {
      includeDocuments?: boolean;
    }
  ): Promise<UnifiedSearchResult[]> {
    const { results } = await this.searchWithTelemetry(query, options);
    return results;
  }

  /**
   * Search and return both results and telemetry.
   * This keeps backward compatibility for existing `search()` callers while
   * allowing downstream runtimes to consume rerank/query-detection telemetry.
   */
  async searchWithTelemetry(
    query: string,
    options?: HybridSearchOptions & {
      includeDocuments?: boolean;
    }
  ): Promise<{
    results: UnifiedSearchResult[];
    telemetry: Awaited<ReturnType<typeof hybridSearch>>['telemetry'];
  }> {
    await this.ensureInitialized();

    // Get query embedding if LLM is available
    let queryEmbedding: number[] | null = null;
    if (this.llm) {
      try {
        const result = await this.llm.embed(query);
        queryEmbedding = result?.embedding ?? null;
      } catch {
        // Continue without embedding
      }
    }

    // Perform hybrid search
    const searchResult = await hybridSearch(
      query,
      this.graphBackend!,
      queryEmbedding,
      options
    );

    return {
      results: searchResult.results.map(r => this.searchResultToUnified(r)),
      telemetry: searchResult.telemetry,
    };
  }

  /**
   * Get symbol by ID
   */
  async getSymbol(symbolId: string): Promise<GraphNode | undefined> {
    await this.ensureInitialized();
    return this.graphBackend!.getNode(symbolId);
  }

  /**
   * Get callers of a symbol
   */
  async getCallers(symbolId: string): Promise<UnifiedSearchResult[]> {
    await this.ensureInitialized();
    const callers = await this.graphBackend!.getCallers(symbolId);
    return callers.map(node => this.nodeToResult(node, 1.0));
  }

  /**
   * Get callees of a symbol
   */
  async getCallees(symbolId: string): Promise<UnifiedSearchResult[]> {
    await this.ensureInitialized();
    const callees = await this.graphBackend!.getCallees(symbolId);
    return callees.map(node => this.nodeToResult(node, 1.0));
  }

  /**
   * Traverse call graph from a symbol
   */
  async traverseCallGraph(
    symbolId: string,
    depth: number = 2,
    direction: 'callers' | 'callees' | 'both' = 'both'
  ): Promise<UnifiedSearchResult[]> {
    await this.ensureInitialized();
    const results = await this.graphBackend!.traverseWithDepth(symbolId, depth, direction);
    return results.map(({ node, depth: d }) => ({
      ...this.nodeToResult(node, 1.0 / (d + 1)),
      metadata: {
        ...this.nodeToResult(node, 1.0).metadata,
        label: node.label,
      },
    }));
  }

  // ==================== Stats ====================

  /**
   * Get statistics about the indexed code
   */
  async getStats(): Promise<{
    nodeCount: number;
    relationshipCount: number;
    nodesByLabel: Record<string, number>;
    relationshipsByType: Record<string, number>;
    embeddingCount: number;
  }> {
    await this.ensureInitialized();
    return this.graphBackend!.getStats();
  }

  /**
   * Get all unique file paths in the index
   */
  async getIndexedFilePaths(): Promise<string[]> {
    await this.ensureInitialized();
    if (!this.db) return [];
    
    const rows = this.db.prepare('SELECT DISTINCT file_path FROM graph_nodes').all() as { file_path: string }[];
    return rows.map(r => r.file_path).filter(Boolean);
  }

  /**
   * Incrementally re-index specific files
   */
  async reindexFiles(
    changedFiles: string[],
    deletedFiles: string[] = []
  ): Promise<{ symbolsUpdated: number; relationshipsUpdated: number; embeddingsGenerated: number; errors: Array<{ file: string; error: string }> }> {
    await this.ensureInitialized();

    const pipeline = new IngestionPipeline({
      storage: this.graphBackend!,
      generateEmbeddings: false,
      detectDeadCode: true,
    });

    const result = await pipeline.reindexFiles(changedFiles, deletedFiles);

    let embeddingsGenerated = 0;
    if (result.symbolsUpdated > 0 && this.llm) {
      console.log(`   🔄 Generating embeddings for ${result.symbolsUpdated} updated symbols...`);
      
      const allSymbols = await this.graphBackend!.getAllSymbols();
      const graph = new KnowledgeGraph();
      for (const node of allSymbols) {
        graph.addNode(node);
      }

      const embeddings = await embedNodesForFiles(graph, async (text) => {
        const embResult = await this.llm!.embed(text);
        return embResult?.embedding ?? [];
      }, changedFiles, {
        batchSize: 10,
      });

      if (embeddings.length > 0) {
        await this.graphBackend!.storeEmbeddings(embeddings);
        embeddingsGenerated = embeddings.length;
        console.log(`   ✅ Generated ${embeddingsGenerated} embeddings`);
      }
    }

    return { ...result, embeddingsGenerated };
  }

  // ==================== Private ====================

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private createTables(): void {
    // Graph tables are created by SQLiteBackend
    // Document tables can be added here if needed
  }

  private searchResultToUnified(result: SearchResult): UnifiedSearchResult {
    return {
      id: result.nodeId,
      type: 'symbol',
      name: result.nodeName,
      filePath: result.filePath,
      snippet: result.snippet,
      score: result.score,
      metadata: {
        label: result.label,
        signature: result.signature,
        startLine: result.startLine,
        endLine: result.endLine,
      },
    };
  }

  private nodeToResult(node: GraphNode, score: number): UnifiedSearchResult {
    return {
      id: node.id,
      type: 'symbol',
      name: node.name,
      filePath: node.filePath,
      snippet: node.content?.substring(0, 200) ?? '',
      score,
      metadata: {
        label: node.label,
        signature: node.signature ?? undefined,
        startLine: node.startLine ?? undefined,
        endLine: node.endLine ?? undefined,
        language: node.language ?? undefined,
      },
    };
  }
}

// Re-export types and classes
export {
  GraphNode,
  GraphRelationship,
  NodeLabel,
  RelType,
  KnowledgeGraph,
  SQLiteBackend,
  generateNodeId,
};

export type { SearchResult, NodeEmbedding };

export { UnifiedQMD as QMD };
