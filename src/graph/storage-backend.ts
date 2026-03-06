/**
 * StorageBackend Interface - TypeScript port of Axon's StorageBackend protocol
 * 
 * Defines the interface all storage backends must implement.
 * Supports SQLite, with potential for other backends in the future.
 */

import {
  GraphNode,
  GraphRelationship,
  NodeLabel,
  RelType,
} from './model.js';
import { KnowledgeGraph } from './knowledge-graph.js';

/** Search result from the storage backend */
export interface SearchResult {
  /** Node ID */
  nodeId: string;
  /** Search score (higher = better match) */
  score: number;
  /** Node name */
  nodeName: string;
  /** File path */
  filePath: string;
  /** Node label/type */
  label: NodeLabel;
  /** Content snippet */
  snippet: string;
  /** Optional signature */
  signature?: string;
  /** Optional line range */
  startLine?: number;
  endLine?: number;
}

/** Node with its embedding vector */
export interface NodeEmbedding {
  /** Node ID */
  nodeId: string;
  /** Embedding vector (768 dimensions for embeddinggemma) */
  embedding: number[];
}

/** Node with depth from traversal */
export interface NodeWithDepth {
  node: GraphNode;
  depth: number;
}

/** File hash info for incremental indexing */
export interface FileHashInfo {
  filePath: string;
  hash: string;
  lastModified: number;
}

export interface SearchFilters {
  repoId?: string;
  branch?: string;
  commitSha?: string;
  pathPrefix?: string;
}

/** Traversal direction */
export type TraversalDirection = 'callers' | 'callees' | 'both';

/**
 * StorageBackend Interface
 * 
 * All methods return Promises for async database operations.
 */
export interface StorageBackend {
  // ==================== Lifecycle ====================

  /** Initialize the storage backend (create tables, indexes) */
  initialize(path: string): Promise<void>;

  /** Close the storage backend (cleanup resources) */
  close(): Promise<void>;

  // ==================== Node Operations ====================

  /** Add nodes to storage */
  addNodes(nodes: GraphNode[]): Promise<void>;

  /** Add relationships to storage */
  addRelationships(relationships: GraphRelationship[]): Promise<void>;

  /** Remove all nodes/relationships for a file */
  removeNodesByFile(filePath: string): Promise<void>;

  /** Get a single node by ID */
  getNode(nodeId: string): Promise<GraphNode | undefined>;

  /** Get multiple nodes by IDs */
  getNodes(nodeIds: string[]): Promise<GraphNode[]>;

  // ==================== Call Graph Queries ====================

  /** Get all callers of a node */
  getCallers(nodeId: string): Promise<GraphNode[]>;

  /** Get all callees of a node */
  getCallees(nodeId: string): Promise<GraphNode[]>;

  /** Get callers with confidence scores */
  getCallersWithConfidence(nodeId: string): Promise<Array<{ caller: GraphNode; confidence: number }>>;

  /** Get callees with confidence scores */
  getCalleesWithConfidence(nodeId: string): Promise<Array<{ callee: GraphNode; confidence: number }>>;

  // ==================== Graph Traversal ====================

  /** Traverse call graph from a node */
  traverse(
    startId: string,
    depth: number,
    direction: TraversalDirection
  ): Promise<GraphNode[]>;

  /** Traverse with depth information */
  traverseWithDepth(
    startId: string,
    depth: number,
    direction: TraversalDirection
  ): Promise<NodeWithDepth[]>;

  // ==================== Type References ====================

  /** Get nodes that use a type */
  getTypeRefs(nodeId: string): Promise<GraphNode[]>;

  // ==================== Search ====================

  /** Exact name search */
  exactNameSearch(name: string, limit?: number): Promise<SearchResult[]>;

  /** Full-text search (BM25) */
  ftsSearch(query: string, limit?: number, filters?: SearchFilters): Promise<SearchResult[]>;

  /** Fuzzy search (Levenshtein) */
  fuzzySearch(query: string, limit?: number): Promise<SearchResult[]>;

  // ==================== Embeddings ====================

  /** Store embeddings for nodes */
  storeEmbeddings(embeddings: NodeEmbedding[]): Promise<void>;

  /** Vector similarity search */
  vectorSearch(vector: number[], limit?: number, filters?: SearchFilters): Promise<SearchResult[]>;

  /** Get embedding for a node */
  getEmbedding(nodeId: string): Promise<number[] | undefined>;

  // ==================== File Tracking ====================

  /** Get all indexed files with their hashes */
  getIndexedFiles(): Promise<Map<string, FileHashInfo>>;

  /** Update file hash */
  updateFileHash(filePath: string, hash: string): Promise<void>;

  // ==================== Bulk Operations ====================

  /** Bulk load a graph (replaces existing data) */
  bulkLoad(graph: KnowledgeGraph): Promise<void>;

  /** Clear all data */
  clear(): Promise<void>;

  /** Get all symbol nodes (for cross-file relationship resolution) */
  getAllSymbols(): Promise<GraphNode[]>;

  // ==================== Statistics ====================

  /** Get node count */
  getNodeCount(): Promise<number>;

  /** Get relationship count */
  getRelationshipCount(): Promise<number>;

  /** Get storage statistics */
  getStats(): Promise<{
    nodeCount: number;
    relationshipCount: number;
    nodesByLabel: Record<string, number>;
    relationshipsByType: Record<string, number>;
    embeddingCount: number;
  }>;
}
