# QMD to CodeGraph Naming Migration

**Status**: Documentation updated ✅ | Code migration: PRESERVE for xyne-cli compatibility

## Overview

The project was renamed from **QMD** (Query Markup Documents) to **CodeGraph** to better reflect its purpose as a code intelligence platform. This document tracks what was renamed and what was intentionally preserved.

## What Was Changed

### Documentation (Updated)
- ✅ `README.md` - Complete rebrand to CodeGraph
- ✅ `CLAUDE.md` - All CLI examples use `codegraph` command
- ✅ `ARCHITECTURE.md` - Title and references updated to CodeGraph
- ✅ Package name: `@tobilu/qmd` → `@juspay/codegraph`

### Package Configuration (Already Done)
- ✅ `package.json` - Name, description, keywords updated
- ✅ `bin` entry: `"codegraph": "codegraph"`
- ✅ Repository URLs point to `juspay/codegraph`

## What Was Preserved (Intentionally)

The following remain as "qmd" because changing them would break xyne-cli integration:

### Source Files
- `src/qmd.ts` - Main entry point (keep as-is)
- `src/mcp.ts` - MCP server
- `src/store.ts` - Database layer
- All imports and internal references

### Cache Paths
- `~/.cache/qmd/` - Database and model cache location
- `~/.cache/qmd/index.sqlite`
- `~/.cache/qmd/models/`

### Model Names
- `qmd-query-expansion-1.7B-q4_k_m.gguf` - Fine-tuned model identifier
- This is a HuggingFace model name - don't change

### Internal Identifiers
- Database table names remain unchanged
- Virtual path scheme: `qmd://collection/path` (keep for backwards compatibility)

## For xyne-cli Integration

The xyne-cli project depends on codegraph at:
```typescript
import { ... } from 'codegraph/src/qmd.ts';
```

**DO NOT** rename `src/qmd.ts` to `src/codegraph.ts` without updating xyne-cli first.

## Migration Checklist for Future

When xyne-cli is ready to migrate:

- [ ] Rename `src/qmd.ts` → `src/codegraph.ts`
- [ ] Update all imports in codegraph repo
- [ ] Update package.json scripts
- [ ] Update xyne-cli imports to use new path
- [ ] Add symlink `src/qmd.ts` → `src/codegraph.ts` for backwards compatibility
- [ ] Update cache paths from `~/.cache/qmd/` to `~/.cache/codegraph/`
- [ ] Provide migration script to move existing databases

## References

- Main migration doc: `MIGRATION.md` (Axon → CodeGraph technical migration)
- Architecture: `ARCHITECTURE.md`
- Usage guide: `CLAUDE.md`
