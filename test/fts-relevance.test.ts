import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { existsSync, rmSync } from 'fs';

import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { GraphNode, NodeLabel } from '../src/graph/model.js';

const TEST_DB_PATH = '/tmp/codegraph-fts-relevance-test.db';

describe('FTS relevance ranking', () => {
  let backend: SQLiteBackend;

  beforeAll(async () => {
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { force: true });
    }

    backend = new SQLiteBackend();
    await backend.initialize(TEST_DB_PATH);

    await backend.addNodes([
      new GraphNode({
        label: NodeLabel.CLASS,
        name: 'HybridSearchTool',
        filePath: '/src/hybrid-search-tool.ts',
        content: 'Primary tool for hybrid search and retrieval.',
      }),
      new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'executeInternal',
        filePath: '/src/hybrid-search-tool.ts',
        content: 'executes logic for the tool runtime.',
      }),
      new GraphNode({
        label: NodeLabel.FUNCTION,
        name: 'searchExact',
        filePath: '/src/hybrid-search-tool.ts',
        content: 'Searches exact symbols and names.',
      }),
    ]);
  });

  afterAll(async () => {
    await backend.close();
    if (existsSync(TEST_DB_PATH)) {
      rmSync(TEST_DB_PATH, { force: true });
    }
  });

  test('prioritizes full multi-term name matches over partial symbol matches', async () => {
    const results = await backend.ftsSearch('hybrid search', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.nodeName).toBe('HybridSearchTool');
  });
});
