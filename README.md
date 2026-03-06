# CodeGraph - Code Intelligence Platform

A unified code intelligence system combining graph-based code understanding, hybrid search (BM25 + vector), and semantic embeddings. Index your codebase to extract symbols, build call graphs, and search with natural language.

**Key Features**:
- **Graph-based code analysis**: Symbol extraction, call graphs, import resolution across 6 languages
- **Hybrid search**: BM25 full-text + vector semantic search with LLM re-ranking
- **Smart embeddings**: Graph-aware embeddings that include relationships (calls, imports, extends)
- **Impact analysis**: Find all code affected by changing a function or class
- **Local-first**: All processing happens on-device using SQLite and local GGUF models

![CodeGraph Architecture](assets/qmd-architecture.png)

## Quick Start

```sh
# Install globally (requires Bun)
bun install -g @juspay/codegraph

# Or run directly
bunx @juspay/codegraph ...

# Index a codebase
codegraph collection add ~/projects/myapp --name myapp

# Search by function name
codegraph search "authenticate" -c myapp

# Semantic search
codegraph query "user login flow" -c myapp

# Get call graph information
codegraph context myapp
```

## Code Intelligence

CodeGraph analyzes your code to extract:

| Feature | Description |
|---------|-------------|
| **Symbol Extraction** | Functions, classes, methods, interfaces, enums |
| **Call Graph** | Which functions call which other functions |
| **Import Resolution** | Module dependencies and relative imports |
| **Type Relationships** | Extends, implements, uses relationships |
| **Impact Analysis** | Find all code affected by a change |

### Supported Languages

| Language | Extensions | Symbol Extraction | Call Graph |
|----------|------------|-------------------|------------|
| Python | .py | Functions, classes, decorators | ✅ |
| TypeScript | .ts, .tsx | Functions, classes, interfaces, types, enums | ✅ |
| JavaScript | .js, .jsx, .mjs, .cjs | Functions, classes | ✅ |
| Go | .go | Functions, methods, structs, interfaces | ✅ |
| Rust | .rs | Functions, structs, enums, traits, impls | ✅ |
| Java | .java | Methods, classes, interfaces, enums | ✅ |

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed technical documentation.

## Usage

### Collection Management

```sh
# Create a collection from current directory
codegraph collection add . --name myproject

# Create a collection with explicit path and custom glob mask
codegraph collection add ~/projects/myapp --name myapp --mask "**/*.{ts,js}"

# List all collections
codegraph collection list

# Remove a collection
codegraph collection remove myproject

# Rename a collection
codegraph collection rename myproject my-project

# List files in a collection
codegraph ls myapp
codegraph ls myapp/src/components
```

### Search Commands

```
┌──────────────────────────────────────────────────────────────────┐
│                        Search Modes                              │
├──────────┬───────────────────────────────────────────────────────┤
│ search   │ BM25 full-text search only                           │
│ vsearch  │ Vector semantic search only                          │
│ query    │ Hybrid: FTS + Vector + Query Expansion + Re-ranking  │
└──────────┴───────────────────────────────────────────────────────┘
```

```sh
# Full-text search (fast, keyword-based)
codegraph search "authenticateUser"

# Vector search (semantic similarity)
codegraph vsearch "function that handles user login"

# Hybrid search with re-ranking (best quality)
codegraph query "authentication flow"

# Search within a specific collection
codegraph query "database connection" -c myapp
```

### Context Management

Context adds descriptive metadata to collections and paths, helping search understand your content.

```sh
# Add context to a collection (using codegraph:// virtual paths)
codegraph context add codegraph://myapp "Main application codebase"
codegraph context add codegraph://myapp/src/api "API layer and endpoints"

# Add context from within a collection directory
cd ~/projects/myapp && codegraph context add "Main application codebase"
cd ~/projects/myapp/src/auth && codegraph context add "Authentication module"

# Add global context (applies to all collections)
codegraph context add / "Knowledge base for my projects"

# List all contexts
codegraph context list

# Remove context
codegraph context rm codegraph://myapp/src/api
```

### Graph Queries

```sh
# Get callers of a function (what calls this function)
codegraph callers myapp authenticateUser

# Get callees of a function (what this function calls)
codegraph callees myapp authenticateUser

# Get impact analysis (all affected code if you change this function)
codegraph impact myapp authenticateUser
```

### Generate Vector Embeddings

```sh
# Embed all indexed symbols (runs automatically during indexing)
codegraph embed

# Force re-embed everything
codegraph embed -f
```

### Index Maintenance

