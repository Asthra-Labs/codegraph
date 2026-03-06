# CodeGraph Architecture

This document describes the architecture of CodeGraph, including the unified code intelligence system that combines graph-based code understanding with hybrid semantic search.

## Table of Contents

1. [System Overview](#system-overview)
2. [Document Search Pipeline](#document-search-pipeline)
3. [Code Intelligence Pipeline](#code-intelligence-pipeline)
4. [Parser Architecture](#parser-architecture)
5. [Graph Storage](#graph-storage)
6. [Impact Analysis](#impact-analysis)
7. [Integration with xyne-cli](#integration-with-xyne-cli)
8. [Test Suite](#test-suite)

---

## System Overview

CodeGraph is a hybrid code intelligence platform that combines:

| Component | Purpose | Technology |
|-----------|---------|------------|
| **BM25 Search** | Full-text keyword search | SQLite FTS5 |
| **Vector Search** | Semantic similarity | sqlite-vec + embeddinggemma |
| **Query Expansion** | LLM-generated query variants | Fine-tuned Qwen3 |
| **Re-ranking** | Cross-encoder scoring | Qwen3-reranker |
| **Symbol Extraction** | AST-based code symbols | tree-sitter |
| **Call Graph** | Function relationships | SQLite graph |
| **Impact Analysis** | Change ripple effects | BFS traversal |

---

## Document Search Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CodeGraph Hybrid Search Pipeline                       │
└─────────────────────────────────────────────────────────────────────────────┘

                              ┌─────────────────┐
                              │   User Query    │
                              └────────┬────────┘
                                       │
                        ┌──────────────┴──────────────┐
                        ▼                             ▼
               ┌────────────────┐            ┌────────────────┐
               │ Query Expansion│            │  Original Query│
               │  (fine-tuned)  │            │   (×2 weight)  │
               └───────┬────────┘            └───────┬────────┘
                       │                             │
                       │ 2 alternative queries        │
                       └──────────────┬──────────────┘
                                      │
      ┌───────────────────────────────┼───────────────────────────────┐
      ▼                               ▼                               ▼
 ┌─────────┐                 ┌─────────────┐                 ┌─────────────┐
 │   BM25  │                 │   Vector    │                 │   BM25     │
 │ (FTS5)  │                 │   Search    │                 │ (Expanded)  │
 └────┬────┘                 └──────┬──────┘                 └──────┬──────┘
      │                             │                               │
      └─────────────────────────────┼───────────────────────────────┘
                                    │
                                    ▼
                         ┌───────────────────────┐
                         │   RRF Fusion (k=60)  │
                         │   + Top-rank Bonus   │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │   LLM Re-ranking      │
                         │  (Qwen3-reranker)     │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │  Position-Aware Blend │
                         │   Top 1-3:  75% RRF  │
                         │   Top 4-10: 60% RRF  │
                         │   Top 11+:  40% RRF  │
                         └───────────────────────┘
```

### Query Expansion

The query expansion model generates three types of variants:

1. **Lexical**: Keywords extracted from the query
2. **Semantic**: Semantically similar phrasing
3. **HyDE**: Hypothetical document that would answer the query

### Smart Chunking

Documents are split into ~900 token chunks with 15% overlap:

| Break Point | Score | Description |
|-------------|-------|-------------|
| `# Heading` | 100 | H1 - major section |
| `## Heading` | 90 | H2 - subsection |
| `### Heading` | 80 | H3 |
| `#### Heading` | 70 | H4 |
| `##### Heading` | 60 | H5 |
| `###### Heading` | 50 | H6 |
| ` ``` ` | 80 | Code block boundary |
| `---` | 60 | Horizontal rule |
| Blank line | 20 | Paragraph boundary |

Algorithm: Find highest-scoring break point within 200 tokens of the 900-token target.

---

## Code Intelligence Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      CodeGraph Code Intelligence Pipeline                   │
└─────────────────────────────────────────────────────────────────────────────┘

  Code File (.py, .ts, .js, .go, .rs, .java)
            │
            ▼
  ┌─────────────────────────────────────────────────┐
  │              Parser (tree-sitter)                │
  │  - Lexical analysis                             │
  │  - AST generation                                │
  │  - Symbol extraction                             │
  └────────────────────────┬────────────────────────┘
                           │
      ┌──────────────────────┼──────────────────────┐
      ▼                      ▼                      ▼
┌─────────┐          ┌──────────┐          ┌──────────┐
│ Symbols │          │Imports  │          │ Calls   │
│  Table  │          │  Table   │          │  Table   │
└────┬────┘          └────┬─────┘          └────┬─────┘
     │                   │                      │
     └───────────────────┼──────────────────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │   Graph Queries     │
              │  - getCallers()    │
              │  - getCallees()    │
              │  - getImpact()     │
              │  - searchSymbols() │
              └─────────────────────┘
```

---

## Parser Architecture

### Interface

```typescript
interface ILanguageParser {
  readonly language: string;
  readonly extensions: string[];
  
  canHandle(filePath: string): boolean;
  parse(content: string, filePath: string): Promise<ParseResult>;
}

interface ParseResult {
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  relationships: RelationshipInfo[];
  exports: string[];
  language: string;
  errors?: string[];
}
```

### Supported Languages

| Parser | File | Languages | Extracted Symbols |
|--------|------|-----------|-------------------|
| PythonParser | `parsers/python.ts` | Python | functions, classes, decorators, imports, calls |
| TypeScriptParser | `parsers/typescript.ts` | TypeScript, TSX | functions, methods, classes, interfaces, type aliases, enums |
| JavaScriptParser | `parsers/javascript.ts` | JavaScript, JSX, MJS, CJS | functions, classes |
| GoParser | `parsers/go.ts` | Go | functions, methods, structs, interfaces |
| RustParser | `parsers/rust.ts` | Rust | functions, structs, enums, traits, impls |
| JavaParser | `parsers/java.ts` | Java | methods, classes, interfaces, enums |

### Adding New Languages

1. Install tree-sitter parser: `npm install tree-sitter-<lang>`
2. Create parser file: `src/parsers/<lang>.ts`
3. Implement `ILanguageParser` interface
4. Register in `src/parsers/index.ts`

```typescript
// Example: Adding Go parser
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';

export class GoParser implements ILanguageParser {
  readonly language = 'go';
  readonly extensions = ['go'];
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Go);
  }

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.go');
  }

  async parse(content: string, filePath: string): Promise<ParseResult> {
    const tree = this.parser.parse(content);
    // Extract symbols, imports, relationships
    return { symbols, imports, relationships, exports: [], language: 'go' };
  }
}
```

---

## Graph Storage

### Schema

```sql
-- Symbols table: functions, classes, methods, interfaces, etc.
CREATE TABLE graph_symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,           -- function, method, class, interface, enum
  file_path TEXT NOT NULL,
  start_line INTEGER,
  end_line INTEGER,
  content TEXT,
  signature TEXT,
  class_name TEXT,
  language TEXT,
  is_exported INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Relationships table: CALLS, IMPORTS, EXTENDS edges
CREATE TABLE graph_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  target TEXT NOT NULL,
  rel_type TEXT NOT NULL,       -- calls, imports, extends, implements
  confidence REAL DEFAULT 1.0,
  line INTEGER,
  file_path TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Imports table: module imports with resolution
CREATE TABLE graph_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  module TEXT NOT NULL,
  names TEXT NOT NULL,         -- JSON array of imported names
  is_relative INTEGER DEFAULT 0,
  resolved_path TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for fast lookups
CREATE INDEX idx_symbols_name ON graph_symbols(name);
CREATE INDEX idx_symbols_file ON graph_symbols(file_path);
CREATE INDEX idx_symbols_kind ON graph_symbols(kind);
CREATE INDEX idx_rels_source ON graph_relationships(source_id);
CREATE INDEX idx_rels_target ON graph_relationships(target);
CREATE INDEX idx_rels_type ON graph_relationships(rel_type);
CREATE INDEX idx_imports_file ON graph_imports(file_path);
CREATE INDEX idx_imports_module ON graph_imports(module);
```

### ID Format

Symbols use the format: `{kind}:{file_path}:{name}`

```
function:src/auth/user.ts:authenticate
method:src/auth/user.ts:User.validate
class:src/models/user.ts:User
interface:src/api/handler.ts:Handler
```

---

## Impact Analysis

The impact analysis uses BFS traversal to find all functions that would be affected by changing a symbol:

```typescript
interface ImpactResult {
  symbol: SymbolInfo;
  depth: number;
  relationship: string;
  severity: 'will-break' | 'may-break' | 'review';
}

getImpact(db, symbolId, maxDepth = 3): ImpactResult[]
```

### Severity Levels

| Depth | Severity | Description |
|-------|----------|-------------|
| 1 | **will-break** | Direct callers - changing this WILL break them |
| 2 | **may-break** | Indirect callers - might break depending on usage |
| 3+ | **review** | Transitive callers - review for potential issues |

### Example

```
If you change function `authenticate()`:

Depth 1 (will-break):
  - login() in src/auth/session.ts
  - verify_token() in src/middleware/auth.ts

Depth 2 (may-break):
  - handle_request() in src/server.ts
  - validate_session() in src/api/routes.ts

Depth 3 (review):
  - process_payment() in src/payment/handler.ts
```

---

## Integration with xyne-cli

### CodeGraphService

The xyne-cli's `CodeGraphService` provides graph indexing capabilities:

```typescript
// Imports
import { initParsers, parseFile, isCodeFile } from '@juspay/codegraph/parsers';
import { createGraphTables, indexSymbols, indexRelationships, indexImports, getCallers, getCallees, getImpact, searchSymbols, getGraphStats } from '@juspay/codegraph/graph';

class CodeGraphService {
  private graphDb: Database;
  
  async initialize(repoPath: string): Promise<void> {
    // ... existing setup ...
    
    await initParsers();
    this.graphDb = new Database(join(indexDir, 'graph.db'));
    createGraphTables(this.graphDb);
  }
  
  // Public methods
  getSymbolByName(name: string, filePath?: string): SymbolInfo[]
  getCallers(symbolId: string): RelationshipInfo[]
  getCallees(symbolId: string): RelationshipInfo[]
  getImpactAnalysis(symbolId: string, maxDepth?: number): ImpactResult[]
  searchCodeSymbols(query: string, kind?: string, limit?: number): SymbolInfo[]
  getCodeGraphStats(): { symbols: number; relationships: number; files: number; }
}
```

---

## Test Suite

### Running Tests

```bash
npm test                    # Run all tests
npm test -- test/graph.test.ts    # Run graph tests
npm test -- test/parsers/         # Run parser tests
```

### Test Coverage

| Test File | Tests | Coverage |
|-----------|-------|----------|
| `test/graph.test.ts` | 15 | Graph storage, indexing, impact analysis |
| `test/parsers/python.test.ts` | 10 | Python parser functions, classes, imports |
| `test/parsers/typescript.test.ts` | 12 | TS/JS parser functions, classes, interfaces |
| `test/parsers/go.test.ts` | 8 | Go parser functions, methods, structs |
| `test/parsers/rust.test.ts` | 8 | Rust parser functions, structs, traits |
| `test/parsers/java.test.ts` | 7 | Java parser methods, classes, interfaces |
| `test/parsers/factory.test.ts` | 15 | Parser factory, extension detection |

**Total: 567 tests passing**

---

## Future Enhancements

### Phase 2: Additional Languages

- C, C++ (tree-sitter-cpp)
- C# (tree-sitter-c-sharp)
- Ruby (tree-sitter-ruby)
- PHP (tree-sitter-php)
- Swift (tree-sitter-swift)
- Kotlin (tree-sitter-kotlin)

### Phase 3: Advanced Analysis

- Dead code detection (unreachable symbols)
- Change coupling (git history co-change analysis)
- Community detection (Leiden algorithm clustering)
- Process detection (entry point → execution flow)

### Phase 4: LSP Integration

- Fallback to Language Server Protocol for languages without tree-sitter
- "Go to definition" via LSP
- "Find references" via LSP

---

## Dependencies

```json
{
  "tree-sitter": "^0.21.1",
  "tree-sitter-python": "^0.21.0",
  "tree-sitter-typescript": "^0.21.2",
  "tree-sitter-javascript": "^0.21.0",
  "tree-sitter-go": "^0.21.2",
  "tree-sitter-rust": "^0.21.0",
  "tree-sitter-java": "^0.21.0"
}
```

---

*Last Updated: March 2026*
