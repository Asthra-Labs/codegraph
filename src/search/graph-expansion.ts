import type { Database } from '../db.js';
import type { RelType } from '../graph/model.js';
import type { UnifiedSearchResult } from '../search/unified-search.js';

export interface GraphExpansionOptions {
  enabled: boolean;
  maxHops: number;
  maxNeighborsPerNode: number;
  includeCallers: boolean;
  includeCallees: boolean;
  includeImports: boolean;
  includeExtends: boolean;
  includeImplements: boolean;
  includeSameFile: boolean;
  neighborBoost: number;
}

export const DEFAULT_EXPANSION_OPTIONS: GraphExpansionOptions = {
  enabled: true,
  maxHops: 1,
  maxNeighborsPerNode: 5,
  includeCallers: true,
  includeCallees: true,
  includeImports: true,
  includeExtends: true,
  includeImplements: true,
  includeSameFile: false,
  neighborBoost: 0.1,
};

export interface ExpandedNode {
  id: string;
  relationship: RelType | 'same_file';
  distance: number;
  sourceId: string;
}

export interface GraphBoostResult {
  nodeId: string;
  baseScore: number;
  boostScore: number;
  finalScore: number;
  reasons: string[];
}

export function expandGraphNeighbors(
  db: Database,
  nodeIds: string[],
  options: GraphExpansionOptions = DEFAULT_EXPANSION_OPTIONS
): ExpandedNode[] {
  if (!options.enabled || nodeIds.length === 0) {
    return [];
  }

  const expanded: ExpandedNode[] = [];
  const seen = new Set<string>(nodeIds);

  const relTypes: RelType[] = [];
  if (options.includeCallers) relTypes.push('CALLS' as RelType);
  if (options.includeCallees) relTypes.push('CALLS' as RelType);
  if (options.includeImports) relTypes.push('IMPORTS' as RelType);
  if (options.includeExtends) relTypes.push('EXTENDS' as RelType);
  if (options.includeImplements) relTypes.push('IMPLEMENTS' as RelType);

  for (const sourceId of nodeIds) {
    const neighbors = getOneHopNeighbors(db, sourceId, relTypes, options.maxNeighborsPerNode);
    
    for (const neighbor of neighbors) {
      if (!seen.has(neighbor.id)) {
        seen.add(neighbor.id);
        expanded.push({
          id: neighbor.id,
          relationship: neighbor.relationship,
          distance: 1,
          sourceId,
        });
      }
    }

    if (options.includeSameFile) {
      const sameFileNodes = getSameFileNodes(db, sourceId, options.maxNeighborsPerNode);
      for (const node of sameFileNodes) {
        if (!seen.has(node.id)) {
          seen.add(node.id);
          expanded.push({
            id: node.id,
            relationship: 'same_file',
            distance: 1,
            sourceId,
          });
        }
      }
    }
  }

  return expanded;
}

interface NeighborResult {
  id: string;
  relationship: RelType;
}

function getOneHopNeighbors(
  db: Database,
  nodeId: string,
  relTypes: RelType[],
  limit: number
): NeighborResult[] {
  if (relTypes.length === 0) return [];

  const typePlaceholders = relTypes.map(() => '?').join(',');
  
  const outgoing = db.prepare(`
    SELECT target as id, type as relationship
    FROM graph_relationships
    WHERE source = ? AND type IN (${typePlaceholders})
    LIMIT ?
  `).all(nodeId, ...relTypes, limit) as NeighborResult[];

  const incoming = db.prepare(`
    SELECT source as id, type as relationship
    FROM graph_relationships
    WHERE target = ? AND type IN (${typePlaceholders})
    LIMIT ?
  `).all(nodeId, ...relTypes, limit) as NeighborResult[];

  return [...outgoing, ...incoming];
}

function getSameFileNodes(
  db: Database,
  nodeId: string,
  limit: number
): { id: string }[] {
  const node = db.prepare(`
    SELECT file_path FROM graph_nodes WHERE id = ?
  `).get(nodeId) as { file_path: string } | undefined;

  if (!node) return [];

  return db.prepare(`
    SELECT id FROM graph_nodes
    WHERE file_path = ? AND id != ?
    LIMIT ?
  `).all(node.file_path, nodeId, limit) as { id: string }[];
}

export function computeGraphBoosts(
  db: Database,
  results: UnifiedSearchResult[],
  options: GraphExpansionOptions = DEFAULT_EXPANSION_OPTIONS
): GraphBoostResult[] {
  if (!options.enabled || results.length === 0) {
    return results.map(r => ({
      nodeId: r.id,
      baseScore: r.score,
      boostScore: 0,
      finalScore: r.score,
      reasons: [],
    }));
  }

  const nodeIds = results.map(r => r.id);
  const scoreMap = new Map(results.map(r => [r.id, r.score]));
  const expanded = expandGraphNeighbors(db, nodeIds, options);
  const neighborCount = new Map<string, number>();
  const neighborSources = new Map<string, Set<string>>();

  for (const exp of expanded) {
    const sourceScore = scoreMap.get(exp.sourceId) || 0;
    if (sourceScore > 0.5) {
      const count = neighborCount.get(exp.id) || 0;
      neighborCount.set(exp.id, count + 1);

      const sources = neighborSources.get(exp.id) || new Set();
      sources.add(exp.sourceId);
      neighborSources.set(exp.id, sources);
    }
  }

  return results.map(result => {
    const count = neighborCount.get(result.id) || 0;
    const sources = neighborSources.get(result.id) || new Set();
    
    const boostScore = count * options.neighborBoost;
    const finalScore = Math.min(result.score + boostScore, 1.0);

    const reasons: string[] = [];
    if (count > 0) {
      reasons.push(`connected to ${count} high-relevance node(s)`);
    }
    if (sources.size > 0) {
      const sourceList = Array.from(sources).slice(0, 3).join(', ');
      reasons.push(`related via: ${sourceList}`);
    }

    return {
      nodeId: result.id,
      baseScore: result.score,
      boostScore,
      finalScore,
      reasons,
    };
  });
}

