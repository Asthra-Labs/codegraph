/**
 * SQLite Storage Backend - Implements StorageBackend using SQLite with sqlite-vec
 * 
 * Migrated from Axon's KuzuBackend, adapted for SQLite with:
 * - Unified nodes table (vs Kuzu's per-label tables)
 * - sqlite-vec for vector similarity search
 * - FTS5 for full-text search
 * - Recursive CTEs for graph traversal
 */

import * as fs from 'fs';
import * as path from 'path';
import { openDatabase, loadSqliteVec, type Database as DatabaseType } from '../db.js';
import { incrementVectorFallbackCount } from './vector-fallback-monitor.js';
import { GraphNode, GraphRelationship, NodeLabel, RelType } from './model.js';
import type { GraphNodeJSON, GraphRelationshipProperties } from './model.js';
import type {
  StorageBackend,
  SearchResult,
  NodeEmbedding,
  NodeWithDepth,
  FileHashInfo,
  TraversalDirection,
  SearchFilters,
} from './storage-backend.js';
import { KnowledgeGraph } from './knowledge-graph.js';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '../migrations/schema.js';

type Database = DatabaseType;

/** Embedding dimension (768 for embeddinggemma) */
const EMBEDDING_DIM = 768;

/**
 * SQLite Storage Backend Implementation
 */
export class SQLiteBackend implements StorageBackend {
  private db: Database | null = null;
  private dbPath: string | null = null;

