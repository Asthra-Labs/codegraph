import { KnowledgeGraph } from './knowledge-graph.js';
import { GraphNode, NodeLabel } from './model.js';
import { GraphRelationship, RelType } from './model.js';

export interface ProcessStep {
  nodeId: string;
  nodeName: string;
  order: number;
  filePath?: string;
  isEntryPoint: boolean;
  isExitPoint: boolean;
}

export interface DetectedProcess {
  id: string;
  name: string;
  description: string;
  steps: ProcessStep[];
  entryPoints: string[];
  exitPoints: string[];
  filePaths: string[];
}

export interface ProcessDetectionResult {
  processes: DetectedProcess[];
}

export function detectProcesses(
  graph: KnowledgeGraph,
  options: {
    minSteps?: number;
    maxSteps?: number;
    maxDepth?: number;
  } = {}
): ProcessDetectionResult {
  const { minSteps = 3, maxSteps = 20, maxDepth = 10 } = options;

  const entryPoints = findEntryPoints(graph);
  const visited = new Set<string>();
  const processes: DetectedProcess[] = [];

  for (const entryPoint of entryPoints) {
    if (visited.has(entryPoint.id)) continue;

    const callChain = traceCallChain(graph, entryPoint.id, maxDepth, visited);
    
    if (callChain.length >= minSteps && callChain.length <= maxSteps) {
      const process = buildProcess(callChain, graph);
      processes.push(process);

      for (const step of callChain) {
        visited.add(step.nodeId);
      }
    }
  }

  return { processes: mergeOverlappingProcesses(processes) };
}

function findEntryPoints(graph: KnowledgeGraph): GraphNode[] {
  const entryPoints: GraphNode[] = [];
  const calledNodes = new Set<string>();

  for (const rel of graph.iterRelationships()) {
    if (rel.type === RelType.CALLS) {
      calledNodes.add(rel.target);
    }
  }

  for (const node of graph.iterNodes()) {
    if (
      (node.label === NodeLabel.FUNCTION || node.label === NodeLabel.METHOD) &&
      (node.isEntryPoint || node.isExported)
    ) {
      entryPoints.push(node);
      continue;
    }

    if (
      (node.label === NodeLabel.FUNCTION || node.label === NodeLabel.METHOD) &&
      !calledNodes.has(node.id)
    ) {
      entryPoints.push(node);
    }
  }

  return entryPoints;
}

interface CallChainStep {
  nodeId: string;
  depth: number;
  branches: CallChainStep[];
}

function traceCallChain(
  graph: KnowledgeGraph,
  startNodeId: string,
  maxDepth: number,
  globalVisited: Set<string>
): ProcessStep[] {
  const steps: ProcessStep[] = [];
  const localVisited = new Set<string>();

  const queue: Array<{ nodeId: string; depth: number }> = [
    { nodeId: startNodeId, depth: 0 },
  ];

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;

    if (localVisited.has(nodeId) || depth > maxDepth) continue;
    localVisited.add(nodeId);

    const node = graph.getNode(nodeId);
    if (!node) continue;

    steps.push({
      nodeId,
      nodeName: node.name,
      order: steps.length,
      filePath: node.filePath,
      isEntryPoint: depth === 0,
      isExitPoint: false,
    });

    const calls: string[] = [];
    for (const rel of graph.iterRelationships()) {
      if (rel.type === RelType.CALLS && rel.source === nodeId) {
        if (!localVisited.has(rel.target) && !globalVisited.has(rel.target)) {
          calls.push(rel.target);
        }
      }
    }

    calls.slice(0, 3).forEach(targetId => {
      queue.push({ nodeId: targetId, depth: depth + 1 });
    });
  }

  if (steps.length > 0) {
    steps[steps.length - 1].isExitPoint = true;
  }

  return steps;
}

function buildProcess(steps: ProcessStep[], graph: KnowledgeGraph): DetectedProcess {
  const entryPoints = steps.filter(s => s.isEntryPoint).map(s => s.nodeName);
  const exitPoints = steps.filter(s => s.isExitPoint).map(s => s.nodeName);
  const filePaths = [...new Set(steps.map(s => s.filePath).filter(Boolean))] as string[];

  const name = generateProcessName(steps);
  const description = generateProcessDescription(steps, entryPoints, exitPoints);

  return {
    id: `process_${steps[0]?.nodeId || Date.now()}`,
    name,
    description,
    steps,
    entryPoints,
    exitPoints,
    filePaths,
  };
}

function generateProcessName(steps: ProcessStep[]): string {
  if (steps.length === 0) return 'unnamed_process';

  const firstStep = steps[0];
  const lastStep = steps[steps.length - 1];

  if (firstStep && lastStep && firstStep.nodeName !== lastStep.nodeName) {
    return `${firstStep.nodeName}_to_${lastStep.nodeName}`;
  }

  return firstStep?.nodeName || 'unnamed_process';
}

function generateProcessDescription(
  steps: ProcessStep[],
  entryPoints: string[],
  exitPoints: string[]
): string {
  const stepCount = steps.length;
  const fileCount = new Set(steps.map(s => s.filePath)).size;

  let description = `${stepCount}-step process`;

  if (entryPoints.length > 0) {
    description += ` starting at ${entryPoints[0]}`;
  }

  if (exitPoints.length > 0) {
    description += ` ending at ${exitPoints[0]}`;
  }

  if (fileCount > 1) {
    description += ` spanning ${fileCount} files`;
  }

  return description;
}

function mergeOverlappingProcesses(processes: DetectedProcess[]): DetectedProcess[] {
  const merged: DetectedProcess[] = [];
  const used = new Set<string>();

  for (const process of processes) {
    if (used.has(process.id)) continue;

    const overlapping = processes.filter(
      p =>
        !used.has(p.id) &&
        p.steps.some(s => process.steps.some(ps => ps.nodeId === s.nodeId))
    );

    if (overlapping.length === 1) {
      merged.push(process);
      used.add(process.id);
    } else {
      const longest = overlapping.reduce((a, b) =>
        a.steps.length > b.steps.length ? a : b
      );

      merged.push(longest);
      overlapping.forEach(p => used.add(p.id));
    }
  }

  return merged;
}

export function findProcessForNode(
  processes: DetectedProcess[],
  nodeId: string
): DetectedProcess | undefined {
  return processes.find(p => p.steps.some(s => s.nodeId === nodeId));
}

export function getProcessSteps(process: DetectedProcess): ProcessStep[] {
  return [...process.steps].sort((a, b) => a.order - b.order);
}
