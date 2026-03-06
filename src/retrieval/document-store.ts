import type { Database } from '../db.js';
import { loadSqliteVec } from '../db.js';
import type { RetrievalChunk, ChunkType } from '../chunking/types.js';
import type { SearchFilters } from '../graph/storage-backend.js';

export interface RetrievalDocument {
  id: string;
  type: ChunkType;
  parentId?: string;
  symbolId?: string;
  symbolName: string;
  symbolKind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  ftsText: string;
  embeddingText: string;
  signature?: string;
  className?: string;
  isExported?: boolean;
  metadata: string;
  embedding?: number[];
}

export interface RetrievalSearchResult {
  docId: string;
  type: ChunkType;
  symbolId?: string;
  symbolName: string;
  symbolKind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  signature?: string;
  className?: string;
  score: number;
  source: 'fts' | 'vector';
  metadata: Record<string, unknown>;
}

const EMBEDDING_DIM = 768;

export function createRetrievalTables(db: Database): void {
  loadSqliteVec(db);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS retrieval_documents (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      parent_id TEXT,
      symbol_id TEXT,
      symbol_name TEXT NOT NULL,
      symbol_kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT NOT NULL,
      fts_text TEXT NOT NULL,
      embedding_text TEXT NOT NULL,
      signature TEXT,
      class_name TEXT,
      is_exported INTEGER DEFAULT 0,
      metadata TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_documents_fts USING fts5(
      id UNINDEXED,
      fts_text,
      symbol_name,
      file_path,
      signature,
      class_name,
      content='retrieval_documents',
      content_rowid='rowid'
    )
  `);

  const vecTableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='retrieval_docs_vec'
  `).get();
  
  if (!vecTableExists) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_docs_vec USING vec0(
        doc_id TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIM}] distance_metric=cosine
      )
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_retrieval_docs_symbol_id 
    ON retrieval_documents(symbol_id)
  `);
  
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_retrieval_docs_file_path 
    ON retrieval_documents(file_path)
  `);
  
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_retrieval_docs_type 
    ON retrieval_documents(type)
  `);
}

export function dropRetrievalTables(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS retrieval_documents_fts`);
  db.exec(`DROP TABLE IF EXISTS retrieval_documents`);
}

export function storeRetrievalDocument(
  db: Database,
  doc: RetrievalDocument
): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO retrieval_documents (
      id, type, parent_id, symbol_id, symbol_name, symbol_kind,
      file_path, start_line, end_line, content, fts_text,
      embedding_text, signature, class_name, is_exported, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    doc.id,
    doc.type,
    doc.parentId ?? null,
    doc.symbolId ?? null,
    doc.symbolName,
    doc.symbolKind,
    doc.filePath,
    doc.startLine,
    doc.endLine,
    doc.content,
    doc.ftsText,
    doc.embeddingText,
    doc.signature ?? null,
    doc.className ?? null,
    doc.isExported ? 1 : 0,
    doc.metadata
  );

  const ftsStmt = db.prepare(`
    INSERT OR REPLACE INTO retrieval_documents_fts (
      rowid, id, fts_text, symbol_name, file_path, signature, class_name
    ) VALUES (
      (SELECT rowid FROM retrieval_documents WHERE id = ?),
      ?, ?, ?, ?, ?, ?
    )
  `);

  ftsStmt.run(
    doc.id,
    doc.id,
    doc.ftsText,
    doc.symbolName,
    doc.filePath,
    doc.signature ?? '',
    doc.className ?? ''
  );

  if (doc.embedding && doc.embedding.length === EMBEDDING_DIM) {
    const vecStmt = db.prepare(`
      INSERT OR REPLACE INTO retrieval_docs_vec (doc_id, embedding)
      VALUES (?, ?)
    `);
    vecStmt.run(doc.id, new Float32Array(doc.embedding));
  }
}

export function storeRetrievalDocuments(
  db: Database,
  docs: RetrievalDocument[]
): void {
  const transaction = db.transaction(() => {
    for (const doc of docs) {
      storeRetrievalDocument(db, doc);
    }
  });
  transaction();
}

