/**
 * Graph Embedder - Generate embeddings for graph nodes
 * 
 * Migrated from Axon's embedder.py
 * Uses QMD's llama-cpp infrastructure for embedding generation.
 */

import {
  GraphNode,
  NodeLabel,
  KnowledgeGraph,
  EMBEDDABLE_LABELS,
  RelType,
} from '../graph/index.js';
import type { NodeEmbedding } from '../graph/storage-backend.js';

/** Function type for generating embeddings */
export type EmbedFunction = (text: string) => Promise<number[]>;

/** Function type for batch embedding */
export type BatchEmbedFunction = (texts: string[]) => Promise<number[][]>;

/** Context about a node's relationships for embedding */
interface NodeRelationshipContext {
  calls: string[];
  calledBy: string[];
  usesTypes: string[];
  extends_: string[];
  implements_: string[];
  members: string[];
}

/** Get relationship context for a node from the graph */
function getRelationshipContext(graph: KnowledgeGraph, nodeId: string): NodeRelationshipContext {
  const context: NodeRelationshipContext = {
    calls: [],
    calledBy: [],
    usesTypes: [],
    extends_: [],
    implements_: [],
    members: [],
  };

  // Functions/methods this node calls
  const callsRels = graph.getOutgoing(nodeId, RelType.CALLS);
  for (const rel of callsRels) {
    const targetNode = graph.getNode(rel.target);
    if (targetNode) {
      const name = targetNode.className 
        ? `${targetNode.className}.${targetNode.name}`
        : targetNode.name;
      context.calls.push(name);
    }
  }

  // Functions/methods that call this node
  const calledByRels = graph.getIncoming(nodeId, RelType.CALLS);
  for (const rel of calledByRels) {
    const sourceNode = graph.getNode(rel.source);
    if (sourceNode) {
      const name = sourceNode.className 
        ? `${sourceNode.className}.${sourceNode.name}`
        : sourceNode.name;
      context.calledBy.push(name);
    }
  }

  // Types this node uses
  const usesTypeRels = graph.getOutgoing(nodeId, RelType.USES_TYPE);
  for (const rel of usesTypeRels) {
    const targetNode = graph.getNode(rel.target);
    if (targetNode) {
      context.usesTypes.push(targetNode.name);
    }
  }

  // Classes this node extends
  const extendsRels = graph.getOutgoing(nodeId, RelType.EXTENDS);
  for (const rel of extendsRels) {
    const targetNode = graph.getNode(rel.target);
    if (targetNode) {
      context.extends_.push(targetNode.name);
    }
  }

  // Interfaces this node implements
  const implementsRels = graph.getOutgoing(nodeId, RelType.IMPLEMENTS);
  for (const rel of implementsRels) {
    const targetNode = graph.getNode(rel.target);
    if (targetNode) {
      context.implements_.push(targetNode.name);
    }
  }

  // Members (methods) of this class
  const memberRels = graph.getIncoming(nodeId, RelType.MEMBER_OF);
  for (const rel of memberRels) {
    const sourceNode = graph.getNode(rel.source);
    if (sourceNode) {
      context.members.push(sourceNode.name);
    }
  }

  return context;
}

/**
 * Generate text description for a node (for embedding)
 * Includes graph context (calls, called_by, uses_types, etc.) for better semantic search
 */
