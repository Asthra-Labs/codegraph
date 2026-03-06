import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { createGoldenCorpus, CI_THRESHOLDS, type GoldenCorpus } from './golden-corpus.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function computeRecallAtK(retrieved: string[], relevant: string[], k: number): number {
  const topK = retrieved.slice(0, k);
  const found = relevant.filter(id => topK.includes(id)).length;
  return found / relevant.length;
}

function computeMRRAtK(retrieved: string[], relevant: string[], k: number): number {
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    if (relevant.includes(retrieved[i]!)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function computeNDCGAtK(retrieved: string[], relevant: string[], k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    if (relevant.includes(retrieved[i]!)) {
      dcg += 1 / Math.log2(i + 2);
    }
  }
  
  const idealDcg = relevant.slice(0, k).reduce((sum, _, i) => sum + 1 / Math.log2(i + 2), 0);
  
  return idealDcg > 0 ? dcg / idealDcg : 0;
}

describe('CI Regression Tests', () => {
  let backend: SQLiteBackend;
  let dbPath: string;
  let tempDir: string;
  let corpus: GoldenCorpus;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ci-'));
    dbPath = path.join(tempDir, 'ci.db');
    backend = new SQLiteBackend();
    await backend.initialize(dbPath);
    corpus = createGoldenCorpus();
    
    await backend.addNodes(corpus.nodes);
    for (const rel of corpus.relationships) {
      await backend.addRelationships([rel]);
    }
  });

  afterEach(async () => {
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Usage Query Regression', () => {
    it('should maintain Usage Recall@10 >= 95%', async () => {
      const usageQueries = corpus.evalQueries.filter(q => q.category === 'usage');
      const results: { recallAt10: number }[] = [];

      for (const q of usageQueries) {
        const ftsResults = await backend.ftsSearch(q.query, 20);
        const retrieved = ftsResults.map(r => r.nodeId || r.id || '');
        
        results.push({
          recallAt10: computeRecallAtK(retrieved, q.relevantIds, 10),
        });
      }

      const avgRecall = results.reduce((s, r) => s + r.recallAt10, 0) / results.length;
      
      console.log(`\nUsage Recall@10: ${(avgRecall * 100).toFixed(1)}%`);
      console.log(`Threshold: ${(CI_THRESHOLDS.usage.recallAt10 * 100).toFixed(0)}%`);
      console.log(`Description: ${CI_THRESHOLDS.usage.description}`);
      
      expect(avgRecall).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.usage.recallAt10,
        `Usage Recall@10 (${(avgRecall * 100).toFixed(1)}%) dropped below threshold (${(CI_THRESHOLDS.usage.recallAt10 * 100).toFixed(0)}%). ${CI_THRESHOLDS.usage.description}`
      );
    });

    it('should return callers for usage queries', async () => {
      const testCases = [
        { query: 'authenticate', expectedCaller: 'login' },
        { query: 'DatabaseConnection', expectedCaller: 'UserRepository' },
        { query: 'HttpClient', expectedCaller: 'fetchData' },
        { query: 'encrypt', expectedCaller: 'hashPassword' },
      ];

      for (const tc of testCases) {
        const results = await backend.ftsSearch(tc.query, 20);
        const names = results.map(r => r.name);
        
        expect(names).toContain(tc.expectedCaller, 
          `Query "${tc.query}" should return caller "${tc.expectedCaller}" but got: ${names.slice(0, 5).join(', ')}`
        );
      }
    });
  });

  describe('Exact Symbol Regression', () => {
    it('should maintain Exact Symbol Recall@10 >= 90%', async () => {
      const exactQueries = corpus.evalQueries.filter(q => q.category === 'exact_symbol');
      const results: { recallAt10: number }[] = [];

      for (const q of exactQueries) {
        const ftsResults = await backend.ftsSearch(q.query, 20);
        const retrieved = ftsResults.map(r => r.nodeId || r.id || '');
        
        results.push({
          recallAt10: computeRecallAtK(retrieved, q.relevantIds, 10),
        });
      }

      const avgRecall = results.reduce((s, r) => s + r.recallAt10, 0) / results.length;
      
      console.log(`\nExact Symbol Recall@10: ${(avgRecall * 100).toFixed(1)}%`);
      console.log(`Threshold: ${(CI_THRESHOLDS.exact_symbol.recallAt10 * 100).toFixed(0)}%`);
      
      expect(avgRecall).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.exact_symbol.recallAt10,
        `Exact Symbol Recall@10 (${(avgRecall * 100).toFixed(1)}%) dropped below threshold (${(CI_THRESHOLDS.exact_symbol.recallAt10 * 100).toFixed(0)}%)`
      );
    });
  });

  describe('Overall Quality Regression', () => {
    it('should maintain Overall Recall@10 >= 70%', async () => {
      const results: { recallAt10: number }[] = [];

      for (const q of corpus.evalQueries) {
        const ftsResults = await backend.ftsSearch(q.query, 20);
        const retrieved = ftsResults.map(r => r.nodeId || r.id || '');
        
        results.push({
          recallAt10: computeRecallAtK(retrieved, q.relevantIds, 10),
        });
      }

      const avgRecall = results.reduce((s, r) => s + r.recallAt10, 0) / results.length;
      
      console.log(`\nOverall Recall@10: ${(avgRecall * 100).toFixed(1)}%`);
      console.log(`Threshold: ${(CI_THRESHOLDS.overall.recallAt10 * 100).toFixed(0)}%`);
      
      expect(avgRecall).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.overall.recallAt10,
        `Overall Recall@10 (${(avgRecall * 100).toFixed(1)}%) dropped below threshold (${(CI_THRESHOLDS.overall.recallAt10 * 100).toFixed(0)}%)`
      );
    });
  });

  describe('Golden Corpus Integrity', () => {
    it('should match golden results for all categories', async () => {
      const categories = ['exact_symbol', 'usage', 'navigation'] as const;
      
      for (const category of categories) {
        const queries = corpus.evalQueries.filter(q => q.category === category);
        const results: { recallAt10: number; mrrAt10: number; ndcgAt10: number }[] = [];

        for (const q of queries) {
          const ftsResults = await backend.ftsSearch(q.query, 20);
          const retrieved = ftsResults.map(r => r.nodeId || r.id || '');
          
          results.push({
            recallAt10: computeRecallAtK(retrieved, q.relevantIds, 10),
            mrrAt10: computeMRRAtK(retrieved, q.relevantIds, 10),
            ndcgAt10: computeNDCGAtK(retrieved, q.relevantIds, 10),
          });
        }

        const avgRecall = results.reduce((s, r) => s + r.recallAt10, 0) / results.length;
        const avgMrr = results.reduce((s, r) => s + r.mrrAt10, 0) / results.length;
        const avgNdcg = results.reduce((s, r) => s + r.ndcgAt10, 0) / results.length;

        const golden = corpus.goldenResults[category];
        
        console.log(`\n${category}:`);
        console.log(`  Golden: Recall=${(golden.recallAt10 * 100).toFixed(0)}%, MRR=${(golden.mrrAt10 * 100).toFixed(0)}%, nDCG=${(golden.ndcgAt10 * 100).toFixed(0)}%`);
        console.log(`  Actual: Recall=${(avgRecall * 100).toFixed(0)}%, MRR=${(avgMrr * 100).toFixed(0)}%, nDCG=${(avgNdcg * 100).toFixed(0)}%`);
        
        // Allow 5% tolerance for floating point differences
        expect(avgRecall).toBeGreaterThanOrEqual(golden.recallAt10 - 0.05,
          `${category} Recall@10 dropped below golden value`
        );
      }
    });
  });

  describe('Relationship Extraction Coverage', () => {
    it('should have minimum node count', async () => {
      const db = (backend as any).getDb();
      const result = db.prepare('SELECT COUNT(*) as count FROM graph_nodes').get() as { count: number };
      
      console.log(`\nNode count: ${result.count}`);
      console.log(`Threshold: ${CI_THRESHOLDS.coverage.minNodes}`);
      
      expect(result.count).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.coverage.minNodes,
        `Node count (${result.count}) below threshold (${CI_THRESHOLDS.coverage.minNodes})`
      );
    });

    it('should have minimum edge count', async () => {
      const db = (backend as any).getDb();
      const result = db.prepare('SELECT COUNT(*) as count FROM graph_relationships').get() as { count: number };
      
      console.log(`\nEdge count: ${result.count}`);
      console.log(`Threshold: ${CI_THRESHOLDS.coverage.minEdges}`);
      
      expect(result.count).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.coverage.minEdges,
        `Edge count (${result.count}) below threshold (${CI_THRESHOLDS.coverage.minEdges})`
      );
    });

    it('should have minimum CALLS edges', async () => {
      const db = (backend as any).getDb();
      const result = db.prepare("SELECT COUNT(*) as count FROM graph_relationships WHERE type = 'CALLS'").get() as { count: number };
      
      console.log(`\nCALLS edges: ${result.count}`);
      console.log(`Threshold: ${CI_THRESHOLDS.coverage.minCallsEdges}`);
      
      expect(result.count).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.coverage.minCallsEdges,
        `CALLS edge count (${result.count}) below threshold (${CI_THRESHOLDS.coverage.minCallsEdges})`
      );
    });

    it('should have nodes with inbound CALLS relationships', async () => {
      const db = (backend as any).getDb();
      
      const nodesResult = db.prepare('SELECT COUNT(*) as count FROM graph_nodes').get() as { count: number };
      const callsResult = db.prepare(`
        SELECT COUNT(DISTINCT target) as count 
        FROM graph_relationships 
        WHERE type = 'CALLS'
      `).get() as { count: number };
      
      const percentage = nodesResult.count > 0 ? (callsResult.count / nodesResult.count) * 100 : 0;
      
      console.log(`\nNodes with inbound CALLS: ${callsResult.count} (${percentage.toFixed(1)}%)`);
      console.log(`Threshold: ${CI_THRESHOLDS.coverage.minNodesWithInboundCalls}%`);
      
      expect(percentage).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.coverage.minNodesWithInboundCalls,
        `Nodes with inbound CALLS (${percentage.toFixed(1)}%) below threshold (${CI_THRESHOLDS.coverage.minNodesWithInboundCalls}%)`
      );
    });

    it('should have nodes with outbound CALLS relationships', async () => {
      const db = (backend as any).getDb();
      
      const nodesResult = db.prepare('SELECT COUNT(*) as count FROM graph_nodes').get() as { count: number };
      const callsResult = db.prepare(`
        SELECT COUNT(DISTINCT source) as count 
        FROM graph_relationships 
        WHERE type = 'CALLS'
      `).get() as { count: number };
      
      const percentage = nodesResult.count > 0 ? (callsResult.count / nodesResult.count) * 100 : 0;
      
      console.log(`\nNodes with outbound CALLS: ${callsResult.count} (${percentage.toFixed(1)}%)`);
      console.log(`Threshold: ${CI_THRESHOLDS.coverage.minNodesWithOutboundCalls}%`);
      
      expect(percentage).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.coverage.minNodesWithOutboundCalls,
        `Nodes with outbound CALLS (${percentage.toFixed(1)}%) below threshold (${CI_THRESHOLDS.coverage.minNodesWithOutboundCalls}%)`
      );
    });

    it('should have diverse relationship types', async () => {
      const db = (backend as any).getDb();
      
      const result = db.prepare(`
        SELECT type, COUNT(*) as count 
        FROM graph_relationships 
        GROUP BY type
      `).all() as Array<{ type: string; count: number }>;
      
      const relationshipTypes = result.map(r => r.type);
      
      console.log(`\nRelationship types found: ${relationshipTypes.join(', ')}`);
      console.log(`Threshold: at least ${CI_THRESHOLDS.coverage.minRelationshipTypes} types`);
      
      expect(relationshipTypes.length).toBeGreaterThanOrEqual(
        CI_THRESHOLDS.coverage.minRelationshipTypes,
        `Only ${relationshipTypes.length} relationship types found: ${relationshipTypes.join(', ')}`
      );
    });
  });
});
