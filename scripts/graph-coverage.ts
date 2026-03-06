#!/usr/bin/env bun
/**
 * Graph Coverage Metrics Script
 * 
 * Reports coverage metrics for the code graph:
 * - Node counts by type
 * - Edge counts by type
 * - % nodes with inbound/outbound relationships
 * - Coverage thresholds validation
 */

import { SQLiteBackend } from '../src/graph/sqlite-backend.js';
import { NodeLabel, RelType } from '../src/graph/model.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface NodeMetrics {
  totalCount: number;
  byLabel: Record<string, number>;
  exportedCount: number;
  entryPointCount: number;
  deadCodeCount: number;
}

interface EdgeMetrics {
  totalCount: number;
  byType: Record<string, number>;
  callsInbound: Map<string, number>;
  callsOutbound: Map<string, number>;
  nodesWithInboundCalls: Set<string>;
  nodesWithOutboundCalls: Set<string>;
}

interface CoverageReport {
  nodes: NodeMetrics;
  edges: EdgeMetrics;
  coverage: {
    nodesWithInboundCalls: number;
    nodesWithOutboundCalls: number;
    avgInboundCalls: number;
    avgOutboundCalls: number;
    callDensity: number;
    relationshipDensity: number;
  };
  callResolution: {
    totalCalls: number;
    highConfidenceCalls: number;
    lowConfidenceCalls: number;
    unresolvedEstimatePercent: number;
  };
  thresholds: {
    totalNodes: { actual: number; min: number; passed: boolean };
    totalEdges: { actual: number; min: number; passed: boolean };
    callsEdges: { actual: number; min: number; passed: boolean };
    nodesWithInboundCalls: { actual: number; min: number; passed: boolean };
    nodesWithOutboundCalls: { actual: number; min: number; passed: boolean };
  };
}

const DEFAULT_THRESHOLDS = {
  totalNodes: 10,
  totalEdges: 5,
  callsEdges: 3,
  nodesWithInboundCallsPercent: 10,
  nodesWithOutboundCallsPercent: 10,
};

