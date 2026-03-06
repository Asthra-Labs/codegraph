import Database from 'better-sqlite3';
import type { SymbolInfo, ImportInfo, RelationshipInfo } from './parsers/base.js';

export interface GraphConfig {
  db: Database.Database;
}

export interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file_path: string;
  start_line: number;
  end_line: number;
  content: string;
  signature: string;
  class_name: string | null;
  decorators: string;
  is_exported: number;
  language: string;
}

export interface RelationshipRow {
  id: number;
  source_id: string;
  target: string;
  rel_type: string;
  confidence: number;
  line: number | null;
  file_path: string;
}

export interface ImportRow {
  id: number;
  file_path: string;
  module: string;
  names: string;
  is_relative: number;
  alias: string | null;
}

export interface CallGraphResult {
  symbol: SymbolRow;
  depth: number;
  relationship: string;
}

export function createGraphTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_symbols (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content TEXT,
      signature TEXT,
      class_name TEXT,
      decorators TEXT,
      is_exported INTEGER DEFAULT 0,
      language TEXT NOT NULL,
      indexed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON graph_symbols(name);
    CREATE INDEX IF NOT EXISTS idx_symbols_file ON graph_symbols(file_path);
    CREATE INDEX IF NOT EXISTS idx_symbols_kind ON graph_symbols(kind);
    
    CREATE TABLE IF NOT EXISTS graph_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id TEXT NOT NULL,
      target TEXT NOT NULL,
      rel_type TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      line INTEGER,
      file_path TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_rels_source ON graph_relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_rels_target ON graph_relationships(target);
    CREATE INDEX IF NOT EXISTS idx_rels_type ON graph_relationships(rel_type);
    
    CREATE TABLE IF NOT EXISTS graph_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      module TEXT NOT NULL,
      names TEXT NOT NULL,
      is_relative INTEGER DEFAULT 0,
      alias TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_imports_file ON graph_imports(file_path);
    CREATE INDEX IF NOT EXISTS idx_imports_module ON graph_imports(module);
  `);
}

export function indexSymbols(
  db: Database.Database,
  symbols: SymbolInfo[],
  language: string
): void {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO graph_symbols 
    (id, name, kind, file_path, start_line, end_line, content, signature, class_name, decorators, is_exported, language)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((syms: SymbolInfo[]) => {
    for (const sym of syms) {
      insert.run(
        sym.id,
        sym.name,
        sym.kind,
        sym.filePath,
        sym.startLine,
        sym.endLine,
        sym.content,
        sym.signature,
        sym.className || null,
        JSON.stringify(sym.decorators),
        sym.isExported ? 1 : 0,
        language
      );
    }
  });

  insertMany(symbols);
}

export function indexRelationships(
  db: Database.Database,
  relationships: RelationshipInfo[],
  filePath: string
): void {
  const insert = db.prepare(`
    INSERT INTO graph_relationships 
    (source_id, target, rel_type, confidence, line, file_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rels: RelationshipInfo[]) => {
    for (const rel of rels) {
      insert.run(
        rel.sourceId,
        rel.target,
        rel.type,
        rel.confidence,
        rel.line || null,
        filePath
      );
    }
  });

  insertMany(relationships);
}

