import { KnowledgeGraph } from './knowledge-graph.js';
import { GraphNode, NodeLabel } from './model.js';
import { GraphRelationship, RelType } from './model.js';

export interface Community {
  id: string;
  name: string;
  memberIds: string[];
  cohesion: number;
  hubNodeId?: string;
}

export interface CommunityDetectionResult {
  communities: Community[];
  nodeToCommunity: Map<string, string>;
  modularity: number;
}

export function detectCommunities(
  graph: KnowledgeGraph,
  options: {
    minCommunitySize?: number;
    maxIterations?: number;
    resolution?: number;
  } = {}
): CommunityDetectionResult {
  const { minCommunitySize = 2, maxIterations = 100, resolution = 1.0 } = options;

  const adjacency = buildAdjacencyMap(graph);
  const nodes = Array.from(graph.iterNodes()).filter(n => 
    n.label === NodeLabel.FUNCTION || 
    n.label === NodeLabel.METHOD || 
    n.label === NodeLabel.CLASS
  );

  if (nodes.length === 0) {
    return { communities: [], nodeToCommunity: new Map(), modularity: 0 };
  }

  const nodeIds = nodes.map(n => n.id);
  const nodeToCommunity = new Map<string, string>();
  const communityMembers = new Map<string, Set<string>>();

  for (const node of nodes) {
    const commId = `comm_${node.id}`;
    nodeToCommunity.set(node.id, commId);
    communityMembers.set(commId, new Set([node.id]));
  }

  const totalWeight = computeTotalWeight(adjacency);
  let currentModularity = computeModularity(
    nodeIds,
    nodeToCommunity,
    adjacency,
    totalWeight,
    resolution
  );

  let improved = true;
  let iteration = 0;

  while (improved && iteration < maxIterations) {
    improved = false;
    iteration++;

    for (const nodeId of nodeIds) {
      const currentComm = nodeToCommunity.get(nodeId)!;
      const neighbors = adjacency.get(nodeId) || new Map();
      
      const neighborCommunities = new Map<string, number>();
      for (const [neighborId, weight] of neighbors) {
        const neighborComm = nodeToCommunity.get(neighborId);
        if (neighborComm && neighborComm !== currentComm) {
          neighborCommunities.set(
            neighborComm,
            (neighborCommunities.get(neighborComm) || 0) + weight
          );
        }
      }

      let bestComm = currentComm;
      let bestDelta = 0;

      for (const [commId, edgeWeight] of neighborCommunities) {
        const delta = computeModularityDelta(
          nodeId,
          currentComm,
          commId,
          nodeToCommunity,
          adjacency,
          totalWeight,
          resolution
        );

        if (delta > bestDelta) {
          bestDelta = delta;
          bestComm = commId;
        }
      }

      if (bestComm !== currentComm) {
        const members = communityMembers.get(currentComm)!;
        members.delete(nodeId);
        if (members.size === 0) {
          communityMembers.delete(currentComm);
        }

        const newMembers = communityMembers.get(bestComm) || new Set();
        newMembers.add(nodeId);
        communityMembers.set(bestComm, newMembers);

        nodeToCommunity.set(nodeId, bestComm);
        currentModularity += bestDelta;
        improved = true;
      }
    }
  }

  const communities: Community[] = [];
  let commIndex = 0;

  for (const [commId, memberIds] of communityMembers) {
    if (memberIds.size >= minCommunitySize) {
      const memberArray = Array.from(memberIds);
      const cohesion = computeCohesion(memberArray, adjacency);
      const hubNodeId = findHubNode(memberArray, adjacency);

      const memberNodes = memberArray
        .map(id => graph.getNode(id))
        .filter(Boolean) as GraphNode[];

      const commonPrefix = findCommonPrefix(memberNodes);

      communities.push({
        id: commId,
        name: commonPrefix || `community_${commIndex++}`,
        memberIds: memberArray,
        cohesion,
        hubNodeId,
      });
    }
  }

  return {
    communities,
    nodeToCommunity,
    modularity: currentModularity,
  };
}

function buildAdjacencyMap(graph: KnowledgeGraph): Map<string, Map<string, number>> {
  const adjacency = new Map<string, Map<string, number>>();

  const edgeTypes = new Set([
    RelType.CALLS,
    RelType.IMPORTS,
    RelType.EXTENDS,
    RelType.IMPLEMENTS,
    RelType.MEMBER_OF,
  ]);

  for (const rel of graph.iterRelationships()) {
    if (!edgeTypes.has(rel.type)) continue;

    const weight = getEdgeWeight(rel);

    if (!adjacency.has(rel.source)) {
      adjacency.set(rel.source, new Map());
    }
    if (!adjacency.has(rel.target)) {
      adjacency.set(rel.target, new Map());
    }

    const sourceNeighbors = adjacency.get(rel.source)!;
    sourceNeighbors.set(rel.target, (sourceNeighbors.get(rel.target) || 0) + weight);

    const targetNeighbors = adjacency.get(rel.target)!;
    targetNeighbors.set(rel.source, (targetNeighbors.get(rel.source) || 0) + weight);
  }

  return adjacency;
}