  async initialize(dbPath: string): Promise<void> {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    this.dbPath = dbPath;
    this.db = openDatabase(dbPath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // PRAGMA may not be supported in all SQLite implementations
    }
    
    // Load sqlite-vec extension for vector similarity search
    loadSqliteVec(this.db);
    
    // Run schema migrations (idempotent)
    runMigrations(this.db, CURRENT_SCHEMA_VERSION);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private getDb(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  // ==================== Schema Creation ====================

  private createTables(): void {
    const db = this.getDb();

    // Nodes table - unified table for all node types
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        content TEXT,
        signature TEXT,
        language TEXT,
        class_name TEXT,
        is_dead INTEGER DEFAULT 0,
        is_entry_point INTEGER DEFAULT 0,
        is_exported INTEGER DEFAULT 0,
        properties TEXT
      )
    `);

    // Relationships table
    db.exec(`
      CREATE TABLE IF NOT EXISTS graph_relationships (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        confidence REAL DEFAULT 1.0,
        role TEXT,
        step_number INTEGER,
        strength REAL,
        co_changes INTEGER,
        symbols TEXT,
        line INTEGER
      )
    `);

    // Node embeddings table using sqlite-vec
    // Note: sqlite-vec virtual table must be created after extension is loaded
    // For now, use BLOB storage and create virtual table dynamically
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_embeddings_raw (
        node_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
      )
    `);

    // FTS5 virtual table for full-text search (standalone, manually populated)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
        id,
        name,
        content,
        signature,
        file_path
      )
    `);

    // File hashes table for incremental indexing
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        last_modified INTEGER NOT NULL
      )
    `);
  }

  private createIndexes(): void {
    const db = this.getDb();

    // Indexes for common queries
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_label ON graph_nodes(label)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_name ON graph_nodes(name)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON graph_nodes(file_path)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rels_type ON graph_relationships(type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rels_source ON graph_relationships(source)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rels_target ON graph_relationships(target)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rels_source_type ON graph_relationships(source, type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_rels_target_type ON graph_relationships(target, type)`);
  }

  private createVectorTable(): void {
    const db = this.getDb();
    
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
    `).get();
    
    if (!tableExists) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS node_embeddings_vec USING vec0(
          node_id TEXT PRIMARY KEY,
          embedding float[${EMBEDDING_DIM}] distance_metric=cosine
        )
      `);
      
      this.migrateEmbeddingsToVec();
    }
  }

  private migrateEmbeddingsToVec(): void {
    const db = this.getDb();
    
    const { count } = db.prepare(`
      SELECT COUNT(*) as count FROM node_embeddings_raw
    `).get() as { count: number };
    
    if (count === 0) return;
    
    const rows = db.prepare(`
      SELECT node_id, embedding FROM node_embeddings_raw
    `).all() as { node_id: string; embedding: Buffer }[];
    
    const insert = db.prepare(`
      INSERT OR REPLACE INTO node_embeddings_vec (node_id, embedding)
      VALUES (?, ?)
    `);
    
    const transaction = db.transaction(() => {
      for (const row of rows) {
        const buffer = Buffer.isBuffer(row.embedding) 
          ? row.embedding 
          : Buffer.from(row.embedding as Uint8Array);
        
        const float32 = new Float32Array(buffer.length / 4);
        for (let i = 0; i < float32.length; i++) {
          float32[i] = buffer.readFloatLE(i * 4);
        }
        
        insert.run(row.node_id, float32);
      }
    });
    
    transaction();
  }

  // ==================== Node Operations ====================

  async addNodes(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;

    const db = this.getDb();
    const insertNode = db.prepare(`
      INSERT OR REPLACE INTO graph_nodes (
        id, label, name, file_path, start_line, end_line,
        content, signature, language, class_name,
        is_dead, is_entry_point, is_exported, properties
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = db.prepare(`
      INSERT OR REPLACE INTO graph_nodes_fts (id, name, content, signature, file_path)
      VALUES (?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
      for (const node of nodes) {
        const json = node.toJSON();
        insertNode.run(
          node.id,
          node.label,
          node.name,
          node.filePath,
          node.startLine,
          node.endLine,
          node.content,
          node.signature,
          node.language,
          node.className,
          node.isDead ? 1 : 0,
          node.isEntryPoint ? 1 : 0,
          node.isExported ? 1 : 0,
          JSON.stringify(node.properties)
        );

        // Update FTS index
        insertFts.run(
          node.id,
          node.name,
          node.content || '',
          node.signature || '',
          node.filePath
        );
      }
    });

    transaction();
  }

  async addRelationships(relationships: GraphRelationship[]): Promise<void> {
    if (relationships.length === 0) return;

    const db = this.getDb();
    const insert = db.prepare(`
      INSERT OR REPLACE INTO graph_relationships (
        id, type, source, target, confidence, role, step_number,
        strength, co_changes, symbols, line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction(() => {
      for (const rel of relationships) {
        insert.run(
          rel.id,
          rel.type,
          rel.source,
          rel.target,
          rel.properties.confidence ?? 1.0,
          rel.properties.role ?? null,
          rel.properties.stepNumber ?? null,
          rel.properties.strength ?? null,
          rel.properties.coChanges ?? null,
          rel.properties.symbols ? JSON.stringify(rel.properties.symbols) : null,
          rel.properties.line ?? null
        );
      }
    });

    transaction();
  }

  async removeNodesByFile(filePath: string): Promise<void> {
    const db = this.getDb();

    const nodes = db.prepare(`SELECT id FROM graph_nodes WHERE file_path = ?`).all(filePath) as { id: string }[];
    
    if (nodes.length === 0) return;

    const nodeIds = nodes.map(n => n.id);

    const deleteEmbeddingsRaw = db.prepare(`DELETE FROM node_embeddings_raw WHERE node_id = ?`);
    const deleteEmbeddingsVec = db.prepare(`DELETE FROM node_embeddings_vec WHERE node_id = ?`);
    const deleteRels = db.prepare(`
      DELETE FROM graph_relationships 
      WHERE source IN (SELECT id FROM graph_nodes WHERE file_path = ?)
         OR target IN (SELECT id FROM graph_nodes WHERE file_path = ?)
    `);
    const deleteFts = db.prepare(`DELETE FROM graph_nodes_fts WHERE id = ?`);
    const deleteNodes = db.prepare(`DELETE FROM graph_nodes WHERE file_path = ?`);

    const transaction = db.transaction(() => {
      for (const nodeId of nodeIds) {
        deleteEmbeddingsRaw.run(nodeId);
        deleteEmbeddingsVec.run(nodeId);
        deleteFts.run(nodeId);
      }

      deleteRels.run(filePath, filePath);
      deleteNodes.run(filePath);
    });

    transaction();
  }

  async getNode(nodeId: string): Promise<GraphNode | undefined> {
    const db = this.getDb();
    const row = db.prepare(`
      SELECT * FROM graph_nodes WHERE id = ?
    `).get(nodeId) as GraphNodeRow | undefined;

    if (!row) return undefined;
    return this.rowToNode(row);
  }

  async getNodes(nodeIds: string[]): Promise<GraphNode[]> {
    if (nodeIds.length === 0) return [];

    const db = this.getDb();
    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT * FROM graph_nodes WHERE id IN (${placeholders})
    `).all(...nodeIds) as GraphNodeRow[];

    return rows.map(row => this.rowToNode(row));
  }

  // ==================== Call Graph Queries ====================

  async getCallers(nodeId: string): Promise<GraphNode[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT n.* FROM graph_nodes n
      JOIN graph_relationships r ON n.id = r.source
      WHERE r.target = ? AND r.type = ?
    `).all(nodeId, RelType.CALLS) as GraphNodeRow[];

    return rows.map(row => this.rowToNode(row));
  }

  async getCallees(nodeId: string): Promise<GraphNode[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT n.* FROM graph_nodes n
      JOIN graph_relationships r ON n.id = r.target
      WHERE r.source = ? AND r.type = ?
    `).all(nodeId, RelType.CALLS) as GraphNodeRow[];

    return rows.map(row => this.rowToNode(row));
  }

  async getCallersWithConfidence(nodeId: string): Promise<Array<{ caller: GraphNode; confidence: number }>> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT n.*, r.confidence FROM graph_nodes n
      JOIN graph_relationships r ON n.id = r.source
      WHERE r.target = ? AND r.type = ?
    `).all(nodeId, RelType.CALLS) as (GraphNodeRow & { confidence: number })[];

    return rows.map(row => ({
      caller: this.rowToNode(row),
      confidence: row.confidence ?? 1.0,
    }));
  }

  async getCalleesWithConfidence(nodeId: string): Promise<Array<{ callee: GraphNode; confidence: number }>> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT n.*, r.confidence FROM graph_nodes n
      JOIN graph_relationships r ON n.id = r.target
      WHERE r.source = ? AND r.type = ?
    `).all(nodeId, RelType.CALLS) as (GraphNodeRow & { confidence: number })[];

    return rows.map(row => ({
      callee: this.rowToNode(row),
      confidence: row.confidence ?? 1.0,
    }));
  }

  // ==================== Graph Traversal ====================

  async traverse(
    startId: string,
    depth: number,
    direction: TraversalDirection
  ): Promise<GraphNode[]> {
    const result = await this.traverseWithDepth(startId, depth, direction);
    return result.map(r => r.node);
  }

  async traverseWithDepth(
    startId: string,
    depth: number,
    direction: TraversalDirection
  ): Promise<NodeWithDepth[]> {
    const db = this.getDb();
    const maxDepth = depth > 0 ? depth : 10; // Cap at 10 for safety
    const visited = new Set<string>();
    const result: NodeWithDepth[] = [];
    const queue: Array<{ id: string; currentDepth: number }> = [{ id: startId, currentDepth: 0 }];

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift()!;

      if (visited.has(id)) continue;
      visited.add(id);

      // Get the node
      const node = await this.getNode(id);
      if (node && id !== startId) {
        result.push({ node, depth: currentDepth });
      }

      // Stop if max depth reached
      if (currentDepth >= maxDepth) continue;

      // Get neighbors based on direction
      let neighbors: Array<{ id: string; confidence: number }> = [];

      if (direction === 'callers' || direction === 'both') {
        const callers = db.prepare(`
          SELECT source as id, confidence FROM graph_relationships
          WHERE target = ? AND type = ?
        `).all(id, RelType.CALLS) as { id: string; confidence: number }[];
        neighbors.push(...callers);
      }

      if (direction === 'callees' || direction === 'both') {
        const callees = db.prepare(`
          SELECT target as id, confidence FROM graph_relationships
          WHERE source = ? AND type = ?
        `).all(id, RelType.CALLS) as { id: string; confidence: number }[];
        neighbors.push(...callees);
      }

      // Add unvisited neighbors to queue
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor.id)) {
          queue.push({ id: neighbor.id, currentDepth: currentDepth + 1 });
        }
      }
    }

    return result;
  }

  // ==================== Type References ====================

  async getTypeRefs(nodeId: string): Promise<GraphNode[]> {
    const db = this.getDb();
    const rows = db.prepare(`
      SELECT n.* FROM graph_nodes n
      JOIN graph_relationships r ON n.id = r.source
      WHERE r.target = ? AND r.type = ?
    `).all(nodeId, RelType.USES_TYPE) as GraphNodeRow[];

    return rows.map(row => this.rowToNode(row));
  }

  // ==================== Search ====================

  async exactNameSearch(name: string, limit: number = 20): Promise<SearchResult[]> {
    const db = this.getDb();
    
    // Exact match with boost for non-test files
    const rows = db.prepare(`
      SELECT *, 
        CASE 
          WHEN file_path LIKE '%test%' OR file_path LIKE '%spec%' THEN 0.8
          ELSE 1.0
        END as score
      FROM graph_nodes
      WHERE name = ?
      ORDER BY score DESC, name
      LIMIT ?
    `).all(name, limit) as (GraphNodeRow & { score: number })[];

    return rows.map(row => this.rowToSearchResult(row, row.score));
  }

  async ftsSearch(query: string, limit: number = 20, filters?: SearchFilters): Promise<SearchResult[]> {
    return this.ftsSearchWithFilters(query, limit, filters);
  }

  async ftsSearchWithFilters(
    query: string, 
    limit: number = 20,
    filters?: SearchFilters
  ): Promise<SearchResult[]> {
    const db = this.getDb();

    const terms = query.split(/\s+/).filter(t => t.length > 0);
    
    const filterConditions: string[] = [];
    const filterParams: any[] = [];
    
    if (filters?.repoId) {
      filterConditions.push('n.repo_id = ?');
      filterParams.push(filters.repoId);
    }
    if (filters?.branch) {
      filterConditions.push('n.branch = ?');
      filterParams.push(filters.branch);
    }
    if (filters?.commitSha) {
      filterConditions.push('n.commit_sha = ?');
      filterParams.push(filters.commitSha);
    }
    if (filters?.pathPrefix) {
      filterConditions.push('n.file_path LIKE ?');
      filterParams.push(`${filters.pathPrefix}%`);
    }
    
    const filterClause = filterConditions.length > 0 
      ? `AND ${filterConditions.join(' AND ')}`
      : '';
    
    // Try AND logic first (higher precision)
    const andQuery = terms.map(t => `"${t}"`).join(' AND ');
    let rows = db.prepare(`
      SELECT
        n.id, n.label, n.name, n.file_path, n.start_line, n.end_line,
        n.content, n.signature,
        bm25(graph_nodes_fts) as bm25_score
      FROM graph_nodes_fts(?) fts
      JOIN graph_nodes n ON fts.id = n.id
      WHERE 1=1 ${filterClause}
      ORDER BY bm25_score
      LIMIT ?
    `).all(andQuery, ...filterParams, limit) as (GraphNodeRow & { bm25_score: number })[];

    // Fallback to OR logic if AND returns no results (better recall)
    if (rows.length === 0 && terms.length > 1) {
      const orQuery = terms.map(t => `"${t}"`).join(' OR ');
      rows = db.prepare(`
        SELECT
          n.id, n.label, n.name, n.file_path, n.start_line, n.end_line,
          n.content, n.signature,
          bm25(graph_nodes_fts) as bm25_score
        FROM graph_nodes_fts(?) fts
        JOIN graph_nodes n ON fts.id = n.id
        WHERE 1=1 ${filterClause}
        ORDER BY bm25_score
        LIMIT ?
      `).all(orQuery, ...filterParams, limit) as (GraphNodeRow & { bm25_score: number })[];
    }

    return rows.map(row => {
      const rawScore = row.bm25_score;
      const score = rawScore < 0
        ? Math.abs(rawScore) / (1 + Math.abs(rawScore))
        : 0.1;

      let adjustedScore = score;
      if (row.file_path?.includes('test') || row.file_path?.includes('spec')) {
        adjustedScore *= 0.5;
      }
      if (row.label === NodeLabel.FUNCTION || row.label === NodeLabel.CLASS) {
        adjustedScore *= 1.2;
      }
      adjustedScore = Math.min(1.0, adjustedScore);

      return this.rowToSearchResult(row, adjustedScore);
    });
  }

  async fuzzySearch(query: string, limit: number = 20): Promise<SearchResult[]> {
    const db = this.getDb();

    // Get all nodes with similar names using LIKE
    const pattern = `%${query}%`;
    const rows = db.prepare(`
      SELECT * FROM graph_nodes
      WHERE name LIKE ? OR content LIKE ?
      LIMIT ?
    `).all(pattern, pattern, limit * 2) as GraphNodeRow[];

    // Calculate Levenshtein distance and score
    const results = rows.map(row => {
      const distance = this.levenshteinDistance(query.toLowerCase(), row.name.toLowerCase());
      const maxLen = Math.max(query.length, row.name.length);
      const similarity = 1.0 - (distance / maxLen);
      const score = Math.max(0, similarity - 0.3 * distance / 10);

      return this.rowToSearchResult(row, score);
    });

    // Sort by score and return top results
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ==================== Embeddings ====================

  async storeEmbeddings(embeddings: NodeEmbedding[]): Promise<void> {
    if (embeddings.length === 0) return;

    const db = this.getDb();
    const insertRaw = db.prepare(`
      INSERT OR REPLACE INTO node_embeddings_raw (node_id, embedding)
      VALUES (?, ?)
    `);

    const vecTableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
    `).get();
    
    const insertVec = vecTableExists ? db.prepare(`
      INSERT OR REPLACE INTO node_embeddings_vec (node_id, embedding)
      VALUES (?, ?)
    `) : null;

    const transaction = db.transaction(() => {
      for (const emb of embeddings) {
        const buffer = Buffer.alloc(emb.embedding.length * 4);
        const float32 = new Float32Array(emb.embedding.length);
        
        for (let i = 0; i < emb.embedding.length; i++) {
          const val = emb.embedding[i];
          if (val !== undefined) {
            buffer.writeFloatLE(val, i * 4);
            float32[i] = val;
          }
        }
        
        insertRaw.run(emb.nodeId, buffer);
        if (insertVec) {
          insertVec.run(emb.nodeId, float32);
        }
      }
    });

    transaction();
  }

  async vectorSearch(vector: number[], limit: number = 20, filters?: SearchFilters): Promise<SearchResult[]> {
    const db = this.getDb();

    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
    `).get();
    
    if (!tableExists) {
      const allowFallback = process.env.ALLOW_BRUTE_FORCE_VECTOR_FALLBACK === 'true';
      
      if (!allowFallback) {
        throw new Error(
          `Vector search failed: node_embeddings_vec table does not exist. ` +
          `This indicates sqlite-vec extension is not loaded or vector table was not created. ` +
          `Remediation: Ensure sqlite-vec extension is loaded during initialization. ` +
          `To allow brute-force fallback (not recommended for production), set ALLOW_BRUTE_FORCE_VECTOR_FALLBACK=true`
        );
      }
      
      console.warn(
        `[WARN] vector_fallback_used=1 - Using brute-force vector search. ` +
        `This is O(n) and will not scale. Set up sqlite-vec for production use.`
      );
      incrementVectorFallbackCount();
      
      return this.vectorSearchFallback(vector, limit, filters);
    }

    const vecResults = db.prepare(`
      SELECT node_id, distance
      FROM node_embeddings_vec
      WHERE embedding MATCH ? AND k = ?
    `).all(new Float32Array(vector), limit * 3) as { node_id: string; distance: number }[];

    if (vecResults.length === 0) return [];

    const nodeIds = vecResults.map(r => r.node_id);
    const distanceMap = new Map(vecResults.map(r => [r.node_id, r.distance]));

    const placeholders = nodeIds.map(() => '?').join(',');
    const filterConditions: string[] = [];
    const filterParams: Array<string> = [];
    if (filters?.repoId) {
      filterConditions.push(`repo_id = ?`);
      filterParams.push(filters.repoId);
    }
    if (filters?.branch) {
      filterConditions.push(`branch = ?`);
      filterParams.push(filters.branch);
    }
    if (filters?.commitSha) {
      filterConditions.push(`commit_sha = ?`);
      filterParams.push(filters.commitSha);
    }
    if (filters?.pathPrefix) {
      filterConditions.push(`file_path LIKE ?`);
      filterParams.push(`${filters.pathPrefix}%`);
    }
    const whereFilters = filterConditions.length > 0
      ? ` AND ${filterConditions.join(' AND ')}`
      : '';

    const nodeRows = db.prepare(`
      SELECT * FROM graph_nodes WHERE id IN (${placeholders})${whereFilters}
    `).all(...nodeIds, ...filterParams) as GraphNodeRow[];

    const results: Array<{ row: GraphNodeRow; score: number }> = [];
    
    for (const row of nodeRows) {
      const distance = distanceMap.get(row.id);
      if (distance !== undefined) {
        const similarity = 1 - distance;
        results.push({ row, score: similarity });
      }
    }

    results.sort((a, b) => b.score - a.score);
    
    return results.slice(0, limit).map(r => this.rowToSearchResult(r.row, r.score));
  }

  private async vectorSearchFallback(vector: number[], limit: number, filters?: SearchFilters): Promise<SearchResult[]> {
    const db = this.getDb();

    const filterConditions: string[] = [];
    const filterParams: Array<string> = [];
    if (filters?.repoId) {
      filterConditions.push(`n.repo_id = ?`);
      filterParams.push(filters.repoId);
    }
    if (filters?.branch) {
      filterConditions.push(`n.branch = ?`);
      filterParams.push(filters.branch);
    }
    if (filters?.commitSha) {
      filterConditions.push(`n.commit_sha = ?`);
      filterParams.push(filters.commitSha);
    }
    if (filters?.pathPrefix) {
      filterConditions.push(`n.file_path LIKE ?`);
      filterParams.push(`${filters.pathPrefix}%`);
    }
    const whereFilters = filterConditions.length > 0
      ? ` WHERE ${filterConditions.join(' AND ')}`
      : '';

    const rows = db.prepare(`
      SELECT e.node_id, e.embedding, n.*
      FROM node_embeddings_raw e
      JOIN graph_nodes n ON e.node_id = n.id
      ${whereFilters}
    `).all(...filterParams) as (GraphNodeRow & { node_id: string; embedding: Buffer })[];

    const results: Array<{ row: GraphNodeRow; score: number }> = [];
    
    for (const row of rows) {
      const buffer = Buffer.isBuffer(row.embedding) 
        ? row.embedding 
        : Buffer.from(row.embedding as Uint8Array);
      const embedding: number[] = [];
      for (let i = 0; i < buffer.length; i += 4) {
        embedding.push(buffer.readFloatLE(i));
      }

      const similarity = this.cosineSimilarity(vector, embedding);
      results.push({ row, score: similarity });
    }

    results.sort((a, b) => b.score - a.score);
    
    return results.slice(0, limit).map(r => this.rowToSearchResult(r.row, r.score));
  }

  async getEmbedding(nodeId: string): Promise<number[] | undefined> {
    const db = this.getDb();
    const row = db.prepare(`
      SELECT embedding FROM node_embeddings_raw WHERE node_id = ?
    `).get(nodeId) as { embedding: Buffer } | undefined;

    if (!row) return undefined;

    // Convert Buffer/Uint8Array to number array
    // Bun returns Uint8Array, Node returns Buffer - handle both
    const buffer = Buffer.isBuffer(row.embedding) 
      ? row.embedding 
      : Buffer.from(row.embedding as Uint8Array);
    const embedding: number[] = [];
    for (let i = 0; i < buffer.length; i += 4) {
      embedding.push(buffer.readFloatLE(i));
    }

    return embedding;
  }

  // ==================== File Tracking ====================

  async getIndexedFiles(): Promise<Map<string, FileHashInfo>> {
    const db = this.getDb();
    const rows = db.prepare(`SELECT * FROM file_hashes`).all() as FileHashInfo[];

    return new Map(rows.map(row => [row.filePath, row]));
  }

  async updateFileHash(filePath: string, hash: string): Promise<void> {
    const db = this.getDb();
    db.prepare(`
      INSERT OR REPLACE INTO file_hashes (file_path, hash, last_modified)
      VALUES (?, ?, ?)
    `).run(filePath, hash, Date.now());
  }

  // ==================== Bulk Operations ====================

  async bulkLoad(graph: KnowledgeGraph): Promise<void> {
    const db = this.getDb();

    const transaction = db.transaction(() => {
      // Only delete from vec table if it exists (may not exist if extension failed to load)
      const vecTableExists = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
      `).get();
      if (vecTableExists) {
        db.exec(`DELETE FROM node_embeddings_vec`);
      }
      db.exec(`DELETE FROM node_embeddings_raw`);
      db.exec(`DELETE FROM graph_relationships`);
      db.exec(`DELETE FROM graph_nodes`);
      db.exec(`DELETE FROM graph_nodes_fts`);

      const nodes = graph.getAllNodes();
      if (nodes.length > 0) {
        this.addNodesSync(db, nodes);
      }

      const rels = graph.getAllRelationships();
      if (rels.length > 0) {
        this.addRelationshipsSync(db, rels);
      }
    });

    transaction();
  }

  async clear(): Promise<void> {
    const db = this.getDb();
    
    const vecTableExists = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
    `).get();
    if (vecTableExists) {
      db.exec(`DELETE FROM node_embeddings_vec`);
    }
    
    db.exec(`DELETE FROM node_embeddings_raw`);
    db.exec(`DELETE FROM graph_relationships`);
    db.exec(`DELETE FROM graph_nodes`);
    db.exec(`DELETE FROM graph_nodes_fts`);
    db.exec(`DELETE FROM file_hashes`);
  }

  async getAllSymbols(): Promise<GraphNode[]> {
    const db = this.getDb();
    const symbolLabels = ['function', 'method', 'class', 'interface', 'enum', 'type_alias'];
    const placeholders = symbolLabels.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT * FROM graph_nodes WHERE label IN (${placeholders})
    `).all(...symbolLabels) as GraphNodeRow[];

    return rows.map(row => this.rowToNode(row));
  }

  // ==================== Statistics ====================

  async getNodeCount(): Promise<number> {
    const db = this.getDb();
    const row = db.prepare(`SELECT COUNT(*) as count FROM graph_nodes`).get() as { count: number };
    return row.count;
  }

  async getRelationshipCount(): Promise<number> {
    const db = this.getDb();
    const row = db.prepare(`SELECT COUNT(*) as count FROM graph_relationships`).get() as { count: number };
    return row.count;
  }

  async getStats(): Promise<{
    nodeCount: number;
    relationshipCount: number;
    nodesByLabel: Record<string, number>;
    relationshipsByType: Record<string, number>;
    embeddingCount: number;
  }> {
    const db = this.getDb();

    const nodeCount = await this.getNodeCount();
    const relationshipCount = await this.getRelationshipCount();

    // Nodes by label
    const labelRows = db.prepare(`
      SELECT label, COUNT(*) as count FROM graph_nodes GROUP BY label
    `).all() as { label: string; count: number }[];
    const nodesByLabel: Record<string, number> = {};
    for (const row of labelRows) {
      nodesByLabel[row.label] = row.count;
    }

    // Relationships by type
    const typeRows = db.prepare(`
      SELECT type, COUNT(*) as count FROM graph_relationships GROUP BY type
    `).all() as { type: string; count: number }[];
    const relationshipsByType: Record<string, number> = {};
    for (const row of typeRows) {
      relationshipsByType[row.type] = row.count;
    }

    // Embedding count
    const embRow = db.prepare(`SELECT COUNT(*) as count FROM node_embeddings_raw`).get() as { count: number };

    return {
      nodeCount,
      relationshipCount,
      nodesByLabel,
      relationshipsByType,
      embeddingCount: embRow.count,
    };
  }

  // ==================== Private Helpers ====================

  private rowToNode(row: GraphNodeRow): GraphNode {
    return new GraphNode({
      id: row.id,
      label: row.label as NodeLabel,
      name: row.name,
      filePath: row.file_path,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      signature: row.signature,
      language: row.language,
      className: row.class_name,
      isDead: row.is_dead === 1,
      isEntryPoint: row.is_entry_point === 1,
      isExported: row.is_exported === 1,
      properties: row.properties ? JSON.parse(row.properties) : {},
    });
  }

  private rowToSearchResult(row: GraphNodeRow, score: number): SearchResult {
    // Create snippet from content
    let snippet = '';
    if (row.content) {
      snippet = row.content.length > 200 
        ? row.content.substring(0, 200) + '...'
        : row.content;
    }

    return {
      nodeId: row.id,
      score,
      nodeName: row.name,
      filePath: row.file_path,
      label: row.label as NodeLabel,
      snippet,
      signature: row.signature ?? undefined,
      startLine: row.start_line ?? undefined,
      endLine: row.end_line ?? undefined,
      name: row.name,
    };
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      const row = matrix[0];
      if (row) row[j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const currentRow = matrix[i];
        const prevRow = matrix[i - 1];
        if (!currentRow || !prevRow) continue;
        
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          currentRow[j] = prevRow[j - 1] ?? 0;
        } else {
          currentRow[j] = Math.min(
            (prevRow[j - 1] ?? 0) + 1,
            (currentRow[j - 1] ?? 0) + 1,
            (prevRow[j] ?? 0) + 1
          );
        }
      }
    }

    const lastRow = matrix[b.length];
    return lastRow?.[a.length] ?? 0;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const aVal = a[i] ?? 0;
      const bVal = b[i] ?? 0;
      dotProduct += aVal * bVal;
      normA += aVal * aVal;
      normB += bVal * bVal;
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private addNodesSync(db: Database, nodes: GraphNode[]): void {
    const insertNode = db.prepare(`
      INSERT OR REPLACE INTO graph_nodes (
        id, label, name, file_path, start_line, end_line,
        content, signature, language, class_name,
        is_dead, is_entry_point, is_exported, properties
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = db.prepare(`
      INSERT OR REPLACE INTO graph_nodes_fts (id, name, content, signature, file_path)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const node of nodes) {
      insertNode.run(
        node.id,
        node.label,
        node.name,
        node.filePath,
        node.startLine,
        node.endLine,
        node.content,
        node.signature,
        node.language,
        node.className,
        node.isDead ? 1 : 0,
        node.isEntryPoint ? 1 : 0,
        node.isExported ? 1 : 0,
        JSON.stringify(node.properties)
      );

      insertFts.run(
        node.id,
        node.name,
        node.content || '',
        node.signature || '',
        node.filePath
      );
    }
  }

  private addRelationshipsSync(db: Database, relationships: GraphRelationship[]): void {
    const insert = db.prepare(`
      INSERT OR REPLACE INTO graph_relationships (
        id, type, source, target, confidence, role, step_number,
        strength, co_changes, symbols, line
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const rel of relationships) {
      insert.run(
        rel.id,
        rel.type,
        rel.source,
        rel.target,
        rel.properties.confidence ?? 1.0,
        rel.properties.role ?? null,
        rel.properties.stepNumber ?? null,
        rel.properties.strength ?? null,
        rel.properties.coChanges ?? null,
        rel.properties.symbols ? JSON.stringify(rel.properties.symbols) : null,
        rel.properties.line ?? null
      );
    }
  }
}

/** Raw database row for graph_nodes */
interface GraphNodeRow {
  id: string;
  label: string;
  name: string;
  file_path: string;
  start_line: number | null;
  end_line: number | null;
  content: string | null;
  signature: string | null;
  language: string | null;
  class_name: string | null;
  is_dead: number;
  is_entry_point: number;
  is_exported: number;
  properties: string | null;
}