export function applyGraphExpansion(
  db: Database,
  results: UnifiedSearchResult[],
  options: GraphExpansionOptions = DEFAULT_EXPANSION_OPTIONS
): UnifiedSearchResult[] {
  if (!options.enabled || results.length === 0) {
    return results;
  }

  const boosts = computeGraphBoosts(db, results, options);
  const boostMap = new Map(boosts.map(b => [b.nodeId, b]));

  const boostedResults = results.map(result => {
    const boost = boostMap.get(result.id);
    if (!boost || boost.boostScore === 0) {
      return result;
    }

    return {
      ...result,
      score: boost.finalScore,
      metadata: {
        ...result.metadata,
        graphBoost: boost.boostScore,
        graphReasons: boost.reasons,
      },
    };
  });

  const nodeIds = results.slice(0, 10).map(r => r.id);
  const expanded = expandGraphNeighbors(db, nodeIds, options);
  const existingIds = new Set(results.map(r => r.id));
  
  const newResults: UnifiedSearchResult[] = [];
  for (const exp of expanded) {
    if (!existingIds.has(exp.id)) {
      const node = db.prepare(`
        SELECT * FROM graph_nodes WHERE id = ?
      `).get(exp.id) as Record<string, unknown> | undefined;

      if (node) {
        newResults.push({
          id: exp.id,
          type: 'symbol',
          source: 'graph',
          symbolName: node.name as string,
          symbolKind: node.label as string,
          filePath: node.file_path as string,
          startLine: node.start_line as number,
          endLine: node.end_line as number,
          content: node.content as string,
          signature: node.signature as string | undefined,
          score: 0.3,
          rrfScore: 0,
          metadata: {
            expandedFrom: exp.sourceId,
            relationship: exp.relationship,
            distance: exp.distance,
          },
        });
        existingIds.add(exp.id);
      }
    }
  }

  newResults.sort((a, b) => b.score - a.score);
  
  return [...boostedResults, ...newResults.slice(0, options.maxNeighborsPerNode)];
}

export function getCallers(
  db: Database,
  nodeId: string,
  limit: number = 10
): { id: string; name: string; filePath: string }[] {
  return db.prepare(`
    SELECT n.id, n.name, n.file_path
    FROM graph_relationships r
    JOIN graph_nodes n ON r.source = n.id
    WHERE r.target = ? AND r.type = 'CALLS'
    LIMIT ?
  `).all(nodeId, limit) as { id: string; name: string; filePath: string }[];
}

export function getCallees(
  db: Database,
  nodeId: string,
  limit: number = 10
): { id: string; name: string; filePath: string }[] {
  return db.prepare(`
    SELECT n.id, n.name, n.file_path
    FROM graph_relationships r
    JOIN graph_nodes n ON r.target = n.id
    WHERE r.source = ? AND r.type = 'CALLS'
    LIMIT ?
  `).all(nodeId, limit) as { id: string; name: string; filePath: string }[];
}

export function getImportedNodes(
  db: Database,
  nodeId: string,
  limit: number = 10
): { id: string; name: string; filePath: string }[] {
  return db.prepare(`
    SELECT n.id, n.name, n.file_path
    FROM graph_relationships r
    JOIN graph_nodes n ON r.target = n.id
    WHERE r.source = ? AND r.type = 'IMPORTS'
    LIMIT ?
  `).all(nodeId, limit) as { id: string; name: string; filePath: string }[];
}

export function getInheritanceChain(
  db: Database,
  nodeId: string,
  limit: number = 10
): { id: string; name: string; filePath: string; relationship: string }[] {
  const extendsResults = db.prepare(`
    SELECT n.id, n.name, n.file_path, 'extends' as relationship
    FROM graph_relationships r
    JOIN graph_nodes n ON r.target = n.id
    WHERE r.source = ? AND r.type = 'EXTENDS'
    LIMIT ?
  `).all(nodeId, limit) as { id: string; name: string; filePath: string; relationship: string }[];

  const implementsResults = db.prepare(`
    SELECT n.id, n.name, n.file_path, 'implements' as relationship
    FROM graph_relationships r
    JOIN graph_nodes n ON r.target = n.id
    WHERE r.source = ? AND r.type = 'IMPLEMENTS'
    LIMIT ?
  `).all(nodeId, limit) as { id: string; name: string; filePath: string; relationship: string }[];

  return [...extendsResults, ...implementsResults];
}
