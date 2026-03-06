# CodeGraph - Code Intelligence Platform

Use Bun instead of Node.js (`bun` not `node`, `bun install` not `npm install`).

## Commands

```sh
codegraph collection add . --name <n>   # Create/index collection
codegraph collection list               # List all collections with details
codegraph collection remove <name>      # Remove a collection by name
codegraph collection rename <old> <new> # Rename a collection
codegraph ls [collection[/path]]        # List collections or files in a collection
codegraph context add [path] "text"     # Add context for path (defaults to current dir)
codegraph context list                  # List all contexts
codegraph context check                 # Check for collections/paths missing context
codegraph context rm <path>             # Remove context
codegraph get <file>                    # Get document by path or docid (#abc123)
codegraph multi-get <pattern>           # Get multiple docs by glob or comma-separated list
codegraph status                        # Show index status and collections
codegraph update [--pull]               # Re-index all collections (--pull: git pull first)
codegraph embed                         # Generate vector embeddings (uses node-llama-cpp)
codegraph query <query>                 # Search with query expansion + reranking (recommended)
codegraph search <query>                # Full-text keyword search (BM25, no LLM)
codegraph vsearch <query>               # Vector similarity search (no reranking)
codegraph mcp                           # Start MCP server (stdio transport)
codegraph mcp --http [--port N]         # Start MCP server (HTTP, default port 8181)
codegraph mcp --http --daemon           # Start as background daemon
codegraph mcp stop                      # Stop background MCP daemon
```

## Collection Management

```sh
# List all collections
codegraph collection list

# Create a collection with explicit name
codegraph collection add ~/Documents/notes --name mynotes --mask '**/*.md'

# Remove a collection
codegraph collection remove mynotes

# Rename a collection
codegraph collection rename mynotes my-notes

# List all files in a collection
codegraph ls mynotes

# List files with a path prefix
codegraph ls journals/2025
codegraph ls codegraph://journals/2025
```

## Context Management

```sh
# Add context to current directory (auto-detects collection)
codegraph context add "Description of these files"

# Add context to a specific path
codegraph context add /subfolder "Description for subfolder"

# Add global context to all collections (system message)
codegraph context add / "Always include this context"

# Add context using virtual paths
codegraph context add codegraph://journals/ "Context for entire journals collection"
codegraph context add codegraph://journals/2024 "Journal entries from 2024"

# List all contexts
codegraph context list

# Check for collections or paths without context
codegraph context check

# Remove context
codegraph context rm codegraph://journals/2024
codegraph context rm /  # Remove global context
```

## Document IDs (docid)

Each document has a unique short ID (docid) - the first 6 characters of its content hash.
Docids are shown in search results as `#abc123` and can be used with `get` and `multi-get`:

```sh
# Search returns docid in results
codegraph search "query" --json
# Output: [{"docid": "#abc123", "score": 0.85, "file": "docs/readme.md", ...}]

# Get document by docid
codegraph get "#abc123"
codegraph get abc123              # Leading # is optional

# Docids also work in multi-get comma-separated lists
codegraph multi-get "#abc123, #def456"
```

## Options

```sh
# Search & retrieval
-c, --collection <name>  # Restrict search to a collection (matches pwd suffix)
-n <num>                 # Number of results
--all                    # Return all matches
--min-score <num>        # Minimum score threshold
--full                   # Show full document content
--line-numbers           # Add line numbers to output

# Multi-get specific
-l <num>                 # Maximum lines per file
--max-bytes <num>        # Skip files larger than this (default 10KB)

# Output formats (search and multi-get)
--json, --csv, --md, --xml, --files
```

## Development

```sh
bun src/codegraph.ts <command>   # Run from source
bun link                         # Install globally as 'codegraph'
```

## Tests

All tests live in `test/`. Run everything:

```sh
npx vitest run --reporter=verbose test/
bun test --preload ./src/test-preload.ts test/
```

## Architecture

- SQLite FTS5 for full-text search (BM25)
- sqlite-vec for vector similarity search
- node-llama-cpp for embeddings (embeddinggemma), reranking (qwen3-reranker), and query expansion (Qwen3)
- Reciprocal Rank Fusion (RRF) for combining results
- Smart chunking: 900 tokens/chunk with 15% overlap, prefers markdown headings as boundaries
- Graph storage: SQLite with custom graph tables for code relationships

## Important: Do NOT run automatically

- Never run `codegraph collection add`, `codegraph embed`, or `codegraph update` automatically
- Never modify the SQLite database directly
- Write out example commands for the user to run manually
- Index is stored at `~/.cache/codegraph/index.sqlite`

## Do NOT compile

- Never run `bun build --compile` - it overwrites the shell wrapper and breaks sqlite-vec
- The `codegraph` file is a shell script that runs `bun src/codegraph.ts` - do not replace it
