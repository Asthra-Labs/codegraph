#!/usr/bin/env bun
/**
 * Sqlite-vec Evidence Script
 * Shows exact CREATE VIRTUAL TABLE, query, and sample output
 */

import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, NodeLabel } from '../src/graph/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-evidence-'));
  const dbPath = path.join(tempDir, 'evidence.db');
  
  const backend = new SQLiteBackend();
  await backend.initialize(dbPath);
  const db = (backend as any).getDb();
  
  // 1. Show CREATE VIRTUAL TABLE statement
  console.log('========================================');
  console.log('1. CREATE VIRTUAL TABLE Statement');
  console.log('========================================');
  const tableInfo = db.prepare(`
    SELECT name, sql FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
  `).get() as { name: string; sql: string };
  console.log(tableInfo.sql);
  console.log('');
  
  // 2. Insert a test node with embedding
  const graph = new KnowledgeGraph();
  const node = new GraphNode({
    label: NodeLabel.FUNCTION,
    name: 'testFunction',
    filePath: '/src/test.ts',
    content: 'function testFunction() { return 42; }',
    language: 'typescript',
  });
  graph.addNode(node);
  await backend.bulkLoad(graph);
  
  // Create a test embedding (768 dim)
  const embedding = Array(768).fill(0).map((_, i) => Math.sin(i * 0.1));
  await backend.storeEmbeddings([{ nodeId: node.id, embedding }]);
  
  // 3. Show the exact query string
  console.log('========================================');
  console.log('2. Exact Query String (from code)');
  console.log('========================================');
  const querySql = `SELECT node_id, distance FROM node_embeddings_vec WHERE embedding MATCH ? AND k = ?`;
  console.log(querySql);
  console.log('');
  
  // 4. Show sample output with distance field
  console.log('========================================');
  console.log('3. Sample Output Row (with distance)');
  console.log('========================================');
  const results = db.prepare(querySql).all(new Float32Array(embedding), 5) as { node_id: string; distance: number }[];
  console.log('Raw result:');
  console.log(JSON.stringify(results[0], null, 2));
  console.log('');
  console.log('Parsed:');
  console.log(`  node_id: "${results[0].node_id}"`);
  console.log(`  distance: ${results[0].distance}`);
  console.log(`  similarity (1 - distance): ${(1 - results[0].distance).toFixed(6)}`);
  console.log('');
  
  // 5. Show DB file size
  const dbStats = fs.statSync(dbPath);
  console.log('========================================');
  console.log('4. DB File Size');
  console.log('========================================');
  console.log(`DB path: ${dbPath}`);
  console.log(`DB size: ${(dbStats.size / 1024).toFixed(2)} KB`);
  console.log('');
  
  // 6. Verify vector count
  const count = db.prepare('SELECT COUNT(*) as count FROM node_embeddings_vec').get() as { count: number };
  console.log('========================================');
  console.log('5. Vector Count');
  console.log('========================================');
  console.log(`Vectors in table: ${count.count}`);
  console.log(`Embedding dimension: 768`);
  console.log(`Vector size: ${768 * 4} bytes (Float32)`);
  console.log('');
  
  await backend.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main().catch(console.error);