export function generateNodeText(
  node: GraphNode, 
  graph: KnowledgeGraph,
  classMethods?: Map<string, GraphNode[]>
): string {
  const parts: string[] = [];

  // Get relationship context
  const relContext = getRelationshipContext(graph, node.id);

  switch (node.label) {
    case NodeLabel.FUNCTION:
      parts.push(`Function ${node.name}`);
      if (node.signature) {
        parts.push(`with signature ${node.signature}`);
      }
      if (node.content) {
        const lines = node.content.split('\n').slice(0, 5).join('\n');
        parts.push(`Implementation:\n${lines}`);
      }
      break;

    case NodeLabel.METHOD:
      parts.push(`Method ${node.className}.${node.name}`);
      if (node.signature) {
        parts.push(`with signature ${node.signature}`);
      }
      if (node.content) {
        const lines = node.content.split('\n').slice(0, 5).join('\n');
        parts.push(`Implementation:\n${lines}`);
      }
      break;

    case NodeLabel.CLASS:
      parts.push(`Class ${node.name}`);
      if (node.content) {
        const firstLine = node.content.split('\n')[0];
        parts.push(`Declaration: ${firstLine}`);
      }
      // List methods if available from pre-built index
      if (classMethods && node.filePath) {
        const methods = classMethods.get(`${node.filePath}:${node.name}`);
        if (methods && methods.length > 0) {
          parts.push(`Methods: ${methods.map(m => m.name).join(', ')}`);
        }
      }
      break;

    case NodeLabel.INTERFACE:
      parts.push(`Interface ${node.name}`);
      if (node.content) {
        const lines = node.content.split('\n').slice(0, 10).join('\n');
        parts.push(`Definition:\n${lines}`);
      }
      break;

    case NodeLabel.TYPE_ALIAS:
      parts.push(`Type ${node.name}`);
      if (node.content) {
        parts.push(`Definition: ${node.content.substring(0, 200)}`);
      }
      break;

    case NodeLabel.ENUM:
      parts.push(`Enum ${node.name}`);
      if (node.content) {
        parts.push(`Definition: ${node.content.substring(0, 200)}`);
      }
      break;

    case NodeLabel.FILE:
      parts.push(`File ${node.filePath}`);
      parts.push(`Language: ${node.language}`);
      break;

    default:
      parts.push(`${node.label} ${node.name}`);
      if (node.content) {
        parts.push(node.content.substring(0, 300));
      }
  }

  // Add relationship context (like Axon does)
  if (relContext.calls.length > 0) {
    parts.push(`calls: ${relContext.calls.slice(0, 10).join(', ')}`);
  }
  if (relContext.calledBy.length > 0) {
    parts.push(`called by: ${relContext.calledBy.slice(0, 10).join(', ')}`);
  }
  if (relContext.usesTypes.length > 0) {
    parts.push(`uses types: ${relContext.usesTypes.slice(0, 10).join(', ')}`);
  }
  if (relContext.extends_.length > 0) {
    parts.push(`extends: ${relContext.extends_.join(', ')}`);
  }
  if (relContext.implements_.length > 0) {
    parts.push(`implements: ${relContext.implements_.join(', ')}`);
  }
  if (relContext.members.length > 0 && node.label !== NodeLabel.CLASS) {
    parts.push(`members: ${relContext.members.slice(0, 10).join(', ')}`);
  }

  // Add file path context
  parts.push(`Location: ${node.filePath}`);
  if (node.startLine) {
    parts.push(`line ${node.startLine}`);
  }

  return parts.join('. ');
}

/**
 * Build index of class -> methods mapping
 */
function buildClassMethodIndex(graph: KnowledgeGraph): Map<string, GraphNode[]> {
  const index = new Map<string, GraphNode[]>();

  for (const node of graph.iterNodes()) {
    if (node.label === NodeLabel.METHOD && node.className) {
      const key = `${node.filePath}:${node.className}`;
      if (!index.has(key)) {
        index.set(key, []);
      }
      index.get(key)!.push(node);
    }
  }

  return index;
}

/**
 * Generate embeddings for a knowledge graph
 * 
 * @param graph - The knowledge graph to embed
 * @param embedFn - Function to generate single embedding
 * @param options - Embedding options
 */
