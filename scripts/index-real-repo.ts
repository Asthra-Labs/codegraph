#!/usr/bin/env bun
/**
 * Index a real TypeScript repository and collect graph coverage stats.
 * 
 * Usage: bun run scripts/index-real-repo.ts <repo-path> [output-doc-path]
 */

import * as fs from 'fs';
import * as path from 'path';
import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { KnowledgeGraph } from '../src/graph/knowledge-graph.js';
import { GraphNode, GraphRelationship, NodeLabel, RelType } from '../src/graph/model.js';
import { TypeScriptParser } from '../src/parsers/typescript.js';
import { JavaScriptParser } from '../src/parsers/typescript.js';

interface RepoStats {
  repoPath: string;
  indexedAt: string;
  files: {
    total: number;
    typescript: number;
    javascript: number;
    skipped: number;
  };
  nodes: {
    total: number;
    byLabel: Record<string, number>;
    exported: number;
    entryPoints: number;
    deadCode: number;
  };
  edges: {
    total: number;
    byType: Record<string, number>;
    callsStats: {
      total: number;
      resolved: number;
      unresolved: number;
      unresolvedPercent: number;
    };
    confidenceDistribution: Record<string, number>;
  };
  coverage: {
    nodesWithInboundCalls: number;
    nodesWithOutboundCalls: number;
    avgInboundCalls: number;
    avgOutboundCalls: number;
    callDensity: number;
    relationshipDensity: number;
  };
  performance: {
    indexTimeMs: number;
    filesPerSecond: number;
    symbolsPerSecond: number;
  };
}

async function indexRepo(repoPath: string, dbPath: string): Promise<RepoStats> {
  const startTime = Date.now();
  const tsParser = new TypeScriptParser();
  const jsParser = new JavaScriptParser();
  
  const backend = new SQLiteBackend();
  await backend.initialize(dbPath);
  const db = (backend as any).getDb();

  const graph = new KnowledgeGraph();

  const files = {
    total: 0,
    typescript: 0,
    javascript: 0,
    skipped: 0,
  };

  const allRelationships: Array<{ type: string; source: string; target: string; confidence: number; line: number }> = [];

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  
  async function walkDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', '.xyne', 'coverage', '.next', '.nuxt'].includes(entry.name)) {
          continue;
        }
        await walkDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!extensions.includes(ext)) continue;
        
        files.total++;
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relativePath = path.relative(repoPath, fullPath);
        
        try {
          const parseResult = ext === '.ts' || ext === '.tsx'
            ? await tsParser.parse(content, relativePath)
            : await jsParser.parse(content, relativePath);

          if (ext === '.ts' || ext === '.tsx') {
            files.typescript++;
          } else {
            files.javascript++;
          }

          for (const symbol of parseResult.symbols) {
            const label = mapKindToLabel(symbol.kind);
            const node = new GraphNode({
              id: symbol.id,
              label,
              name: symbol.name,
              filePath: symbol.filePath,
              startLine: symbol.startLine,
              endLine: symbol.endLine,
              content: symbol.content,
              signature: symbol.signature,
              className: symbol.className,
              isExported: symbol.isExported,
            });
            graph.addNode(node);
          }

          for (const rel of parseResult.relationships) {
            allRelationships.push({
              type: rel.type,
              source: rel.sourceId,
              target: rel.target,
              confidence: rel.confidence,
              line: rel.line,
            });
          }

        } catch (err) {
          files.skipped++;
          console.error(`  Error parsing ${relativePath}: ${err}`);
        }
      }
    }
  }

  console.log(`\n=== Indexing ${repoPath} ===\n`);
  await walkDir(repoPath);

  const allNodes = graph.getAllNodes();
  const allRels = graph.getAllRelationships();

  const nodeMap = new Map<string, GraphNode>();
  for (const node of allNodes) {
    nodeMap.set(node.name, node);
    nodeMap.set(node.id, node);
  }

  let resolvedCalls = 0;
  let unresolvedCalls = 0;

  for (const rel of allRelationships) {
    const relType = mapRelType(rel.type);
    let targetId = nodeMap.get(rel.target)?.id;
    
    if (rel.type === 'calls' || rel.type === 'instantiates') {
      if (targetId) {
        resolvedCalls++;
      } else {
        unresolvedCalls++;
        targetId = `unresolved:${rel.target}`;
      }
    }

    if (!targetId) continue;

    const graphRel = new GraphRelationship({
      type: relType,
      source: rel.source,
      target: targetId,
    });
    graph.addRelationship(graphRel);
  }

  console.log(`\n  Files: ${files.total} (TS: ${files.typescript}, JS: ${files.javascript}, Skipped: ${files.skipped})`);
  console.log(`  Nodes: ${allNodes.length}`);
  console.log(`  Relationships: ${allRels.length}`);

  await backend.bulkLoad(graph);

  const indexTimeMs = Date.now() - startTime;

  const stats = await collectStats(backend, repoPath, files, allRelationships, resolvedCalls, unresolvedCalls, indexTimeMs, allNodes.length);
  
  await backend.close();
  return stats;
}