async function analyzeCoverage(dbPath: string, thresholds = DEFAULT_THRESHOLDS): Promise<CoverageReport> {
  const backend = new SQLiteBackend();
  await backend.initialize(dbPath);
  const db = (backend as any).getDb();

  // Node metrics
  const nodeRows = db.prepare(`
    SELECT label, is_exported, is_entry_point, is_dead
    FROM graph_nodes
  `).all() as Array<{ label: string; is_exported: number; is_entry_point: number; is_dead: number }>;

  const nodeMetrics: NodeMetrics = {
    totalCount: nodeRows.length,
    byLabel: {},
    exportedCount: 0,
    entryPointCount: 0,
    deadCodeCount: 0,
  };

  for (const row of nodeRows) {
    nodeMetrics.byLabel[row.label] = (nodeMetrics.byLabel[row.label] || 0) + 1;
    if (row.is_exported) nodeMetrics.exportedCount++;
    if (row.is_entry_point) nodeMetrics.entryPointCount++;
    if (row.is_dead) nodeMetrics.deadCodeCount++;
  }

  // Edge metrics
  const edgeRows = db.prepare(`
    SELECT type, source, target, confidence
    FROM graph_relationships
  `).all() as Array<{ type: string; source: string; target: string; confidence?: number }>;

  const edgeMetrics: EdgeMetrics = {
    totalCount: edgeRows.length,
    byType: {},
    callsInbound: new Map(),
    callsOutbound: new Map(),
    nodesWithInboundCalls: new Set(),
    nodesWithOutboundCalls: new Set(),
  };

  for (const row of edgeRows) {
    edgeMetrics.byType[row.type] = (edgeMetrics.byType[row.type] || 0) + 1;

    if (row.type.toUpperCase() === 'CALLS') {
      edgeMetrics.nodesWithOutboundCalls.add(row.source);
      edgeMetrics.nodesWithInboundCalls.add(row.target);
      edgeMetrics.callsOutbound.set(row.source, (edgeMetrics.callsOutbound.get(row.source) || 0) + 1);
      edgeMetrics.callsInbound.set(row.target, (edgeMetrics.callsInbound.get(row.target) || 0) + 1);
    }
  }

  const totalCalls = edgeRows.filter(r => r.type.toUpperCase() === 'CALLS').length;
  const highConfidenceCalls = edgeRows.filter(r => r.type.toUpperCase() === 'CALLS' && (r.confidence ?? 1) >= 0.95).length;
  const lowConfidenceCalls = edgeRows.filter(r => r.type.toUpperCase() === 'CALLS' && (r.confidence ?? 1) < 0.95).length;
  const unresolvedEstimatePercent = totalCalls > 0 ? (lowConfidenceCalls / totalCalls) * 100 : 0;

  // Calculate coverage percentages
  const nodesWithInboundCallsPercent = nodeMetrics.totalCount > 0
    ? (edgeMetrics.nodesWithInboundCalls.size / nodeMetrics.totalCount) * 100
    : 0;

  const nodesWithOutboundCallsPercent = nodeMetrics.totalCount > 0
    ? (edgeMetrics.nodesWithOutboundCalls.size / nodeMetrics.totalCount) * 100
    : 0;

  const avgInboundCalls = edgeMetrics.callsInbound.size > 0
    ? Array.from(edgeMetrics.callsInbound.values()).reduce((a, b) => a + b, 0) / edgeMetrics.callsInbound.size
    : 0;

  const avgOutboundCalls = edgeMetrics.callsOutbound.size > 0
    ? Array.from(edgeMetrics.callsOutbound.values()).reduce((a, b) => a + b, 0) / edgeMetrics.callsOutbound.size
    : 0;

  const callDensity = nodeMetrics.totalCount > 0
    ? totalCalls / nodeMetrics.totalCount
    : 0;

  const relationshipDensity = nodeMetrics.totalCount > 0
    ? edgeMetrics.totalCount / nodeMetrics.totalCount
    : 0;

  const report: CoverageReport = {
    nodes: nodeMetrics,
    edges: edgeMetrics,
    coverage: {
      nodesWithInboundCalls: nodesWithInboundCallsPercent,
      nodesWithOutboundCalls: nodesWithOutboundCallsPercent,
      avgInboundCalls,
      avgOutboundCalls,
      callDensity,
      relationshipDensity,
    },
    callResolution: {
      totalCalls,
      highConfidenceCalls,
      lowConfidenceCalls,
      unresolvedEstimatePercent,
    },
    thresholds: {
      totalNodes: { actual: nodeMetrics.totalCount, min: thresholds.totalNodes, passed: nodeMetrics.totalCount >= thresholds.totalNodes },
      totalEdges: { actual: edgeMetrics.totalCount, min: thresholds.totalEdges, passed: edgeMetrics.totalCount >= thresholds.totalEdges },
      callsEdges: { actual: totalCalls, min: thresholds.callsEdges, passed: totalCalls >= thresholds.callsEdges },
      nodesWithInboundCalls: { actual: nodesWithInboundCallsPercent, min: thresholds.nodesWithInboundCallsPercent, passed: nodesWithInboundCallsPercent >= thresholds.nodesWithInboundCallsPercent },
      nodesWithOutboundCalls: { actual: nodesWithOutboundCallsPercent, min: thresholds.nodesWithOutboundCallsPercent, passed: nodesWithOutboundCallsPercent >= thresholds.nodesWithOutboundCallsPercent },
    },
  };

  await backend.close();
  return report;
}