```sh
# Show index status and collections with contexts
codegraph status

# Re-index all collections
codegraph update

# Re-index with git pull first (for remote repos)
codegraph update --pull

# Get document by filepath (with fuzzy matching suggestions)
codegraph get src/auth/user.ts

# Get document by docid (from search results)
codegraph get "#abc123"

# Get multiple documents by glob pattern
codegraph multi-get "src/**/*.ts"

# Clean up cache and orphaned data
codegraph cleanup
```

### Options

```sh
# Search options
-n <num>           # Number of results (default: 5, or 20 for --files/--json)
-c, --collection   # Restrict search to a specific collection
--all              # Return all matches (use with --min-score to filter)
--min-score <num>  # Minimum score threshold (default: 0)
--full             # Show full document content
--line-numbers     # Add line numbers to output

# Output formats (for search and multi-get)
--files            # Output: docid,score,filepath,context
--json             # JSON output with snippets
--csv              # CSV output
--md               # Markdown output
--xml              # XML output
```

## MCP Server

CodeGraph exposes an MCP (Model Context Protocol) server for integration with AI agents.

**Tools exposed:**
- `codegraph_search` - Fast BM25 keyword search (supports collection filter)
- `codegraph_vector_search` - Semantic vector search (supports collection filter)
- `codegraph_deep_search` - Deep search with query expansion and reranking (supports collection filter)
- `codegraph_get` - Retrieve document by path or docid (with fuzzy matching suggestions)
- `codegraph_multi_get` - Retrieve multiple documents by glob pattern, list, or docids
- `codegraph_status` - Index health and collection info

**Claude Desktop configuration** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["mcp"]
    }
  }
}
```

**HTTP Transport**

```sh
# Foreground (Ctrl-C to stop)
codegraph mcp --http                    # localhost:8181
codegraph mcp --http --port 8080        # custom port

# Background daemon
codegraph mcp --http --daemon           # start, writes PID to ~/.cache/codegraph/mcp.pid
codegraph mcp stop                      # stop via PID file
codegraph status                        # shows "MCP: running (PID ...)" when active
```

## Architecture

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
                       │ 2 alternative queries       │
                       └──────────────┬──────────────┘
                                      │
             ┌────────────────────────┼────────────────────────┐
             ▼                        ▼                        ▼
    ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
    │ Original Query  │     │ Expanded Query 1│     │ Expanded Query 2│
    └────────┬────────┘     └────────┬────────┘     └────────┬────────┘
             │                       │                       │
     ┌───────┴───────┐       ┌───────┴───────┐       ┌───────┴───────┐
     ▼               ▼       ▼               ▼       ▼               ▼
 ┌───────┐       ┌───────┐ ┌───────┐     ┌───────┐ ┌───────┐     ┌───────┐
 │ BM25  │       │Vector │ │ BM25  │     │Vector │ │ BM25  │     │Vector │
 │(FTS5) │       │Search │ │(FTS5) │     │Search │ │(FTS5) │     │Search │
 └───┬───┘       └───┬───┘ └───┬───┘     └───┬───┘ └───┬───┘     └───┬───┘
     │               │         │             │         │             │
     └───────┬───────┘         └──────┬──────┘         └──────┬──────┘
             │                        │                       │
             └────────────────────────┼───────────────────────┘
                                      │
                                      ▼
                         ┌───────────────────────┐
                         │   RRF Fusion + Bonus  │
                         │  Original query: ×2   │
                         │  Top-rank bonus: +0.05│
                         │     Top 30 Kept       │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │    LLM Re-ranking     │
                         │  (qwen3-reranker)     │
                         │  Yes/No + logprobs    │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │  Position-Aware Blend │
                         │  Top 1-3:  75% RRF    │
                         │  Top 4-10: 60% RRF    │
                         │  Top 11+:  40% RRF    │
                         └───────────────────────┘
```

## Score Normalization & Fusion

### Search Backends

| Backend | Raw Score | Conversion | Range |
|---------|-----------|------------|-------|
| **FTS (BM25)** | SQLite FTS5 BM25 | `Math.abs(score)` | 0 to ~25+ |
| **Vector** | Cosine distance | `1 / (1 + distance)` | 0.0 to 1.0 |
| **Reranker** | LLM 0-10 rating | `score / 10` | 0.0 to 1.0 |

### Fusion Strategy

The `query` command uses **Reciprocal Rank Fusion (RRF)** with position-aware blending:

1. **Query Expansion**: Original query (×2 for weighting) + 1 LLM variation
2. **Parallel Retrieval**: Each query searches both FTS and vector indexes
3. **RRF Fusion**: Combine all result lists using `score = Σ(1/(k+rank+1))` where k=60
4. **Top-Rank Bonus**: Documents ranking #1 in any list get +0.05, #2-3 get +0.02
5. **Top-K Selection**: Take top 30 candidates for reranking
6. **Re-ranking**: LLM scores each document (yes/no with logprobs confidence)
7. **Position-Aware Blending**:
   - RRF rank 1-3: 75% retrieval, 25% reranker (preserves exact matches)
   - RRF rank 4-10: 60% retrieval, 40% reranker
   - RRF rank 11+: 40% retrieval, 60% reranker (trust reranker more)