function mapKindToLabel(kind: string): NodeLabel {
  const mapping: Record<string, NodeLabel> = {
    function: NodeLabel.FUNCTION,
    method: NodeLabel.METHOD,
    class: NodeLabel.CLASS,
    interface: NodeLabel.INTERFACE,
    enum: NodeLabel.ENUM,
    typeAlias: NodeLabel.TYPE_ALIAS,
    constant: NodeLabel.FUNCTION,
    variable: NodeLabel.FUNCTION,
  };
  return mapping[kind] || NodeLabel.FUNCTION;
}

function mapRelType(type: string): RelType {
  const mapping: Record<string, RelType> = {
    calls: RelType.CALLS,
    imports: RelType.IMPORTS,
    extends: RelType.EXTENDS,
    implements: RelType.IMPLEMENTS,
    uses_type: RelType.USES_TYPE,
    instantiates: RelType.INSTANTIATES,
  };
  return mapping[type] || RelType.CALLS;
}

async function collectStats(
  backend: SQLiteBackend,
  repoPath: string,
  files: { total: number; typescript: number; javascript: number; skipped: number },
  allRelationships: Array<{ type: string; confidence: number }>,
  resolvedCalls: number,
  unresolvedCalls: number,
  indexTimeMs: number,
  totalNodes: number
): Promise<RepoStats> {
  const db = (backend as any).getDb();

  const nodeRows = db.prepare(`
    SELECT label, is_exported, is_entry_point, is_dead
    FROM graph_nodes
  `).all() as Array<{ label: string; is_exported: number; is_entry_point: number; is_dead: number }>;

  const nodes = {
    total: nodeRows.length,
    byLabel: {} as Record<string, number>,
    exported: 0,
    entryPoints: 0,
    deadCode: 0,
  };

  for (const row of nodeRows) {
    nodes.byLabel[row.label] = (nodes.byLabel[row.label] || 0) + 1;
    if (row.is_exported) nodes.exported++;
    if (row.is_entry_point) nodes.entryPoints++;
    if (row.is_dead) nodes.deadCode++;
  }

  const edgeRows = db.prepare(`
    SELECT type, source, target
    FROM graph_relationships
  `).all() as Array<{ type: string; source: string; target: string }>;

  const edges = {
    total: edgeRows.length,
    byType: {} as Record<string, number>,
    callsStats: {
      total: resolvedCalls + unresolvedCalls,
      resolved: resolvedCalls,
      unresolved: unresolvedCalls,
      unresolvedPercent: 0,
    },
    confidenceDistribution: {} as Record<string, number>,
  };

  edges.callsStats.unresolvedPercent = edges.callsStats.total > 0
    ? (unresolvedCalls / edges.callsStats.total) * 100
    : 0;

  const callsInbound = new Map<string, number>();
  const callsOutbound = new Map<string, number>();
  const nodesWithInboundCalls = new Set<string>();
  const nodesWithOutboundCalls = new Set<string>();

  for (const row of edgeRows) {
    edges.byType[row.type] = (edges.byType[row.type] || 0) + 1;

    if (row.type === 'calls' || row.type === 'instantiates') {
      nodesWithOutboundCalls.add(row.source);
      if (!row.target.startsWith('unresolved:')) {
        nodesWithInboundCalls.add(row.target);
        callsInbound.set(row.target, (callsInbound.get(row.target) || 0) + 1);
      }
      callsOutbound.set(row.source, (callsOutbound.get(row.source) || 0) + 1);
    }
  }

  for (const rel of allRelationships) {
    const bucket = rel.confidence >= 1.0 ? '1.0' :
                   rel.confidence >= 0.8 ? '0.8-0.99' :
                   rel.confidence >= 0.5 ? '0.5-0.79' : '<0.5';
    edges.confidenceDistribution[bucket] = (edges.confidenceDistribution[bucket] || 0) + 1;
  }

  const avgInboundCalls = callsInbound.size > 0
    ? Array.from(callsInbound.values()).reduce((a, b) => a + b, 0) / callsInbound.size
    : 0;

  const avgOutboundCalls = callsOutbound.size > 0
    ? Array.from(callsOutbound.values()).reduce((a, b) => a + b, 0) / callsOutbound.size
    : 0;

  const coverage = {
    nodesWithInboundCalls: nodes.total > 0 ? (nodesWithInboundCalls.size / nodes.total) * 100 : 0,
    nodesWithOutboundCalls: nodes.total > 0 ? (nodesWithOutboundCalls.size / nodes.total) * 100 : 0,
    avgInboundCalls,
    avgOutboundCalls,
    callDensity: nodes.total > 0 ? ((edges.byType['calls'] || 0) + (edges.byType['instantiates'] || 0)) / nodes.total : 0,
    relationshipDensity: nodes.total > 0 ? edges.total / nodes.total : 0,
  };

  return {
    repoPath,
    indexedAt: new Date().toISOString(),
    files,
    nodes,
    edges,
    coverage,
    performance: {
      indexTimeMs,
      filesPerSecond: indexTimeMs > 0 ? (files.total / (indexTimeMs / 1000)) : 0,
      symbolsPerSecond: indexTimeMs > 0 ? (totalNodes / (indexTimeMs / 1000)) : 0,
    },
  };
}