export async function embedGraph(
  graph: KnowledgeGraph,
  embedFn: EmbedFunction,
  options: {
    batchSize?: number;
    onProgress?: (processed: number, total: number) => void;
  } = {}
): Promise<NodeEmbedding[]> {
  const { batchSize = 10, onProgress } = options;

  // Filter to embeddable nodes
  const nodesToEmbed: GraphNode[] = [];
  for (const node of graph.iterNodes()) {
    if (EMBEDDABLE_LABELS.has(node.label)) {
      nodesToEmbed.push(node);
    }
  }

  if (nodesToEmbed.length === 0) {
    return [];
  }

  // Build class-method index for context
  const classMethods = buildClassMethodIndex(graph);

  // Generate embeddings in batches
  const embeddings: NodeEmbedding[] = [];
  let processed = 0;

  for (let i = 0; i < nodesToEmbed.length; i += batchSize) {
    const batch = nodesToEmbed.slice(i, i + batchSize);
    
    // Generate text for each node
    const texts = batch.map(node => generateNodeText(node, graph, classMethods));

    // Generate embeddings
    for (let j = 0; j < batch.length; j++) {
      const node = batch[j];
      const text = texts[j];
      if (!text || !node) continue;
      
      try {
        const embedding = await embedFn(text);
        embeddings.push({
          nodeId: node.id,
          embedding,
        });
      } catch (error) {
        console.error(`Failed to embed node ${node.id}:`, error);
      }

      processed++;
      onProgress?.(processed, nodesToEmbed.length);
    }
  }

  return embeddings;
}

/**
 * Generate embeddings for a knowledge graph using batch embedding
 * 
 * More efficient when the embedding function supports batching.
 */
export async function embedGraphBatch(
  graph: KnowledgeGraph,
  embedBatchFn: BatchEmbedFunction,
  options: {
    batchSize?: number;
    onProgress?: (processed: number, total: number) => void;
  } = {}
): Promise<NodeEmbedding[]> {
  const { batchSize = 32, onProgress } = options;

  const nodesToEmbed: GraphNode[] = [];
  for (const node of graph.iterNodes()) {
    if (EMBEDDABLE_LABELS.has(node.label)) {
      nodesToEmbed.push(node);
    }
  }

  if (nodesToEmbed.length === 0) {
    return [];
  }

  const classMethods = buildClassMethodIndex(graph);

  const embeddings: NodeEmbedding[] = [];
  let processed = 0;

  for (let i = 0; i < nodesToEmbed.length; i += batchSize) {
    const batch = nodesToEmbed.slice(i, i + batchSize);
    
    const texts = batch.map(node => generateNodeText(node, graph, classMethods));

    try {
      const batchEmbeddings = await embedBatchFn(texts);
      
      for (let j = 0; j < batch.length; j++) {
        const embedding = batchEmbeddings[j];
        const node = batch[j];
        if (embedding && node) {
          embeddings.push({
            nodeId: node.id,
            embedding,
          });
        }
      }
    } catch (error) {
      console.error(`Failed to embed batch:`, error);
    }

    processed += batch.length;
    onProgress?.(processed, nodesToEmbed.length);
  }

  return embeddings;
}

/**
 * Generate embeddings for nodes belonging to specific files
 * Used for incremental re-indexing
 */
export async function embedNodesForFiles(
  graph: KnowledgeGraph,
  embedFn: EmbedFunction,
  filePaths: string[],
  options: {
    batchSize?: number;
    onProgress?: (processed: number, total: number) => void;
  } = {}
): Promise<NodeEmbedding[]> {
  const { batchSize = 10, onProgress } = options;
  const filePathSet = new Set(filePaths);

  const nodesToEmbed: GraphNode[] = [];
  for (const node of graph.iterNodes()) {
    if (EMBEDDABLE_LABELS.has(node.label) && node.filePath && filePathSet.has(node.filePath)) {
      nodesToEmbed.push(node);
    }
  }

  if (nodesToEmbed.length === 0) {
    return [];
  }

  const classMethods = buildClassMethodIndex(graph);

  const embeddings: NodeEmbedding[] = [];
  let processed = 0;

  for (let i = 0; i < nodesToEmbed.length; i += batchSize) {
    const batch = nodesToEmbed.slice(i, i + batchSize);
    
    const texts = batch.map(node => generateNodeText(node, graph, classMethods));

    for (let j = 0; j < batch.length; j++) {
      const node = batch[j];
      const text = texts[j];
      if (!text || !node) continue;
      
      try {
        const embedding = await embedFn(text);
        embeddings.push({
          nodeId: node.id,
          embedding,
        });
      } catch (error) {
        console.error(`Failed to embed node ${node.id}:`, error);
      }

      processed++;
      onProgress?.(processed, nodesToEmbed.length);
    }
  }

  return embeddings;
}
