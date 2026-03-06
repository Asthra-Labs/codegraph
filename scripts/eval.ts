#!/usr/bin/env bun
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { createGoldenCorpus, type EvalQuery } from '../test/golden-corpus.js';
import { unifiedSearch } from '../src/search/unified-search.js';
import { processQuery } from '../src/search/query-processor.js';

const TOP_K = 10;

type QueryMetrics = {
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
};

type FailedCase = {
  id: string;
  category: string;
  query: string;
  relevantIds: string[];
  top10: Array<{ rank: number; id: string; name: string; file: string; source: string; score: number }>;
};

function embedText(text: string, dims = 768): number[] {
  const out = new Array<number>(dims).fill(0);
  const tokens = text.toLowerCase().split(/[^a-z0-9_/.:-]+/).filter(Boolean);
  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % dims;
    out[idx] += 1;
  }
  const norm = Math.sqrt(out.reduce((a, b) => a + b * b, 0)) || 1;
  return out.map(v => v / norm);
}

function dcgAt10(relevance: number[]): number {
  let score = 0;
  for (let i = 0; i < Math.min(10, relevance.length); i++) {
    const rel = relevance[i] || 0;
    score += rel / Math.log2(i + 2);
  }
  return score;
}

function scoreQuery(query: EvalQuery, rankedIds: string[]): QueryMetrics {
  const top = rankedIds.slice(0, TOP_K);
  const relSet = new Set(query.relevantIds);
  const hits = top.filter(id => relSet.has(id)).length;
  const recallAt10 = query.relevantIds.length > 0 ? hits / query.relevantIds.length : 0;

  let mrrAt10 = 0;
  for (let i = 0; i < top.length; i++) {
    if (relSet.has(top[i]!)) {
      mrrAt10 = 1 / (i + 1);
      break;
    }
  }

  const relevance = top.map(id => (relSet.has(id) ? 1 : 0));
  const ideal = new Array(Math.min(TOP_K, query.relevantIds.length)).fill(1);
  const ndcgAt10 = dcgAt10(ideal) > 0 ? dcgAt10(relevance) / dcgAt10(ideal) : 0;

  return { recallAt10, mrrAt10, ndcgAt10 };
}

function avg(items: number[]): number {
  return items.length ? items.reduce((a, b) => a + b, 0) / items.length : 0;
}

async function main() {
  const outPath = process.argv[2] || 'docs/eval-results.json';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-eval-'));
  const dbPath = path.join(tempDir, 'eval.db');
  const backend = new SQLiteBackend();

  try {
    await backend.initialize(dbPath);
    const corpus = createGoldenCorpus();
    await backend.bulkLoad({ getAllNodes: () => corpus.nodes, getAllRelationships: () => corpus.relationships } as any);

    const embeddings = corpus.nodes.map(node => ({
      nodeId: node.id,
      embedding: embedText(`${node.name}\n${node.filePath}\n${node.content || ''}`),
    }));
    await backend.storeEmbeddings(embeddings);

    const db = (backend as any).getDb();
    const categoryScores = new Map<string, QueryMetrics[]>();
    const failures: FailedCase[] = [];

    for (const q of corpus.evalQueries) {
      const processed = processQuery(q.query);
      const queryEmbedding = embedText(q.query);
      const results = await unifiedSearch(
        q.query,
        db,
        backend,
        queryEmbedding,
        {
          limit: TOP_K,
          includeRetrievalDocs: false,
          includeCallGraph: processed.intent === 'usage',
          isSemanticIntent: processed.intent === 'semantic',
        }
      );

      const top10 = results.slice(0, TOP_K).map((r, idx) => ({
        rank: idx + 1,
        id: r.nodeId,
        name: r.nodeName,
        file: r.filePath,
        source: r.source,
        score: Number((r.rrfScore ?? r.score).toFixed(6)),
      }));

      const metrics = scoreQuery(q, top10.map(r => r.id));
      const list = categoryScores.get(q.category) || [];
      list.push(metrics);
      categoryScores.set(q.category, list);

      if (metrics.recallAt10 < 1) {
        failures.push({
          id: q.id,
          category: q.category,
          query: q.query,
          relevantIds: q.relevantIds,
          top10,
        });
      }
    }

    const byCategory: Record<string, QueryMetrics> = {};
    for (const [category, scores] of categoryScores.entries()) {
      byCategory[category] = {
        recallAt10: Number(avg(scores.map(s => s.recallAt10)).toFixed(4)),
        mrrAt10: Number(avg(scores.map(s => s.mrrAt10)).toFixed(4)),
        ndcgAt10: Number(avg(scores.map(s => s.ndcgAt10)).toFixed(4)),
      };
    }

    const all = Array.from(categoryScores.values()).flat();
    const summary = {
      recallAt10: Number(avg(all.map(s => s.recallAt10)).toFixed(4)),
      mrrAt10: Number(avg(all.map(s => s.mrrAt10)).toFixed(4)),
      ndcgAt10: Number(avg(all.map(s => s.ndcgAt10)).toFixed(4)),
      totalQueries: all.length,
      failedQueries: failures.length,
    };

    const payload = {
      generatedAt: new Date().toISOString(),
      topK: TOP_K,
      summary,
      byCategory,
      failures,
    };

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    console.log(JSON.stringify(payload, null, 2));
  } finally {
    await backend.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
