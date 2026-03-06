/**
 * Schema Migrations for CodeGraph
 * 
 * Version history:
 * 1 - Initial schema (graph_nodes, graph_relationships, node_embeddings_raw)
 * 2 - Add FTS5 virtual table for graph_nodes
 * 3 - Add sqlite-vec virtual table for embeddings
 * 4 - Add file_hashes for incremental indexing
 * 5 - Add retrieval_documents and related tables
 * 6 - Add repo/branch/commit fields and filters
 * 7 - Rebuild graph_nodes_fts as standalone table (fix external-content corruption)
 */

import type { Database } from '../db.js';

export const CURRENT_SCHEMA_VERSION = 7;

export interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
  down?: (db: Database) => void;
  transactional?: boolean;
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Initial schema with graph_nodes, graph_relationships, node_embeddings_raw',
    up: (db: Database) => {
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
          class_name TEXT,
          is_exported INTEGER DEFAULT 0,
          is_dead INTEGER DEFAULT 0,
          is_entry_point INTEGER DEFAULT 0,
          language TEXT,
          metadata TEXT,
          properties TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
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
          line INTEGER,
          metadata TEXT,
          properties TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (source) REFERENCES graph_nodes(id) ON DELETE CASCADE,
          FOREIGN KEY (target) REFERENCES graph_nodes(id) ON DELETE CASCADE
        )
      `);
      
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_embeddings_raw (
          node_id TEXT PRIMARY KEY,
          embedding BLOB NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
        )
      `);
      
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_label ON graph_nodes(label)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_name ON graph_nodes(name)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON graph_nodes(file_path)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_rels_type ON graph_relationships(type)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_rels_source ON graph_relationships(source)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_rels_target ON graph_relationships(target)`);
    },
  },
  
  {
    version: 2,
    description: 'Add FTS5 virtual table for graph_nodes',
    up: (db: Database) => {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
          id UNINDEXED,
          name,
          content,
          signature,
          file_path,
          content='graph_nodes',
          content_rowid='rowid'
        )
      `);
    },
  },
  
  {
    version: 3,
    description: 'Add sqlite-vec virtual table for embeddings',
    up: (db: Database) => {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS node_embeddings_vec USING vec0(
          node_id TEXT PRIMARY KEY,
          embedding float[768] distance_metric=cosine
        )
      `);
    },
  },
  
  {
    version: 4,
    description: 'Add file_hashes for incremental indexing',
    up: (db: Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_hashes (
          file_path TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          last_modified INTEGER NOT NULL,
          indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  
  {
    version: 5,
    description: 'Add retrieval_documents and related tables',
    up: (db: Database) => {
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
      
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS retrieval_docs_vec USING vec0(
          doc_id TEXT PRIMARY KEY,
          embedding float[768] distance_metric=cosine
        )
      `);
      
      db.exec(`CREATE INDEX IF NOT EXISTS idx_retrieval_docs_symbol_id ON retrieval_documents(symbol_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_retrieval_docs_file_path ON retrieval_documents(file_path)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_retrieval_docs_type ON retrieval_documents(type)`);
    },
  },
  
  {
    version: 6,
    description: 'Add repo/branch/commit fields for filtering',
    up: (db: Database) => {
      // Add columns to graph_nodes
      try {
        db.exec(`ALTER TABLE graph_nodes ADD COLUMN repo_id TEXT DEFAULT 'default'`);
      } catch {}
      try {
        db.exec(`ALTER TABLE graph_nodes ADD COLUMN branch TEXT DEFAULT 'main'`);
      } catch {}
      try {
        db.exec(`ALTER TABLE graph_nodes ADD COLUMN commit_sha TEXT`);
      } catch {}
      
      // Add columns to retrieval_documents
      try {
        db.exec(`ALTER TABLE retrieval_documents ADD COLUMN repo_id TEXT DEFAULT 'default'`);
      } catch {}
      try {
        db.exec(`ALTER TABLE retrieval_documents ADD COLUMN branch TEXT DEFAULT 'main'`);
      } catch {}
      try {
        db.exec(`ALTER TABLE retrieval_documents ADD COLUMN commit_sha TEXT`);
      } catch {}
      
      // Add indexes for filtering
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_repo ON graph_nodes(repo_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_branch ON graph_nodes(branch)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_repo_branch ON graph_nodes(repo_id, branch)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_retrieval_docs_repo ON retrieval_documents(repo_id)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_retrieval_docs_branch ON retrieval_documents(branch)`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_retrieval_docs_repo_branch ON retrieval_documents(repo_id, branch)`);
      
      // Add columns to file_hashes
      try {
        db.exec(`ALTER TABLE file_hashes ADD COLUMN repo_id TEXT DEFAULT 'default'`);
      } catch {}
      try {
        db.exec(`ALTER TABLE file_hashes ADD COLUMN branch TEXT DEFAULT 'main'`);
      } catch {}
    },
  },
  {
    version: 7,
    description: 'Rebuild graph_nodes_fts as standalone table (fix external-content corruption)',
    transactional: false,
    up: (db: Database) => {
      db.exec(`DROP TABLE IF EXISTS graph_nodes_fts`);
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS graph_nodes_fts USING fts5(
          id,
          name,
          content,
          signature,
          file_path
        )
      `);
      db.exec(`
        INSERT INTO graph_nodes_fts (id, name, content, signature, file_path)
        SELECT id, name, COALESCE(content, ''), COALESCE(signature, ''), file_path
        FROM graph_nodes
      `);
    },
  },
];

export function createMigrationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

export function getAppliedVersion(db: Database): number {
  const row = db.prepare(`
    SELECT MAX(version) as version FROM schema_migrations
  `).get() as { version: number | null } | undefined;
  
  return row?.version ?? 0;
}

export function runMigrations(db: Database, targetVersion: number = CURRENT_SCHEMA_VERSION): void {
  createMigrationsTable(db);
  
  const currentVersion = getAppliedVersion(db);
  
  if (currentVersion >= targetVersion) {
    return;
  }
  
  const pendingMigrations = migrations
    .filter(m => m.version > currentVersion && m.version <= targetVersion)
    .sort((a, b) => a.version - b.version);
  
  for (const migration of pendingMigrations) {
    const executeMigration = () => {
      try {
        migration.up(db);
        db.prepare(`
          INSERT INTO schema_migrations (version, description)
          VALUES (?, ?)
        `).run(migration.version, migration.description);
      } catch (error) {
        console.error(`Migration ${migration.version} failed:`, error);
        throw error;
      }
    };

    if (migration.transactional === false) {
      executeMigration();
    } else {
      const transaction = db.transaction(executeMigration);
      transaction();
    }
  }
}

export function getSchemaInfo(db: Database): { version: number; tables: string[] } {
  const version = getAppliedVersion(db);
  
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
  `).all() as { name: string }[];
  
  return {
    version,
    tables: tables.map(t => t.name),
  };
}
