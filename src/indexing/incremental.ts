/**
 * Incremental Indexing System
 * 
 * Features:
 * - Changed-file detection via hash comparison
 * - Tombstones for deleted files
 * - Embedding refresh for changed docs only
 * - Repo/branch/commit tracking
 */

import type { Database } from '../db.js';
import type { StorageBackend } from '../graph/storage-backend.js';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface IndexingContext {
  repoId: string;
  branch: string;
  commitSha?: string;
  rootPath: string;
}

export interface FileChange {
  filePath: string;
  changeType: 'added' | 'modified' | 'deleted';
  oldHash?: string;
  newHash?: string;
}

export interface IndexingResult {
  filesProcessed: number;
  filesAdded: number;
  filesModified: number;
  filesDeleted: number;
  symbolsAdded: number;
  symbolsRemoved: number;
  embeddingsUpdated: number;
  durationMs: number;
}

export const DEFAULT_CONTEXT: IndexingContext = {
  repoId: 'default',
  branch: 'main',
  rootPath: '/',
};

export function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function computeContentHash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function getIndexedFiles(
  db: Database, 
  context: IndexingContext = DEFAULT_CONTEXT
): Map<string, { hash: string; lastModified: number }> {
  const rows = db.prepare(`
    SELECT file_path, hash, last_modified 
    FROM file_hashes 
    WHERE repo_id = ? AND branch = ?
  `).all(context.repoId, context.branch) as { file_path: string; hash: string; last_modified: number }[];
  
  return new Map(rows.map(r => [r.file_path, { hash: r.hash, lastModified: r.last_modified }]));
}

export function detectFileChanges(
  db: Database,
  currentFiles: string[],
  context: IndexingContext = DEFAULT_CONTEXT
): FileChange[] {
  const changes: FileChange[] = [];
  const indexedFiles = getIndexedFiles(db, context);
  const indexedPaths = new Set(indexedFiles.keys());
  const currentPaths = new Set(currentFiles);
  
  // Added files
  for (const filePath of currentFiles) {
    if (!indexedPaths.has(filePath)) {
      changes.push({
        filePath,
        changeType: 'added',
        newHash: computeFileHash(filePath),
      });
    }
  }
  
  // Modified files
  for (const filePath of currentFiles) {
    if (indexedPaths.has(filePath)) {
      const indexed = indexedFiles.get(filePath);
      const currentHash = computeFileHash(filePath);
      
      if (indexed && indexed.hash !== currentHash) {
        changes.push({
          filePath,
          changeType: 'modified',
          oldHash: indexed.hash,
          newHash: currentHash,
        });
      }
    }
  }
  
  // Deleted files (tombstones)
  for (const filePath of indexedPaths) {
    if (!currentPaths.has(filePath)) {
      changes.push({
        filePath,
        changeType: 'deleted',
        oldHash: indexedFiles.get(filePath)?.hash,
      });
    }
  }
  
  return changes;
}

export function applyTombstone(
  db: Database,
  filePath: string,
  context: IndexingContext = DEFAULT_CONTEXT
): void {
  // Delete graph nodes for this file
  const nodes = db.prepare(`
    SELECT id FROM graph_nodes 
    WHERE file_path = ? AND repo_id = ? AND branch = ?
  `).all(filePath, context.repoId, context.branch) as { id: string }[];
  
  const deleteNode = db.prepare(`DELETE FROM graph_nodes WHERE id = ?`);
  const deleteEmbeddingsRaw = db.prepare(`DELETE FROM node_embeddings_raw WHERE node_id = ?`);
  const deleteEmbeddingsVec = db.prepare(`DELETE FROM node_embeddings_vec WHERE node_id = ?`);
  const deleteRels = db.prepare(`
    DELETE FROM graph_relationships WHERE source = ? OR target = ?
  `);
  
  const transaction = db.transaction(() => {
    for (const node of nodes) {
      deleteEmbeddingsRaw.run(node.id);
      deleteEmbeddingsVec.run(node.id);
      deleteRels.run(node.id, node.id);
      deleteNode.run(node.id);
    }
    
    // Delete retrieval documents
    const retrievalDocs = db.prepare(`
      SELECT id FROM retrieval_documents 
      WHERE file_path = ? AND repo_id = ? AND branch = ?
    `).all(filePath, context.repoId, context.branch) as { id: string }[];
    
    const deleteRetrievalDoc = db.prepare(`DELETE FROM retrieval_documents WHERE id = ?`);
    const deleteRetrievalFts = db.prepare(`DELETE FROM retrieval_documents_fts WHERE id = ?`);
    const deleteRetrievalVec = db.prepare(`DELETE FROM retrieval_docs_vec WHERE doc_id = ?`);
    
    for (const doc of retrievalDocs) {
      deleteRetrievalFts.run(doc.id);
      deleteRetrievalVec.run(doc.id);
      deleteRetrievalDoc.run(doc.id);
    }
    
    // Remove file hash
    db.prepare(`
      DELETE FROM file_hashes WHERE file_path = ? AND repo_id = ? AND branch = ?
    `).run(filePath, context.repoId, context.branch);
  });
  
  transaction();
}

