#!/usr/bin/env bun
/**
 * Memory Benchmark for Vector Search
 * 
 * Creates 100k RetrievalDocuments with embeddings, builds vec table,
 * runs 100 vector queries, and reports:
 * - Peak VmRSS (/proc/self/status)
 * - Avg latency
 * - Confirms no full embedding table read into JS memory
 * 
 * Usage: bun run scripts/memory-benchmark.ts
 */

import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph, GraphNode, NodeLabel } from '../src/graph/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DOC_COUNT = parseInt(process.env.DOC_COUNT || '100000', 10);
const EMBEDDING_DIM = 768;
const QUERY_COUNT = parseInt(process.env.QUERY_COUNT || '100', 10);
const TOP_K = 10;

function readVmRssBytes(): number {
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const line = status.split('\n').find(l => l.startsWith('VmRSS:'));
  if (!line) return 0;
  const match = line.match(/VmRSS:\s+(\d+)\s+kB/i);
  if (!match) return 0;
  return parseInt(match[1], 10) * 1024;
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
  console.log('=== Vector Search Memory Benchmark ===\n');
  console.log(`Documents: ${DOC_COUNT.toLocaleString()}`);
  console.log(`Embedding dim: ${EMBEDDING_DIM}`);
  console.log(`Queries: ${QUERY_COUNT}`);
  console.log(`Top-K: ${TOP_K}`);
  console.log('');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-benchmark-'));
  const dbPath = path.join(tempDir, 'benchmark.db');

  try {
    const backend = new SQLiteBackend();
    await backend.initialize(dbPath);
    const db = (backend as any).getDb();

    // Verify vec table exists
    const vecTable = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name='node_embeddings_vec'
    `).get();
    
    if (!vecTable) {
      console.error('ERROR: node_embeddings_vec table does not exist!');
      console.error('sqlite-vec extension may not be loaded.');
      process.exit(1);
    }
    console.log('✓ sqlite-vec virtual table exists');

    // Phase 1: Insert documents with embeddings
    console.log(`\nPhase 1: Inserting ${DOC_COUNT.toLocaleString()} documents...`);
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
        const docCount = Math.min((batch + 1) * batchSize, DOC_COUNT);
        process.stdout.write(`\r  Progress: ${progress}% (${docCount.toLocaleString()} docs)`);
      }
    }
    
    const insertTime = Date.now() - insertStart;
    console.log(`\n  ✓ Insert complete: ${(insertTime / 1000).toFixed(2)}s`);

    // Get table sizes
    const nodeCount = db.prepare(`SELECT COUNT(*) as count FROM graph_nodes`).get() as { count: number };
    const embCount = db.prepare(`SELECT COUNT(*) as count FROM node_embeddings_vec`).get() as { count: number };
    
    console.log(`  Nodes: ${nodeCount.count.toLocaleString()}`);
    console.log(`  Embeddings: ${embCount.count.toLocaleString()}`);

    // Phase 2: Run vector searches
    console.log(`\nPhase 2: Running ${QUERY_COUNT} vector queries...`);
    
    const latencies: number[] = [];
    const rssMeasurements: number[] = [];
    
    for (let i = 0; i < QUERY_COUNT; i++) {
      const query = generateRandomEmbedding();
      
      const rssBefore = readVmRssBytes();
      const start = performance.now();
      
      const results = await backend.vectorSearch(query, TOP_K);
      
      const latency = performance.now() - start;
      const rssAfter = readVmRssBytes();
      
      latencies.push(latency);
      rssMeasurements.push(rssAfter);
      
      if (results.length !== TOP_K) {
        console.warn(`  WARNING: Query ${i} returned ${results.length} results, expected ${TOP_K}`);
      }
    }

    // Phase 3: Report results
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)];
    const p99Latency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.99)];
    
    const peakRss = Math.max(...rssMeasurements);
    const initialRss = rssMeasurements[0];

    console.log('\n=== Results ===\n');
    console.log(`Average latency: ${avgLatency.toFixed(2)}ms`);
    console.log(`P50 latency: ${p50Latency.toFixed(2)}ms`);
    console.log(`P99 latency: ${p99Latency.toFixed(2)}ms`);
    console.log(``);
    console.log(`Peak VmRSS: ${formatBytes(peakRss)}`);
    console.log(`Initial VmRSS: ${formatBytes(initialRss)}`);
    console.log(`VmRSS increase: ${formatBytes(peakRss - initialRss)}`);
    console.log(``);
    
    // Memory verification
    // Each embedding is 768 * 4 = 3072 bytes
    // Loading 100k embeddings into RAM would be ~300MB
    // KNN search should NOT increase VmRSS by more than a few MB
    const theoreticalFullLoad = DOC_COUNT * EMBEDDING_DIM * 4;
    const actualIncrease = peakRss - initialRss;
    
    console.log(`Theoretical memory if all embeddings loaded: ${formatBytes(theoreticalFullLoad)}`);
    console.log(`Actual VmRSS increase during queries: ${formatBytes(actualIncrease)}`);
    console.log(``);
    
    if (actualIncrease < theoreticalFullLoad * 0.1) {
      console.log('✓ PASS: VmRSS increase is < 10% of full-load theoretical maximum');
      console.log('  This confirms KNN search is NOT loading all embeddings into JS memory.');
    } else {
      console.log('✗ FAIL: VmRSS increase is > 10% of full-load theoretical maximum');
      console.log('  This may indicate embeddings are being loaded into JS memory.');
      process.exit(1);
    }

    await backend.close();
    
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runBenchmark().catch(console.error);
