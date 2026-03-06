#!/usr/bin/env bun
/**
 * Accurate Memory Benchmark with SQLite Cache Control
 * 
 * Key insight: SQLite caches data in memory by default.
 * We need to control cache_size to measure actual KNN query memory.
 */

import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { GraphNode, NodeLabel } from '../src/graph/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DOC_COUNT = parseInt(process.env.DOC_COUNT || '100000', 10);
const EMBEDDING_DIM = 768;
const QUERY_COUNT = parseInt(process.env.QUERY_COUNT || '100', 10);
const TOP_K = 10;

function getRSSMB(): number {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const match = status.match(/VmRSS:\s*(\d+)\s*kB/);
    if (match) {
      return parseInt(match[1], 10) / 1024;
    }
  } catch (e) {}
  return process.memoryUsage().rss / (1024 * 1024);
}

function generateRandomEmbedding(): number[] {
  const emb: number[] = [];
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    emb.push(Math.random() * 2 - 1);
  }
  return emb;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function runBenchmark(): Promise<void> {
  console.log('========================================');
  console.log('Vector Search Memory Benchmark (Accurate)');
  console.log('========================================\n');
  console.log(`Documents: ${DOC_COUNT.toLocaleString()}`);
  console.log(`Embedding dim: ${EMBEDDING_DIM}`);
  console.log(`Vector size: ${EMBEDDING_DIM * 4} bytes`);
  console.log(`Theoretical vector data: ${formatBytes(DOC_COUNT * EMBEDDING_DIM * 4)}`);
  console.log('');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mem-'));
  const dbPath = path.join(tempDir, 'benchmark.db');

  try {
    const rssBefore = getRSSMB();
    
    const backend = new SQLiteBackend();
    await backend.initialize(dbPath);
    const db = (backend as any).getDb();
    
    // Set small cache to prevent SQLite from caching everything
    db.exec('PRAGMA cache_size = -10000'); // 10MB cache max
    db.exec('PRAGMA mmap_size = 0'); // Disable mmap
    
    const rssAfterInit = getRSSMB();
    
    // Phase 1: Insert documents
    console.log(`[Phase 1] Inserting ${DOC_COUNT.toLocaleString()} vectors...`);
    const insertStart = Date.now();
    
    const batchSize = 1000;
    const batches = Math.ceil(DOC_COUNT / batchSize);
    
    for (let batch = 0; batch < batches; batch++) {
      const nodes: GraphNode[] = [];
      const embeddings: { nodeId: string; embedding: number[] }[] = [];
      
      const startIdx = batch * batchSize;
      const endIdx = Math.min(startIdx + batchSize, DOC_COUNT);
      
      for (let i = startIdx; i < endIdx; i++) {
        const node = new GraphNode({
          label: NodeLabel.FUNCTION,
          name: `func${i}`,
          filePath: `/src/file${Math.floor(i / 100)}.ts`,
          content: `function func${i}() { return ${i}; }`,
          language: 'typescript',
        });
        nodes.push(node);
        embeddings.push({
          nodeId: node.id,
          embedding: generateRandomEmbedding(),
        });
      }
      
      await backend.addNodes(nodes);
      await backend.storeEmbeddings(embeddings);
      
      if ((batch + 1) % 10 === 0 || batch === batches - 1) {
        const progress = ((batch + 1) / batches * 100).toFixed(1);
        process.stdout.write(`\r  Progress: ${progress}% (${Math.min((batch + 1) * batchSize, DOC_COUNT).toLocaleString()})`);
      }
    }
    
    const insertTime = Date.now() - insertStart;
    console.log(`\n  ✓ Insert: ${(insertTime / 1000).toFixed(2)}s`);

    // Get counts
    const nodeCount = db.prepare(`SELECT COUNT(*) as count FROM graph_nodes`).get() as { count: number };
    const embCount = db.prepare(`SELECT COUNT(*) as count FROM node_embeddings_vec`).get() as { count: number };
    const dbStats = fs.statSync(dbPath);
    
    // Phase 2: Clear caches and prepare for query benchmark
    console.log('\n[Phase 2] Preparing for query benchmark...');
    
    // Clear SQLite page cache
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    
    // Release JS memory
    if (global.gc) {
      global.gc();
      console.log('  Ran GC');
    }
    
    const rssBeforeQueries = getRSSMB();
    
    // Phase 3: Run queries and measure
    console.log(`\n[Phase 3] Running ${QUERY_COUNT} queries...`);
    
    const latencies: number[] = [];
    const rssMeasurements: number[] = [];
    
    for (let i = 0; i < QUERY_COUNT; i++) {
      const query = generateRandomEmbedding();
      
      const start = performance.now();
      const results = await backend.vectorSearch(query, TOP_K);
      const latency = performance.now() - start;
      
      latencies.push(latency);
      rssMeasurements.push(getRSSMB());
    }

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)];
    const p99Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.99)];
    const peakRSS = Math.max(...rssMeasurements);
    const rssAfterQueries = rssMeasurements[rssMeasurements.length - 1] || peakRSS;

    // Report
    console.log('\n========================================');
    console.log('Results');
    console.log('========================================');
    console.log(`\nData:`);
    console.log(`  Nodes: ${nodeCount.count.toLocaleString()}`);
    console.log(`  Vectors: ${embCount.count.toLocaleString()}`);
    console.log(`  DB file size: ${formatBytes(dbStats.size)}`);
    console.log(`\nQuery latency:`);
    console.log(`  Average: ${avgLatency.toFixed(2)} ms`);
    console.log(`  P50: ${p50Latency.toFixed(2)} ms`);
    console.log(`  P99: ${p99Latency.toFixed(2)} ms`);
    console.log(`\nMemory (RSS from /proc/self/status VmRSS):`);
    console.log(`  Before init: ${rssBefore.toFixed(2)} MB`);
    console.log(`  After init: ${rssAfterInit.toFixed(2)} MB`);
    console.log(`  After insert (before queries): ${rssBeforeQueries.toFixed(2)} MB`);
    console.log(`  Peak during queries: ${peakRSS.toFixed(2)} MB`);
    console.log(`  After queries: ${rssAfterQueries.toFixed(2)} MB`);
    
    const rssIncrease = rssAfterQueries - rssBeforeQueries;
    const theoreticalData = DOC_COUNT * EMBEDDING_DIM * 4;
    
    console.log(`\nMemory Analysis:`);
    console.log(`  RSS increase during queries: ${rssIncrease.toFixed(2)} MB`);
    console.log(`  Theoretical vector data: ${formatBytes(theoreticalData)}`);
    console.log(`  Ratio: ${((rssIncrease * 1024 * 1024) / theoreticalData * 100).toFixed(1)}%`);
    
    if (rssIncrease < 50) {
      console.log(`\n✓ PASS: RSS increase during queries < 50 MB`);
      console.log(`  Vectors are stored in sqlite-vec and accessed via KNN index.`);
      console.log(`  Query memory is O(k), not O(n).`);
    } else {
      console.log(`\n✗ WARN: RSS increase during queries > 50 MB`);
      console.log(`  Check if vectors are being loaded into JS memory.`);
    }

    await backend.close();
    
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runBenchmark().catch(console.error);