export function updateFileHash(
  db: Database,
  filePath: string,
  hash: string,
  context: IndexingContext = DEFAULT_CONTEXT
): void {
  db.prepare(`
    INSERT OR REPLACE INTO file_hashes (file_path, hash, last_modified, repo_id, branch)
    VALUES (?, ?, ?, ?, ?)
  `).run(filePath, hash, Date.now(), context.repoId, context.branch);
}

export function applyRepoContext(
  db: Database,
  nodeIds: string[],
  context: IndexingContext
): void {
  const updateNode = db.prepare(`
    UPDATE graph_nodes SET repo_id = ?, branch = ?, commit_sha = ? WHERE id = ?
  `);
  
  const transaction = db.transaction(() => {
    for (const nodeId of nodeIds) {
      updateNode.run(context.repoId, context.branch, context.commitSha ?? null, nodeId);
    }
  });
  
  transaction();
}

export interface SearchFilters {
  repoId?: string;
  branch?: string;
  commitSha?: string;
  pathPrefix?: string;
}

export function buildFilterClause(
  alias: string,
  filters: SearchFilters
): { clause: string; params: any[] } {
  const conditions: string[] = [];
  const params: any[] = [];
  
  if (filters.repoId) {
    conditions.push(`${alias}.repo_id = ?`);
    params.push(filters.repoId);
  }
  
  if (filters.branch) {
    conditions.push(`${alias}.branch = ?`);
    params.push(filters.branch);
  }
  
  if (filters.commitSha) {
    conditions.push(`${alias}.commit_sha = ?`);
    params.push(filters.commitSha);
  }
  
  if (filters.pathPrefix) {
    conditions.push(`${alias}.file_path LIKE ?`);
    params.push(`${filters.pathPrefix}%`);
  }
  
  const clause = conditions.length > 0 
    ? `AND ${conditions.join(' AND ')}`
    : '';
  
  return { clause, params };
}

export async function incrementalIndex(
  backend: StorageBackend,
  filePaths: string[],
  context: IndexingContext = DEFAULT_CONTEXT,
  parseFile: (filePath: string) => Promise<{ symbols: any[]; relationships: any[] }>,
  generateEmbedding?: (text: string) => Promise<number[]>
): Promise<IndexingResult> {
  const startTime = Date.now();
  const db = (backend as any).getDb();
  
  let filesAdded = 0;
  let filesModified = 0;
  let filesDeleted = 0;
  let symbolsAdded = 0;
  let symbolsRemoved = 0;
  let embeddingsUpdated = 0;
  
  const changes = detectFileChanges(db, filePaths, context);
  
  for (const change of changes) {
    if (change.changeType === 'deleted') {
      applyTombstone(db, change.filePath, context);
      filesDeleted++;
    } else {
      // Remove old data first
      const oldNodes = db.prepare(`
        SELECT id FROM graph_nodes 
        WHERE file_path = ? AND repo_id = ? AND branch = ?
      `).all(change.filePath, context.repoId, context.branch) as { id: string }[];
      
      symbolsRemoved += oldNodes.length;
      applyTombstone(db, change.filePath, context);
      
      // Parse and index new data
      const { symbols, relationships } = await parseFile(change.filePath);
      
      if (symbols.length > 0) {
        await backend.addNodes(symbols);
        applyRepoContext(db, symbols.map((s: any) => s.id), context);
        symbolsAdded += symbols.length;
      }
      
      if (relationships.length > 0) {
        await backend.addRelationships(relationships);
      }
      
      // Update embeddings if generator provided
      if (generateEmbedding && symbols.length > 0) {
        const embeddings = [];
        for (const symbol of symbols) {
          const text = symbol.content || '';
          const embedding = await generateEmbedding(text);
          embeddings.push({ nodeId: symbol.id, embedding });
        }
        await backend.storeEmbeddings(embeddings);
        embeddingsUpdated += embeddings.length;
      }
      
      // Update file hash
      if (change.newHash) {
        updateFileHash(db, change.filePath, change.newHash, context);
      }
      
      if (change.changeType === 'added') {
        filesAdded++;
      } else {
        filesModified++;
      }
    }
  }
  
  return {
    filesProcessed: changes.length,
    filesAdded,
    filesModified,
    filesDeleted,
    symbolsAdded,
    symbolsRemoved,
    embeddingsUpdated,
    durationMs: Date.now() - startTime,
  };
}