export function ftsSearchRetrievalDocs(
  db: Database,
  query: string,
  limit: number = 20,
  filters?: SearchFilters
): RetrievalSearchResult[] {
  const normalizedQuery = query.replace(/['"]/g, "''");

  const filterConditions: string[] = [];
  const filterParams: Array<string> = [];
  if (filters?.repoId) {
    filterConditions.push('r.repo_id = ?');
    filterParams.push(filters.repoId);
  }
  if (filters?.branch) {
    filterConditions.push('r.branch = ?');
    filterParams.push(filters.branch);
  }
  if (filters?.commitSha) {
    filterConditions.push('r.commit_sha = ?');
    filterParams.push(filters.commitSha);
  }
  if (filters?.pathPrefix) {
    filterConditions.push('r.file_path LIKE ?');
    filterParams.push(`${filters.pathPrefix}%`);
  }
  const filterClause = filterConditions.length > 0 ? `AND ${filterConditions.join(' AND ')}` : '';
  
  const ftsResults = db.prepare(`
    SELECT 
      r.id, r.type, r.symbol_id, r.symbol_name, r.symbol_kind,
      r.file_path, r.start_line, r.end_line, r.content,
      r.signature, r.class_name, r.metadata,
      bm25(retrieval_documents_fts) as bm25_score
    FROM retrieval_documents_fts fts
    JOIN retrieval_documents r ON fts.id = r.id
    WHERE retrieval_documents_fts MATCH ?
      ${filterClause}
    ORDER BY bm25_score
    LIMIT ?
  `).all(normalizedQuery, ...filterParams, limit) as Array<{
    id: string;
    type: ChunkType;
    symbol_id: string | null;
    symbol_name: string;
    symbol_kind: string;
    file_path: string;
    start_line: number;
    end_line: number;
    content: string;
    signature: string | null;
    class_name: string | null;
    metadata: string;
    bm25_score: number;
  }>;

  return ftsResults.map(row => ({
    docId: row.id,
    type: row.type,
    symbolId: row.symbol_id ?? undefined,
    symbolName: row.symbol_name,
    symbolKind: row.symbol_kind,
    filePath: row.file_path,
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
    signature: row.signature ?? undefined,
    className: row.class_name ?? undefined,
    score: normalizeBM25Score(row.bm25_score),
    source: 'fts' as const,
    metadata: JSON.parse(row.metadata || '{}'),
  }));
}

export function vectorSearchRetrievalDocs(
  db: Database,
  embedding: number[],
  limit: number = 20,
  filters?: SearchFilters
): RetrievalSearchResult[] {
  const vecTableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='retrieval_docs_vec'
  `).get();
  
  if (!vecTableExists) {
    return [];
  }

  const vecResults = db.prepare(`
    SELECT doc_id, distance
    FROM retrieval_docs_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(new Float32Array(embedding), limit * 3) as { doc_id: string; distance: number }[];

  if (vecResults.length === 0) return [];

  const docIds = vecResults.map(r => r.doc_id);
  const distanceMap = new Map(vecResults.map(r => [r.doc_id, r.distance]));

  const placeholders = docIds.map(() => '?').join(',');
  const filterConditions: string[] = [];
  const filterParams: Array<string> = [];
  if (filters?.repoId) {
    filterConditions.push('repo_id = ?');
    filterParams.push(filters.repoId);
  }
  if (filters?.branch) {
    filterConditions.push('branch = ?');
    filterParams.push(filters.branch);
  }
  if (filters?.commitSha) {
    filterConditions.push('commit_sha = ?');
    filterParams.push(filters.commitSha);
  }
  if (filters?.pathPrefix) {
    filterConditions.push('file_path LIKE ?');
    filterParams.push(`${filters.pathPrefix}%`);
  }
  const filterClause = filterConditions.length > 0 ? ` AND ${filterConditions.join(' AND ')}` : '';
  const docRows = db.prepare(`
    SELECT * FROM retrieval_documents WHERE id IN (${placeholders})${filterClause}
  `).all(...docIds, ...filterParams) as Array<Record<string, unknown>>;

  const results: RetrievalSearchResult[] = [];
  
  for (const row of docRows) {
    const docId = row.id as string;
    const distance = distanceMap.get(docId);
    if (distance !== undefined) {
      results.push({
        docId,
        type: row.type as ChunkType,
        symbolId: row.symbol_id as string | undefined,
        symbolName: row.symbol_name as string,
        symbolKind: row.symbol_kind as string,
        filePath: row.file_path as string,
        startLine: row.start_line as number,
        endLine: row.end_line as number,
        content: row.content as string,
        signature: row.signature as string | undefined,
        className: row.class_name as string | undefined,
        score: 1 - distance,
        source: 'vector' as const,
        metadata: JSON.parse((row.metadata as string) || '{}'),
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export function getRetrievalDocsBySymbol(
  db: Database,
  symbolId: string
): RetrievalDocument[] {
  const rows = db.prepare(`
    SELECT * FROM retrieval_documents WHERE symbol_id = ?
  `).all(symbolId) as Array<Record<string, unknown>>;

  return rows.map(row => rowToRetrievalDocument(row));
}

export function getRetrievalDocsByFile(
  db: Database,
  filePath: string
): RetrievalDocument[] {
  const rows = db.prepare(`
    SELECT * FROM retrieval_documents WHERE file_path = ?
  `).all(filePath) as Array<Record<string, unknown>>;

  return rows.map(row => rowToRetrievalDocument(row));
}

export function deleteRetrievalDocsByFile(
  db: Database,
  filePath: string
): void {
  const docs = db.prepare(`
    SELECT id FROM retrieval_documents WHERE file_path = ?
  `).all(filePath) as { id: string }[];

  const deleteDoc = db.prepare(`DELETE FROM retrieval_documents WHERE id = ?`);
  const deleteFts = db.prepare(`DELETE FROM retrieval_documents_fts WHERE id = ?`);
  const deleteVec = db.prepare(`DELETE FROM retrieval_docs_vec WHERE doc_id = ?`);

  const transaction = db.transaction(() => {
    for (const doc of docs) {
      deleteFts.run(doc.id);
      deleteVec.run(doc.id);
      deleteDoc.run(doc.id);
    }
  });
  transaction();
}

export function clearRetrievalDocs(db: Database): void {
  db.exec(`DELETE FROM retrieval_docs_vec`);
  db.exec(`DELETE FROM retrieval_documents_fts`);
  db.exec(`DELETE FROM retrieval_documents`);
}

function rowToRetrievalDocument(row: Record<string, unknown>): RetrievalDocument {
  return {
    id: row.id as string,
    type: row.type as ChunkType,
    parentId: row.parent_id as string | undefined,
    symbolId: row.symbol_id as string | undefined,
    symbolName: row.symbol_name as string,
    symbolKind: row.symbol_kind as string,
    filePath: row.file_path as string,
    startLine: row.start_line as number,
    endLine: row.end_line as number,
    content: row.content as string,
    ftsText: row.fts_text as string,
    embeddingText: row.embedding_text as string,
    signature: row.signature as string | undefined,
    className: row.class_name as string | undefined,
    isExported: row.is_exported === 1,
    metadata: row.metadata as string,
  };
}

function normalizeBM25Score(score: number): number {
  const absScore = Math.abs(score);
  return absScore / (1 + absScore);
}