function printReport(report: CoverageReport): void {
  console.log('\n========================================');
  console.log('Graph Coverage Metrics Report');
  console.log('========================================\n');

  // Node metrics
  console.log('--- Node Metrics ---');
  console.log(`Total nodes: ${report.nodes.totalCount}`);
  console.log(`Exported: ${report.nodes.exportedCount}`);
  console.log(`Entry points: ${report.nodes.entryPointCount}`);
  console.log(`Dead code: ${report.nodes.deadCodeCount}`);
  console.log('\nBy label:');
  for (const [label, count] of Object.entries(report.nodes.byLabel).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${label}: ${count}`);
  }

  // Edge metrics
  console.log('\n--- Edge Metrics ---');
  console.log(`Total edges: ${report.edges.totalCount}`);
  console.log('\nBy type:');
  for (const [type, count] of Object.entries(report.edges.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Coverage metrics
  console.log('\n--- Coverage Metrics ---');
  console.log(`Nodes with inbound calls: ${report.coverage.nodesWithInboundCalls.toFixed(1)}%`);
  console.log(`Nodes with outbound calls: ${report.coverage.nodesWithOutboundCalls.toFixed(1)}%`);
  console.log(`Avg inbound calls: ${report.coverage.avgInboundCalls.toFixed(2)}`);
  console.log(`Avg outbound calls: ${report.coverage.avgOutboundCalls.toFixed(2)}`);
  console.log(`Call density: ${report.coverage.callDensity.toFixed(2)} calls/node`);
  console.log(`Relationship density: ${report.coverage.relationshipDensity.toFixed(2)} edges/node`);
  console.log(`\n--- Call Resolution ---`);
  console.log(`Total CALLS edges: ${report.callResolution.totalCalls}`);
  console.log(`High confidence CALLS: ${report.callResolution.highConfidenceCalls}`);
  console.log(`Low confidence CALLS: ${report.callResolution.lowConfidenceCalls}`);
  console.log(`Estimated unresolved/ambiguous calls: ${report.callResolution.unresolvedEstimatePercent.toFixed(1)}%`);

  // Threshold validation
  console.log('\n--- Threshold Validation ---');
  const allPassed = Object.entries(report.thresholds).every(([name, t]) => {
    const status = t.passed ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${name}: ${t.actual} >= ${t.min} ${status}`);
    return t.passed;
  });

  console.log('\n========================================');
  console.log(allPassed ? 'All thresholds passed ✓' : 'Some thresholds failed ✗');
  console.log('========================================\n');
}

async function main() {
  const args = process.argv.slice(2);
  let dbPath: string;

  if (args.length > 0) {
    dbPath = args[0];
    if (!fs.existsSync(dbPath)) {
      console.error(`Database not found: ${dbPath}`);
      process.exit(1);
    }
  } else {
    // Create temporary test database
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-coverage-'));
    dbPath = path.join(tempDir, 'coverage.db');

    const backend = new SQLiteBackend();
    await backend.initialize(dbPath);
    const db = (backend as any).getDb();

    // Insert test data
    db.exec(`
      INSERT INTO graph_nodes (id, label, name, file_path, is_exported) VALUES
        ('func:main.ts:main', 'FUNCTION', 'main', 'main.ts', 1),
        ('func:main.ts:helper', 'FUNCTION', 'helper', 'main.ts', 0),
        ('func:utils.ts:process', 'FUNCTION', 'process', 'utils.ts', 1),
        ('class:models.ts:User', 'CLASS', 'User', 'models.ts', 1),
        ('func:api.ts:handleRequest', 'FUNCTION', 'handleRequest', 'api.ts', 1),
        ('func:api.ts:validate', 'FUNCTION', 'validate', 'api.ts', 0),
        ('class:services.ts:UserService', 'CLASS', 'UserService', 'services.ts', 1),
        ('func:services.ts:getUser', 'FUNCTION', 'getUser', 'services.ts', 0);
    `);

    db.exec(`
      INSERT INTO graph_relationships (id, type, source, target) VALUES
        ('rel:1', 'calls', 'func:main.ts:main', 'func:main.ts:helper'),
        ('rel:2', 'calls', 'func:main.ts:main', 'func:utils.ts:process'),
        ('rel:3', 'calls', 'func:api.ts:handleRequest', 'func:api.ts:validate'),
        ('rel:4', 'calls', 'func:api.ts:handleRequest', 'func:services.ts:getUser'),
        ('rel:5', 'calls', 'func:services.ts:getUser', 'class:models.ts:User'),
        ('rel:6', 'uses_type', 'class:services.ts:UserService', 'class:models.ts:User'),
        ('rel:7', 'imports', 'func:main.ts:main', 'func:utils.ts:process'),
        ('rel:8', 'instantiates', 'func:services.ts:getUser', 'class:services.ts:UserService');
    `);

    await backend.close();
  }

  const report = await analyzeCoverage(dbPath);
  printReport(report);

  // Exit with error code if thresholds not met
  const allPassed = Object.values(report.thresholds).every(t => t.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch(console.error);
