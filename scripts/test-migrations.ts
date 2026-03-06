#!/usr/bin/env bun
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, NodeLabel } from '../src/graph/index.js';
import * as fs from 'fs';

async function test() {
  const dbPath = '/tmp/test-migrations.db';
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  
  const backend = new SQLiteBackend();
  await backend.initialize(dbPath);
  
  const db = (backend as any).getDb();
  
  // Check schema
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables:', tables.map((t: any) => t.name));
  
  // Check migrations
  const migrations = db.prepare('SELECT * FROM schema_migrations').all();
  console.log('Migrations:', migrations);
  
  // Check columns
  const cols = db.prepare('PRAGMA table_info(graph_nodes)').all();
  console.log('Columns:', cols.map((c: any) => c.name));
  
  // Try insert
  const graph = new KnowledgeGraph();
  const node = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'test',
    filePath: '/test.ts',
    content: 'function test() {}',
    language: 'typescript',
  });
  graph.addNode(node);
  await backend.bulkLoad(graph);
  
  console.log('Insert successful');
  await backend.close();
  fs.unlinkSync(dbPath);
}

test().catch(e => {
  console.error('Error:', e.message);
  console.error(e.stack);
});