function getEdgeWeight(rel: GraphRelationship): number {
  switch (rel.type) {
    case RelType.CALLS:
      return 1.0;
    case RelType.EXTENDS:
    case RelType.IMPLEMENTS:
      return 2.0;
    case RelType.MEMBER_OF:
      return 1.5;
    case RelType.IMPORTS:
      return 0.5;
    default:
      return 1.0;
  }
}

function computeTotalWeight(adjacency: Map<string, Map<string, number>>): number {
  let total = 0;
  for (const [, neighbors] of adjacency) {
    for (const [, weight] of neighbors) {
      total += weight;
    }
  }
  return total / 2;
}

function computeModularity(
  nodeIds: string[],
  nodeToCommunity: Map<string, string>,
  adjacency: Map<string, Map<string, number>>,
  totalWeight: number,
  resolution: number
): number {
  if (totalWeight === 0) return 0;

  let modularity = 0;

  for (let i = 0; i < nodeIds.length; i++) {
    for (let j = i + 1; j < nodeIds.length; j++) {
      const nodeId1 = nodeIds[i];
      const nodeId2 = nodeIds[j];

      if (nodeToCommunity.get(nodeId1) === nodeToCommunity.get(nodeId2)) {
        const neighbors1 = adjacency.get(nodeId1);
        const aij = neighbors1?.get(nodeId2) || 0;

        const ki = Array.from(neighbors1?.values() || []).reduce((a, b) => a + b, 0);
        const kj = Array.from(adjacency.get(nodeId2)?.values() || []).reduce((a, b) => a + b, 0);

        modularity += aij - resolution * (ki * kj) / (2 * totalWeight);
      }
    }
  }

  return modularity / (2 * totalWeight);
}

function computeModularityDelta(
  nodeId: string,
  fromComm: string,
  toComm: string,
  nodeToCommunity: Map<string, string>,
  adjacency: Map<string, Map<string, number>>,
  totalWeight: number,
  resolution: number
): number {
  const neighbors = adjacency.get(nodeId) || new Map();
  const ki = Array.from(neighbors.values()).reduce((a, b) => a + b, 0);

  let sumIn = 0;
  let sumTot = 0;

  for (const [neighborId, weight] of neighbors) {
    if (nodeToCommunity.get(neighborId) === toComm) {
      sumIn += weight;
    }
    if (nodeToCommunity.get(neighborId) === fromComm) {
      sumTot += weight;
    }
  }

  const kIn = sumIn;
  const delta = kIn - resolution * (ki * sumTot) / (2 * totalWeight);

  return delta / totalWeight;
}

function computeCohesion(
  memberIds: string[],
  adjacency: Map<string, Map<string, number>>
): number {
  if (memberIds.length < 2) return 1.0;

  const memberSet = new Set(memberIds);
  let internalEdges = 0;
  let totalEdges = 0;

  for (const memberId of memberIds) {
    const neighbors = adjacency.get(memberId) || new Map();
    for (const [neighborId, weight] of neighbors) {
      totalEdges += weight;
      if (memberSet.has(neighborId)) {
        internalEdges += weight;
      }
    }
  }

  return totalEdges > 0 ? internalEdges / totalEdges : 0;
}

function findHubNode(
  memberIds: string[],
  adjacency: Map<string, Map<string, number>>
): string | undefined {
  if (memberIds.length === 0) return undefined;

  const memberSet = new Set(memberIds);
  let maxInternalDegree = -1;
  let hubNodeId: string | undefined;

  for (const memberId of memberIds) {
    const neighbors = adjacency.get(memberId) || new Map();
    let internalDegree = 0;

    for (const [neighborId, weight] of neighbors) {
      if (memberSet.has(neighborId)) {
        internalDegree += weight;
      }
    }

    if (internalDegree > maxInternalDegree) {
      maxInternalDegree = internalDegree;
      hubNodeId = memberId;
    }
  }

  return hubNodeId;
}

function findCommonPrefix(nodes: GraphNode[]): string {
  if (nodes.length === 0) return '';

  const paths = nodes.map(n => n.filePath || '').filter(p => p.length > 0);
  if (paths.length === 0) return '';

  paths.sort();

  const first = paths[0];
  const last = paths[paths.length - 1];

  let i = 0;
  while (i < first.length && first[i] === last[i]) {
    i++;
  }

  const commonPath = first.substring(0, i);
  const lastSlash = Math.max(commonPath.lastIndexOf('/'), commonPath.lastIndexOf('\\'));

  if (lastSlash > 0) {
    const dir = commonPath.substring(lastSlash + 1);
    if (dir.length > 2) {
      return dir;
    }
  }

  const names = nodes.map(n => n.name);
  const commonNamePrefix = findCommonStringPrefix(names);
  if (commonNamePrefix.length >= 3) {
    return commonNamePrefix + '*';
  }

  return '';
}

function findCommonStringPrefix(strings: string[]): string {
  if (strings.length === 0) return '';

  let prefix = strings[0];
  for (const str of strings.slice(1)) {
    while (!str.toLowerCase().startsWith(prefix.toLowerCase()) && prefix.length > 0) {
      prefix = prefix.substring(0, prefix.length - 1);
    }
  }

  return prefix;
}
