import { SQLiteBackend } from "./src/graph/sqlite-backend.js";
import { Database } from "bun:sqlite";

const DB_PATH = "/home/gpu/workspace/juspay/xyne-cli/.xyne/codegraph-index/index.db";

async function main() {
  console.log("=== CodeGraph Quality Test ===\n");

  const backend = new SQLiteBackend();
  await backend.initialize(DB_PATH);

  const db = new Database(DB_PATH);

  console.log("--- Test 1: Database Content ---\n");
  
  const nodeCount = db.prepare("SELECT COUNT(*) as count FROM graph_nodes").get() as { count: number };
  const ftsCount = db.prepare("SELECT COUNT(*) as count FROM graph_nodes_fts").get() as { count: number };
  const relCount = db.prepare("SELECT COUNT(*) as count FROM graph_relationships").get() as { count: number };
  const embeddingCount = db.prepare("SELECT COUNT(*) as count FROM node_embeddings_raw").get() as { count: number };
  
  console.log(`  Nodes: ${nodeCount.count}`);
  console.log(`  FTS entries: ${ftsCount.count}`);
  console.log(`  Relationships: ${relCount.count}`);
  console.log(`  Embeddings: ${embeddingCount.count}`);
  
  if (nodeCount.count === 0) {
    console.log("  ❌ CRITICAL: No nodes in database - index is empty!");
    return;
  } else if (nodeCount.count < 100) {
    console.log("  ⚠️  WARNING: Very few nodes - partial index?");
  } else {
    console.log("  ✅ Database has content");
  }
  
  const sampleNodes = db.prepare("SELECT id, name, file_path, label FROM graph_nodes LIMIT 5").all() as Array<{id: string; name: string; file_path: string; label: string}>;
  console.log("\n  Sample nodes:");
  for (const node of sampleNodes) {
    console.log(`    - ${node.name} (${node.label}) @ ${node.file_path}`);
  }

  console.log("\n--- Test 2: FTS Search Quality ---\n");

  const queries = [
    "search",
    "function handler",
    "parse json",
    "config file",
    "tool implementation"
  ];

  for (const query of queries) {
    console.log(`Query: "${query}"`);
    const results = await backend.ftsSearch(query, 5);
    
    if (results.length === 0) {
      console.log("  No results\n");
      continue;
    }

    const scores = results.map(r => r.score);
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    const gap = max - min;

    console.log(`  Results: ${results.length}`);
    console.log(`  Score range: ${min.toFixed(3)} - ${max.toFixed(3)}`);
    console.log(`  Gap: ${gap.toFixed(3)} ${gap >= 0.2 ? "✅" : gap >= 0.1 ? "⚡" : "⚠️"}`);
    
    console.log("  Top 3:");
    for (let i = 0; i < Math.min(3, results.length); i++) {
      const r = results[i];
      console.log(`    ${i + 1}. ${r.nodeName || r.filePath} (score: ${r.score.toFixed(3)})`);
    }
    console.log("");
  }

  console.log("\n--- Test 3: Score Distribution Analysis ---\n");

  const allScores: number[] = [];
  for (const query of queries) {
    const results = await backend.ftsSearch(query, 10);
    allScores.push(...results.map(r => r.score));
  }

  if (allScores.length > 0) {
    allScores.sort((a, b) => a - b);
    
    const p10 = allScores[Math.floor(allScores.length * 0.1)];
    const p50 = allScores[Math.floor(allScores.length * 0.5)];
    const p90 = allScores[Math.floor(allScores.length * 0.9)];
    
    console.log(`Score distribution across ${allScores.length} results:`);
    console.log(`  10th percentile: ${p10.toFixed(3)}`);
    console.log(`  50th percentile: ${p50.toFixed(3)}`);
    console.log(`  90th percentile: ${p90.toFixed(3)}`);
    console.log(`  Range: ${(p90 - p10).toFixed(3)}`);
    
    if (p90 - p10 < 0.1) {
      console.log("  ❌ POOR: Scores are too compressed - results not differentiated");
    } else if (p90 - p10 < 0.2) {
      console.log("  ⚡ MODERATE: Some differentiation but could be better");
    } else {
      console.log("  ✅ GOOD: Scores well distributed");
    }
  }

  console.log("\n--- Test 4: Multiple Symbols Per File (Expected Behavior) ---\n");

  for (const query of ["function", "class", "import"]) {
    const results = await backend.ftsSearch(query, 20);
    const filePaths = results.map(r => r.filePath);
    const uniqueFiles = new Set(filePaths);
    const symbolsPerFile = filePaths.length - uniqueFiles.size;
    
    console.log(`Query "${query}": ${results.length} symbols from ${uniqueFiles.size} files (${symbolsPerFile} additional symbols in same files)`);
    
    // Check for ACTUAL duplicates (same symbol appearing twice)
    const seenKeys = new Set<string>();
    let actualDups = 0;
    for (const r of results) {
      const key = `${r.nodeName}:${r.filePath}`;
      if (seenKeys.has(key)) {
        actualDups++;
      }
      seenKeys.add(key);
    }
    if (actualDups > 0) {
      console.log(`  ❌ Found ${actualDups} actual duplicate entries (same symbol twice)`);
    }
  }

  console.log("\n--- Test 5: Relevance Check ---\n");

  const relevanceTests = [
    { query: "hybrid search", expectContains: ["hybrid", "search"] },
    { query: "tool processor", expectContains: ["tool", "processor"] },
    { query: "json config", expectContains: ["json", "config"] },
  ];

  for (const test of relevanceTests) {
    const results = await backend.ftsSearch(test.query, 5);
    console.log(`Query: "${test.query}"`);
    
    if (results.length === 0) {
      console.log("  ⚠️  No results");
      continue;
    }
    
    const topResult = results[0];
    const content = ((topResult as any).content || "").toLowerCase();
    const nodeName = (topResult.nodeName || "").toLowerCase();
    
    const matchedKeywords = test.expectContains.filter(kw => 
      content.includes(kw.toLowerCase()) || nodeName.includes(kw.toLowerCase())
    );
    
    if (matchedKeywords.length >= 2) {
      console.log(`  ✅ Relevant: matched ${matchedKeywords.join(", ")}`);
    } else if (matchedKeywords.length === 1) {
      console.log(`  ⚡ Partially relevant: matched ${matchedKeywords[0]}`);
    } else {
      console.log(`  ❌ Not relevant: expected ${test.expectContains.join(" or ")}`);
    }
    console.log(`    Top result: ${topResult.nodeName} @ ${topResult.filePath}\n`);
  }

  console.log("\n=== Quality Test Complete ===\n");
  
  db.close();
}

main().catch(console.error);
