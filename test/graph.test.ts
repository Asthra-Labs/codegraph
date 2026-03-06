import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { 
  createGraphTables,
  indexSymbols,
  indexRelationships,
  indexImports,
  clearFileFromGraph,
  getSymbol,
  getSymbolByName,
  getCallers,
  getCallees,
  getImpact,
  searchSymbols,
  getGraphStats,
  getFileImports,
  resolveImport
} from '../src/graph.js';
import type { SymbolInfo, ImportInfo, RelationshipInfo } from '../src/parsers/base.js';

describe('Graph Storage', () => {
  let db: Database.Database;
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `qmd-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    
    const dbPath = join(testDir, 'graph.db');
    db = new Database(dbPath);
    createGraphTables(db);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('createGraphTables', () => {
    it('should create all required tables', () => {
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table'
      `).all() as { name: string }[];
      
      const tableNames = tables.map(t => t.name);
      expect(tableNames).toContain('graph_symbols');
      expect(tableNames).toContain('graph_relationships');
      expect(tableNames).toContain('graph_imports');
    });

    it('should create indexes on symbols', () => {
      const indexes = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_symbols%'
      `).all() as { name: string }[];
      
      expect(indexes.length).toBeGreaterThan(0);
    });
  });

  describe('indexSymbols', () => {
    it('should index a function symbol', () => {
      const symbols: SymbolInfo[] = [
        {
          id: 'function:test.py:add',
          name: 'add',
          kind: 'function',
          filePath: 'test.py',
          startLine: 1,
          endLine: 3,
          content: 'def add(a, b):\n    return a + b',
          signature: 'def add(a, b):',
          decorators: [],
          isExported: false
        }
      ];

      indexSymbols(db, symbols, 'python');

      const result = getSymbol(db, 'function:test.py:add');
      expect(result).toBeDefined();
      expect(result!.name).toBe('add');
      expect(result!.kind).toBe('function');
      expect(result!.language).toBe('python');
    });

    it('should index a class symbol', () => {
      const symbols: SymbolInfo[] = [
        {
          id: 'class:test.py:User',
          name: 'User',
          kind: 'class',
          filePath: 'test.py',
          startLine: 5,
          endLine: 20,
          content: 'class User:\n    def __init__(self): pass',
          signature: 'class User:',
          decorators: ['@dataclass'],
          isExported: true
        }
      ];

      indexSymbols(db, symbols, 'python');

      const result = getSymbol(db, 'class:test.py:User');
      expect(result).toBeDefined();
      expect(result!.name).toBe('User');
      expect(result!.kind).toBe('class');
      expect(result!.is_exported).toBe(1);
      expect(result!.decorators).toContain('@dataclass');
    });

    it('should handle multiple symbols', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:foo', name: 'foo', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 2, content: '', signature: 'foo()', decorators: [], isExported: false },
        { id: 'function:test.py:bar', name: 'bar', kind: 'function', filePath: 'test.py', startLine: 4, endLine: 6, content: '', signature: 'bar()', decorators: [], isExported: false },
        { id: 'class:test.py:Baz', name: 'Baz', kind: 'class', filePath: 'test.py', startLine: 8, endLine: 15, content: '', signature: 'class Baz', decorators: [], isExported: true },
      ];

      indexSymbols(db, symbols, 'python');

      const stats = getGraphStats(db);
      expect(stats.symbols).toBe(3);
    });

    it('should replace existing symbols on conflict', () => {
      const symbols1: SymbolInfo[] = [
        { id: 'function:test.py:add', name: 'add', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 2, content: 'old', signature: 'add()', decorators: [], isExported: false }
      ];
      const symbols2: SymbolInfo[] = [
        { id: 'function:test.py:add', name: 'add', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 3, content: 'new', signature: 'add()', decorators: [], isExported: false }
      ];

      indexSymbols(db, symbols1, 'python');
      indexSymbols(db, symbols2, 'python');

      const result = getSymbol(db, 'function:test.py:add');
      expect(result!.content).toBe('new');
      expect(result!.end_line).toBe(3);
    });
  });

  describe('indexRelationships', () => {
    it('should index a calls relationship', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:main', name: 'main', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 10, content: '', signature: 'main()', decorators: [], isExported: true },
        { id: 'function:test.py:add', name: 'add', kind: 'function', filePath: 'test.py', startLine: 12, endLine: 15, content: '', signature: 'add()', decorators: [], isExported: false },
      ];
      const relationships: RelationshipInfo[] = [
        { type: 'calls', sourceId: 'function:test.py:main', target: 'function:test.py:add', confidence: 1.0, line: 5 }
      ];

      indexSymbols(db, symbols, 'python');
      indexRelationships(db, relationships, 'test.py');

      const callers = getCallers(db, 'function:test.py:add');
      expect(callers.length).toBe(1);
    });

    it('should index multiple relationships', () => {
      const relationships: RelationshipInfo[] = [
        { type: 'calls', sourceId: 'function:test.py:main', target: 'function:test.py:foo', confidence: 1.0, line: 5 },
        { type: 'calls', sourceId: 'function:test.py:helper', target: 'function:test.py:bar', confidence: 0.5, line: 6 },
      ];

      indexRelationships(db, relationships, 'test.py');

      const stats = getGraphStats(db);
      expect(stats.relationships).toBe(2);
    });
  });

  describe('indexImports', () => {
    it('should index an import', () => {
      const imports: ImportInfo[] = [
        { module: 'os', names: ['path'], isRelative: false }
      ];

      indexImports(db, imports, 'test.py');

      const fileImports = getFileImports(db, 'test.py');
      expect(fileImports.length).toBe(1);
      expect(fileImports[0].module).toBe('os');
    });

    it('should index relative imports', () => {
      const imports: ImportInfo[] = [
        { module: '.utils', names: ['helper'], isRelative: true }
      ];

      indexImports(db, imports, 'test.py');

      const fileImports = getFileImports(db, 'test.py');
      expect(fileImports[0].is_relative).toBe(1);
    });
  });

  describe('getSymbolByName', () => {
    it('should find symbols by name', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:add', name: 'add', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 2, content: '', signature: 'add()', decorators: [], isExported: false },
        { id: 'function:other.py:add', name: 'add', kind: 'function', filePath: 'other.py', startLine: 1, endLine: 2, content: '', signature: 'add()', decorators: [], isExported: false },
      ];

      indexSymbols(db, symbols, 'python');

      const results = getSymbolByName(db, 'add');
      expect(results.length).toBe(2);
    });

    it('should filter by file path when provided', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:add', name: 'add', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 2, content: '', signature: 'add()', decorators: [], isExported: false },
        { id: 'function:other.py:add', name: 'add', kind: 'function', filePath: 'other.py', startLine: 1, endLine: 2, content: '', signature: 'add()', decorators: [], isExported: false },
      ];

      indexSymbols(db, symbols, 'python');

      const results = getSymbolByName(db, 'add', 'test.py');
      expect(results.length).toBe(1);
      expect(results[0].file_path).toBe('test.py');
    });
  });

  describe('searchSymbols', () => {
    it('should search by name', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py: authenticate', name: 'authenticate', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 5, content: '', signature: 'authenticate()', decorators: [], isExported: false },
        { id: 'function:test.py:login', name: 'login', kind: 'function', filePath: 'test.py', startLine: 10, endLine: 15, content: '', signature: 'login()', decorators: [], isExported: false },
      ];

      indexSymbols(db, symbols, 'python');

      const results = searchSymbols(db, 'auth');
      expect(results.length).toBe(1);
      expect(results[0].name).toBe('authenticate');
    });

    it('should search by content', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:process', name: 'process', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 10, content: 'Handles user authentication', signature: 'process()', decorators: [], isExported: false },
      ];

      indexSymbols(db, symbols, 'python');

      const results = searchSymbols(db, 'authentication');
      expect(results.length).toBe(1);
    });

    it('should filter by kind', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:foo', name: 'foo', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 2, content: '', signature: 'foo()', decorators: [], isExported: false },
        { id: 'class:test.py:Bar', name: 'Bar', kind: 'class', filePath: 'test.py', startLine: 5, endLine: 10, content: '', signature: 'class Bar', decorators: [], isExported: false },
      ];

      indexSymbols(db, symbols, 'python');

      const results = searchSymbols(db, '', 'class');
      expect(results.length).toBe(1);
      expect(results[0].kind).toBe('class');
    });
  });

  describe('clearFileFromGraph', () => {
    it('should remove all data for a file', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:foo', name: 'foo', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 2, content: '', signature: 'foo()', decorators: [], isExported: false },
      ];
      const relationships: RelationshipInfo[] = [
        { type: 'calls', sourceId: 'function:test.py:foo', target: 'function:test.py:bar', confidence: 1.0, line: 5 },
      ];
      const imports: ImportInfo[] = [
        { module: 'os', names: ['path'], isRelative: false }
      ];

      indexSymbols(db, symbols, 'python');
      indexRelationships(db, relationships, 'test.py');
      indexImports(db, imports, 'test.py');

      clearFileFromGraph(db, 'test.py');

      const stats = getGraphStats(db);
      expect(stats.symbols).toBe(0);
      expect(stats.relationships).toBe(0);
      expect(stats.imports).toBe(0);
    });
  });

  describe('getGraphStats', () => {
    it('should return accurate statistics', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:foo', name: 'foo', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 2, content: '', signature: 'foo()', decorators: [], isExported: false },
        { id: 'class:test.py:Bar', name: 'Bar', kind: 'class', filePath: 'test.py', startLine: 5, endLine: 10, content: '', signature: 'class Bar', decorators: [], isExported: false },
      ];
      const relationships: RelationshipInfo[] = [
        { type: 'calls', sourceId: 'function:test.py:foo', target: 'function:test.py:bar', confidence: 1.0, line: 5 },
      ];
      const imports: ImportInfo[] = [
        { module: 'os', names: ['path'], isRelative: false }
      ];

      indexSymbols(db, symbols, 'python');
      indexRelationships(db, relationships, 'test.py');
      indexImports(db, imports, 'test.py');

      const stats = getGraphStats(db);
      expect(stats.symbols).toBe(2);
      expect(stats.relationships).toBe(1);
      expect(stats.imports).toBe(1);
      expect(stats.files).toBe(1);
    });
  });

  describe('getImpact - BFS traversal', () => {
    it('should find direct callers', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:authenticate', name: 'authenticate', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 5, content: '', signature: 'authenticate()', decorators: [], isExported: true },
        { id: 'function:test.py:login', name: 'login', kind: 'function', filePath: 'test.py', startLine: 10, endLine: 15, content: '', signature: 'login()', decorators: [], isExported: true },
      ];
      const relationships: RelationshipInfo[] = [
        { type: 'calls', sourceId: 'function:test.py:login', target: 'function:test.py:authenticate', confidence: 1.0, line: 12 },
      ];

      indexSymbols(db, symbols, 'python');
      indexRelationships(db, relationships, 'test.py');

      const impact = getImpact(db, 'function:test.py:authenticate', 3);
      expect(impact.willBreak.length).toBe(1);
      expect(impact.willBreak[0].symbol.name).toBe('login');
    });

    it('should group by depth', () => {
      const symbols: SymbolInfo[] = [
        { id: 'function:test.py:core', name: 'core', kind: 'function', filePath: 'test.py', startLine: 1, endLine: 3, content: '', signature: 'core()', decorators: [], isExported: true },
        { id: 'function:test.py:middle', name: 'middle', kind: 'function', filePath: 'test.py', startLine: 10, endLine: 12, content: '', signature: 'middle()', decorators: [], isExported: true },
        { id: 'function:test.py:top', name: 'top', kind: 'function', filePath: 'test.py', startLine: 20, endLine: 22, content: '', signature: 'top()', decorators: [], isExported: true },
      ];
      const relationships: RelationshipInfo[] = [
        { type: 'calls', sourceId: 'function:test.py:middle', target: 'function:test.py:core', confidence: 1.0, line: 11 },
        { type: 'calls', sourceId: 'function:test.py:top', target: 'function:test.py:middle', confidence: 1.0, line: 21 },
      ];

      indexSymbols(db, symbols, 'python');
      indexRelationships(db, relationships, 'test.py');

      const impact = getImpact(db, 'function:test.py:core', 3);
      expect(impact.willBreak.length).toBe(1);
      expect(impact.mayBreak.length).toBe(1);
    });
  });
});