function generateMarkdown(stats: RepoStats): string {
  return `# CodeGraph Index Run Report

**Date**: ${stats.indexedAt}
**Repository**: \`${stats.repoPath}\`

## Files Processed

| Metric | Count |
|--------|-------|
| Total Files | ${stats.files.total} |
| TypeScript | ${stats.files.typescript} |
| JavaScript | ${stats.files.javascript} |
| Skipped | ${stats.files.skipped} |

## Node Statistics

| Metric | Count |
|--------|-------|
| **Total Nodes** | **${stats.nodes.total}** |
| Exported | ${stats.nodes.exported} |
| Entry Points | ${stats.nodes.entryPoints} |
| Dead Code | ${stats.nodes.deadCode} |

### Nodes by Label

| Label | Count |
|-------|-------|
${Object.entries(stats.nodes.byLabel).sort((a, b) => b[1] - a[1]).map(([label, count]) => `| ${label} | ${count} |`).join('\n')}

## Edge Statistics

| Metric | Count |
|--------|-------|
| **Total Edges** | **${stats.edges.total}** |

### Edges by Type

| Type | Count |
|------|-------|
${Object.entries(stats.edges.byType).sort((a, b) => b[1] - a[1]).map(([type, count]) => `| ${type} | ${count} |`).join('\n')}

### CALLS Resolution

| Metric | Value |
|--------|-------|
| Total CALLS+INSTANTIATES | ${stats.edges.callsStats.total} |
| Resolved | ${stats.edges.callsStats.resolved} |
| Unresolved | ${stats.edges.callsStats.unresolved} |
| **Unresolved %** | **${stats.edges.callsStats.unresolvedPercent.toFixed(1)}%** |

### Confidence Distribution

| Range | Count |
|-------|-------|
${Object.entries(stats.edges.confidenceDistribution).sort((a, b) => b[0].localeCompare(a[0])).map(([bucket, count]) => `| ${bucket} | ${count} |`).join('\n')}

## Coverage Metrics

| Metric | Value |
|--------|-------|
| Nodes with inbound CALLS | ${stats.coverage.nodesWithInboundCalls.toFixed(1)}% |
| Nodes with outbound CALLS | ${stats.coverage.nodesWithOutboundCalls.toFixed(1)}% |
| Avg inbound calls | ${stats.coverage.avgInboundCalls.toFixed(2)} |
| Avg outbound calls | ${stats.coverage.avgOutboundCalls.toFixed(2)} |
| Call density | ${stats.coverage.callDensity.toFixed(2)} calls/node |
| Relationship density | ${stats.coverage.relationshipDensity.toFixed(2)} edges/node |

## Performance

| Metric | Value |
|--------|-------|
| Index time | ${(stats.performance.indexTimeMs / 1000).toFixed(1)}s |
| Files/sec | ${stats.performance.filesPerSecond.toFixed(1)} |
| Symbols/sec | ${stats.performance.symbolsPerSecond.toFixed(1)} |

## Summary

This index run processed **${stats.files.total} files** containing **${stats.nodes.total} symbols** with **${stats.edges.total} relationships**.

${stats.edges.callsStats.unresolvedPercent > 20 
  ? `⚠️ **Warning**: High unresolved calls (${stats.edges.callsStats.unresolvedPercent.toFixed(1)}%). Consider adding more cross-file resolution heuristics.`
  : `✅ **Good**: CALLS resolution rate is healthy (${(100 - stats.edges.callsStats.unresolvedPercent).toFixed(1)}%).`
}

${stats.coverage.relationshipDensity < 1.0
  ? `⚠️ **Warning**: Low relationship density (${stats.coverage.relationshipDensity.toFixed(2)}). Graph may be sparse.`
  : `✅ **Good**: Relationship density indicates a well-connected graph.`
}
`;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error('Usage: bun run scripts/index-real-repo.ts <repo-path> [output-doc-path]');
    process.exit(1);
  }

  const repoPath = path.resolve(args[0]);
  if (!fs.existsSync(repoPath)) {
    console.error(`Repository not found: ${repoPath}`);
    process.exit(1);
  }

  const date = new Date().toISOString().split('T')[0];
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const defaultOutput = path.join(scriptDir, '..', 'docs', `run-${date}.md`);
  const outputPath = args[1] || defaultOutput;

  const dbPath = path.join(path.dirname(outputPath), `index-${date}.db`);

  const stats = await indexRepo(repoPath, dbPath);

  const markdown = generateMarkdown(stats);
  
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, markdown);
  
  console.log(`\n=== Report written to ${outputPath} ===\n`);
  console.log(markdown);

  const statsPath = outputPath.replace('.md', '.json');
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
  console.log(`\nStats JSON: ${statsPath}`);
}

main().catch(console.error);