export function indexImports(
  db: Database.Database,
  imports: ImportInfo[],
  filePath: string
): void {
  const insert = db.prepare(`
    INSERT INTO graph_imports 
    (file_path, module, names, is_relative, alias)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((imps: ImportInfo[]) => {
    for (const imp of imps) {
      insert.run(
        filePath,
        imp.module,
        JSON.stringify(imp.names),
        imp.isRelative ? 1 : 0,
        imp.alias || null
      );
    }
  });

  insertMany(imports);
}

export function clearFileFromGraph(db: Database.Database, filePath: string): void {
  db.prepare('DELETE FROM graph_relationships WHERE file_path = ?').run(filePath);
  db.prepare('DELETE FROM graph_imports WHERE file_path = ?').run(filePath);
  db.prepare('DELETE FROM graph_symbols WHERE file_path = ?').run(filePath);
}

export function getSymbol(db: Database.Database, symbolId: string): SymbolRow | undefined {
  return db.prepare('SELECT * FROM graph_symbols WHERE id = ?').get(symbolId) as SymbolRow | undefined;
}

export function getSymbolByName(db: Database.Database, name: string, filePath?: string): SymbolRow[] {
  if (filePath) {
    return db.prepare('SELECT * FROM graph_symbols WHERE name = ? AND file_path = ?').all(name, filePath) as SymbolRow[];
  }
  return db.prepare('SELECT * FROM graph_symbols WHERE name = ?').all(name) as SymbolRow[];
}

export function getCallers(db: Database.Database, symbolId: string): CallGraphResult[] {
  const rows = db.prepare(`
    SELECT s.*, r.rel_type as relationship, 1 as depth
    FROM graph_relationships r
    JOIN graph_symbols s ON r.source_id = s.id
    WHERE r.target = ? AND r.rel_type = 'calls'
    ORDER BY r.confidence DESC
  `).all(symbolId) as any[];

  return rows.map(row => ({
    symbol: row,
    depth: row.depth,
    relationship: row.relationship
  }));
}

export function getCallees(db: Database.Database, symbolId: string): CallGraphResult[] {
  const rows = db.prepare(`
    SELECT s.*, r.rel_type as relationship, 1 as depth
    FROM graph_relationships r
    JOIN graph_symbols s ON r.target = s.id
    WHERE r.source_id = ? AND r.rel_type = 'calls'
    ORDER BY r.confidence DESC
  `).all(symbolId) as any[];

  return rows.map(row => ({
    symbol: row,
    depth: row.depth,
    relationship: row.relationship
  }));
}

export function getImpact(
  db: Database.Database,
  symbolId: string,
  maxDepth: number = 3
): { willBreak: CallGraphResult[]; mayBreak: CallGraphResult[]; review: CallGraphResult[] } {
  const willBreak: CallGraphResult[] = [];
  const mayBreak: CallGraphResult[] = [];
  const review: CallGraphResult[] = [];

  const visited = new Set<string>();
  const queue: { id: string; depth: number }[] = [{ id: symbolId, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    
    if (visited.has(current.id) || current.depth > maxDepth) continue;
    visited.add(current.id);

    const callers = getCallers(db, current.id);
    
    for (const caller of callers) {
      if (!visited.has(caller.symbol.id)) {
        if (current.depth === 0) {
          willBreak.push({ ...caller, depth: current.depth + 1 });
        } else if (current.depth === 1) {
          mayBreak.push({ ...caller, depth: current.depth + 1 });
        } else {
          review.push({ ...caller, depth: current.depth + 1 });
        }
        
        queue.push({ id: caller.symbol.id, depth: current.depth + 1 });
      }
    }
  }

  return { willBreak, mayBreak, review };
}

export function searchSymbols(
  db: Database.Database,
  query: string,
  kind?: string,
  language?: string,
  limit: number = 20
): SymbolRow[] {
  let sql = `
    SELECT * FROM graph_symbols 
    WHERE (name LIKE ? OR content LIKE ? OR signature LIKE ?)
  `;
  const params: any[] = [`%${query}%`, `%${query}%`, `%${query}%`];

  if (kind) {
    sql += ' AND kind = ?';
    params.push(kind);
  }

  if (language) {
    sql += ' AND language = ?';
    params.push(language);
  }

  sql += ' LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as SymbolRow[];
}

export function getFileImports(db: Database.Database, filePath: string): ImportRow[] {
  return db.prepare('SELECT * FROM graph_imports WHERE file_path = ?').all(filePath) as ImportRow[];
}

export function resolveImport(
  db: Database.Database,
  importName: string,
  fromFile: string
): SymbolRow | null {
  const importRow = db.prepare(`
    SELECT * FROM graph_imports 
    WHERE file_path = ? AND (names LIKE ? OR module LIKE ?)
  `).get(fromFile, `%"${importName}"%`, `%${importName}%`) as ImportRow | undefined;

  if (!importRow) return null;

  const moduleParts = importRow.module.split('/');
  const searchNames = [importName, ...moduleParts.slice(-1)];
  
  for (const name of searchNames) {
    const symbol = db.prepare(`
      SELECT * FROM graph_symbols 
      WHERE name = ? AND is_exported = 1
      LIMIT 1
    `).get(name) as SymbolRow | undefined;
    
    if (symbol) return symbol;
  }

  return null;
}

export function getGraphStats(db: Database.Database): { symbols: number; relationships: number; imports: number; files: number } {
  const symbols = db.prepare('SELECT COUNT(*) as count FROM graph_symbols').get() as { count: number };
  const relationships = db.prepare('SELECT COUNT(*) as count FROM graph_relationships').get() as { count: number };
  const imports = db.prepare('SELECT COUNT(*) as count FROM graph_imports').get() as { count: number };
  const files = db.prepare('SELECT COUNT(DISTINCT file_path) as count FROM graph_symbols').get() as { count: number };

  return {
    symbols: symbols.count,
    relationships: relationships.count,
    imports: imports.count,
    files: files.count
  };
}