**Why this approach**: Pure RRF can dilute exact matches when expanded queries don't match. The top-rank bonus preserves documents that score #1 for the original query. Position-aware blending prevents the reranker from destroying high-confidence retrieval results.

### Score Interpretation

| Score | Meaning |
|-------|---------|
| 0.8 - 1.0 | Highly relevant |
| 0.5 - 0.8 | Moderately relevant |
| 0.2 - 0.5 | Somewhat relevant |
| 0.0 - 0.2 | Low relevance |

## Requirements

### System Requirements

- **Node.js** >= 22
- **Bun** >= 1.0.0 (strongly recommended over Node.js)
- **macOS**: Homebrew SQLite (for extension support)
  ```sh
  brew install sqlite
  ```

### GGUF Models (via node-llama-cpp)

CodeGraph uses three local GGUF models (auto-downloaded on first use):

| Model | Purpose | Size |
|-------|---------|------|
| `embeddinggemma-300M-Q8_0` | Vector embeddings | ~300MB |
| `qwen3-reranker-0.6b-q8_0` | Re-ranking | ~640MB |
| `codegraph-query-expansion-1.7B-q4_k_m` | Query expansion (fine-tuned) | ~1.1GB |

Models are downloaded from HuggingFace and cached in `~/.cache/codegraph/models/`.

## Installation

```sh
# Install globally with Bun (recommended)
bun install -g @juspay/codegraph

# Or with npm
npm install -g @juspay/codegraph
```

### Development

```sh
git clone https://github.com/juspay/codegraph
cd codegraph
bun install
bun link
```

## Data Storage

Index stored in: `~/.cache/codegraph/index.sqlite`

### Schema

```sql
collections     -- Indexed directories with name and glob patterns
path_contexts   -- Context descriptions by virtual path (codegraph://...)
documents       -- Document content with metadata and docid (6-char hash)
documents_fts   -- FTS5 full-text index
content_vectors -- Embedding chunks (hash, seq, pos, 900 tokens each)
vectors_vec     -- sqlite-vec vector index (hash_seq key)
llm_cache       -- Cached LLM responses (query expansion, rerank scores)
graph_nodes     -- Code symbols (functions, classes, etc.)
graph_relationships -- Call graph edges (CALLS, IMPORTS, EXTENDS)
graph_embeddings -- Vector embeddings for code symbols
```

## How It Works

### Indexing Flow

```
Collection ──► Glob Pattern ──► Source Files ──► Parse Symbols ──► Build Graph
    │                                                   │              │
    │                                                   │              ▼
    │                                                   │         Generate IDs
    │                                                   │              │
    └──────────────────────────────────────────────────►└──► Store in SQLite
                                                                       │
                                                                       ▼
                                                                  FTS5 Index
                                                               Vector Embeddings
```

### Smart Chunking

Documents are chunked into ~900-token pieces with 15% overlap using smart boundary detection:

```
Document ──► Smart Chunk (~900 tokens) ──► Format each chunk ──► node-llama-cpp ──► Store Vectors
                │                           "title | text"        embedBatch()
                │
                └─► Chunks stored with:
                    - hash: document hash
                    - seq: chunk sequence (0, 1, 2...)
                    - pos: character position in original
```

### Smart Chunking Algorithm

Instead of cutting at hard token boundaries, CodeGraph uses a scoring algorithm to find natural break points:

| Pattern | Score | Description |
|---------|-------|-------------|
| `# Heading` | 100 | H1 - major section |
| `## Heading` | 90 | H2 - subsection |
| `### Heading` | 80 | H3 |
| Code block | 80 | Code fence boundary |
| `---` / `***` | 60 | Horizontal rule |
| Blank line | 20 | Paragraph boundary |

The algorithm searches a 200-token window before the cutoff and scores each break point with distance decay, ensuring semantic units stay together.

### Graph-Aware Embeddings

Unlike simple text embeddings, CodeGraph generates embeddings that include code relationships:

```typescript
// For a function, the embedding text includes:
"function authenticateUser with signature (username: string, password: string): User
calls: hashPassword, verifyToken, getUserByUsername
called by: login, signup, resetPassword"
```

This enables queries like "function that calls tokenize" to find the correct function even if its name doesn't mention "tokenize".

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XDG_CACHE_HOME` | `~/.cache` | Cache directory location |
| `CODEGRAPH_DB_PATH` | `~/.cache/codegraph/index.sqlite` | Database file path |

## License

MIT © Juspay
