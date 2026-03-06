/**
 * KnowledgeGraph - In-memory graph with O(1) lookups and secondary indexes
 * 
 * Migrated from Axon (Python) to TypeScript.
 * Provides efficient graph operations with multiple access patterns.
 */

import {
  GraphNode,
  GraphRelationship,
  NodeLabel,
  RelType,
} from './model.js';

/** Index type for label-based lookups */
type LabelIndex = Map<NodeLabel, Map<string, GraphNode>>;

/** Index type for relationship type lookups */
type RelTypeIndex = Map<RelType, Map<string, GraphRelationship>>;

/** Index type for adjacency lists */
type AdjacencyIndex = Map<string, Map<string, GraphRelationship>>;

/** Graph statistics */
export interface GraphStats {
  nodeCount: number;
  relationshipCount: number;
  nodesByLabel: Record<string, number>;
  relationshipsByType: Record<string, number>;
}

/**
 * In-memory knowledge graph with efficient indexes for various access patterns.
 * 
 * Indexes:
 * - _nodes: Primary node store (id -> node)
 * - _relationships: Primary relationship store (id -> relationship)
 * - _byLabel: Secondary index (label -> (id -> node))
 * - _byRelType: Secondary index (relType -> (id -> relationship))
 * - _outgoing: Adjacency index (sourceId -> (relId -> relationship))
 * - _incoming: Adjacency index (targetId -> (relId -> relationship))
 */
export class KnowledgeGraph {
  /** Primary node store */
  private _nodes: Map<string, GraphNode> = new Map();
  
  /** Primary relationship store */
  private _relationships: Map<string, GraphRelationship> = new Map();
  
  /** Index: label -> (id -> node) */
  private _byLabel: LabelIndex = new Map();
  
  /** Index: relType -> (id -> relationship) */
  private _byRelType: RelTypeIndex = new Map();
  
  /** Index: sourceId -> (relId -> relationship) */
  private _outgoing: AdjacencyIndex = new Map();
  
  /** Index: targetId -> (relId -> relationship) */
  private _incoming: AdjacencyIndex = new Map();

  // ==================== Node Operations ====================

  /**
   * Add a node to the graph
   */
  addNode(node: GraphNode): void {
    // Skip if already exists
    if (this._nodes.has(node.id)) {
      return;
    }

    // Add to primary store
    this._nodes.set(node.id, node);

    // Update label index
    if (!this._byLabel.has(node.label)) {
      this._byLabel.set(node.label, new Map());
    }
    this._byLabel.get(node.label)!.set(node.id, node);
  }

  /**
   * Add multiple nodes to the graph
   */
  addNodes(nodes: GraphNode[]): void {
    for (const node of nodes) {
      this.addNode(node);
    }
  }

  /**
   * Get a node by ID
   */
  getNode(id: string): GraphNode | undefined {
    return this._nodes.get(id);
  }

  /**
   * Check if a node exists
   */
  hasNode(id: string): boolean {
    return this._nodes.has(id);
  }

  /**
   * Remove a node and all its relationships
   */
  removeNode(id: string): void {
    const node = this._nodes.get(id);
    if (!node) return;

    // Remove all relationships involving this node
    const relsToRemove: string[] = [];
    
    // Collect outgoing relationships
    const outgoing = this._outgoing.get(id);
    if (outgoing) {
      relsToRemove.push(...outgoing.keys());
    }
    
    // Collect incoming relationships
    const incoming = this._incoming.get(id);
    if (incoming) {
      relsToRemove.push(...Array.from(incoming.keys()));
    }

    // Remove relationships
    for (const relId of relsToRemove) {
      this.removeRelationship(relId);
    }

    // Remove from primary store
    this._nodes.delete(id);

    // Remove from label index
    const labelIndex = this._byLabel.get(node.label);
    if (labelIndex) {
      labelIndex.delete(id);
    }
  }

  /**
   * Remove all nodes belonging to a file
   */
  removeNodesByFile(filePath: string): number {
    const toRemove: string[] = [];
    
    for (const [id, node] of this._nodes) {
      if (node.filePath === filePath) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.removeNode(id);
    }

    return toRemove.length;
  }

  /**
   * Get all nodes with a specific label
   */
  getNodesByLabel(label: NodeLabel): GraphNode[] {
    const labelIndex = this._byLabel.get(label);
    if (!labelIndex) return [];
    return Array.from(labelIndex.values());
  }

  /**
   * Iterate over all nodes
   */
  iterNodes(): IterableIterator<GraphNode> {
    return this._nodes.values();
  }

  /**
   * Get all nodes as an array
   */
  getAllNodes(): GraphNode[] {
    return Array.from(this._nodes.values());
  }

  // ==================== Relationship Operations ====================

  /**
   * Add a relationship to the graph
   */
  addRelationship(rel: GraphRelationship): void {
    // Skip if already exists
    if (this._relationships.has(rel.id)) {
      return;
    }

    // Verify source and target exist (optional, can be disabled for performance)
    // if (!this._nodes.has(rel.source) || !this._nodes.has(rel.target)) {
    //   console.warn(`Relationship references non-existent node: ${rel.id}`);
    // }

    // Add to primary store
    this._relationships.set(rel.id, rel);

    // Update type index
    if (!this._byRelType.has(rel.type)) {
      this._byRelType.set(rel.type, new Map());
    }
    this._byRelType.get(rel.type)!.set(rel.id, rel);

    // Update outgoing index
    if (!this._outgoing.has(rel.source)) {
      this._outgoing.set(rel.source, new Map());
    }
    this._outgoing.get(rel.source)!.set(rel.id, rel);

    // Update incoming index
    if (!this._incoming.has(rel.target)) {
      this._incoming.set(rel.target, new Map());
    }
    this._incoming.get(rel.target)!.set(rel.id, rel);
  }

  /**
   * Add multiple relationships to the graph
   */
  addRelationships(rels: GraphRelationship[]): void {
    for (const rel of rels) {
      this.addRelationship(rel);
    }
  }

  /**
   * Get a relationship by ID
   */
  getRelationship(id: string): GraphRelationship | undefined {
    return this._relationships.get(id);
  }

  /**
   * Remove a relationship
   */
  removeRelationship(id: string): void {
    const rel = this._relationships.get(id);
    if (!rel) return;

    // Remove from primary store
    this._relationships.delete(id);

    // Remove from type index
    const typeIndex = this._byRelType.get(rel.type);
    if (typeIndex) {
      typeIndex.delete(id);
    }

    // Remove from outgoing index
    const outgoing = this._outgoing.get(rel.source);
    if (outgoing) {
      outgoing.delete(id);
    }

    // Remove from incoming index
    const incoming = this._incoming.get(rel.target);
    if (incoming) {
      incoming.delete(id);
    }
  }

  /**
   * Get all relationships of a specific type
   */
  getRelationshipsByType(type: RelType): GraphRelationship[] {
    const typeIndex = this._byRelType.get(type);
    if (!typeIndex) return [];
    return Array.from(typeIndex.values());
  }

  /**
   * Iterate over all relationships
   */
  iterRelationships(): IterableIterator<GraphRelationship> {
    return this._relationships.values();
  }

  /**
   * Get all relationships as an array
   */
  getAllRelationships(): GraphRelationship[] {
    return Array.from(this._relationships.values());
  }

  // ==================== Adjacency Queries ====================

  /**
   * Get outgoing relationships from a node
   * @param nodeId Source node ID
   * @param relType Optional relationship type filter
   */
  getOutgoing(nodeId: string, relType?: RelType): GraphRelationship[] {
    const outgoing = this._outgoing.get(nodeId);
    if (!outgoing) return [];
    
    const rels = Array.from(outgoing.values());
    if (relType) {
      return rels.filter(r => r.type === relType);
    }
    return rels;
  }

  /**
   * Get incoming relationships to a node
   * @param nodeId Target node ID
   * @param relType Optional relationship type filter
   */
  getIncoming(nodeId: string, relType?: RelType): GraphRelationship[] {
    const incoming = this._incoming.get(nodeId);
    if (!incoming) return [];
    
    const rels = Array.from(incoming.values());
    if (relType) {
      return rels.filter(r => r.type === relType);
    }
    return rels;
  }

  /**
   * Check if a node has any incoming relationships of a given type
   */
  hasIncoming(nodeId: string, relType?: RelType): boolean {
    const incoming = this._incoming.get(nodeId);
    if (!incoming) return false;
    
    if (relType) {
      for (const rel of incoming.values()) {
        if (rel.type === relType) return true;
      }
      return false;
    }
    return incoming.size > 0;
  }

  /**
   * Check if a node has any outgoing relationships of a given type
   */
  hasOutgoing(nodeId: string, relType?: RelType): boolean {
    const outgoing = this._outgoing.get(nodeId);
    if (!outgoing) return false;
    
    if (relType) {
      for (const rel of outgoing.values()) {
        if (rel.type === relType) return true;
      }
      return false;
    }
    return outgoing.size > 0;
  }

  // ==================== Call Graph Queries ====================

  /**
   * Get all nodes that call the given node (callers)
   */
  getCallers(nodeId: string): GraphNode[] {
    const incoming = this.getIncoming(nodeId, RelType.CALLS);
    const callers: GraphNode[] = [];
    
    for (const rel of incoming) {
      const caller = this.getNode(rel.source);
      if (caller) {
        callers.push(caller);
      }
    }
    
    return callers;
  }

  /**
   * Get all nodes called by the given node (callees)
   */
  getCallees(nodeId: string): GraphNode[] {
    const outgoing = this.getOutgoing(nodeId, RelType.CALLS);
    const callees: GraphNode[] = [];
    
    for (const rel of outgoing) {
      const callee = this.getNode(rel.target);
      if (callee) {
        callees.push(callee);
      }
    }
    
    return callees;
  }

  /**
   * Get callers with their call relationships (including confidence)
   */
  getCallersWithConfidence(nodeId: string): Array<{ caller: GraphNode; relationship: GraphRelationship }> {
    const incoming = this.getIncoming(nodeId, RelType.CALLS);
    const results: Array<{ caller: GraphNode; relationship: GraphRelationship }> = [];
    
    for (const rel of incoming) {
      const caller = this.getNode(rel.source);
      if (caller) {
        results.push({ caller, relationship: rel });
      }
    }
    
    return results;
  }

  /**
   * Get callees with their call relationships (including confidence)
   */
  getCalleesWithConfidence(nodeId: string): Array<{ callee: GraphNode; relationship: GraphRelationship }> {
    const outgoing = this.getOutgoing(nodeId, RelType.CALLS);
    const results: Array<{ callee: GraphNode; relationship: GraphRelationship }> = [];
    
    for (const rel of outgoing) {
      const callee = this.getNode(rel.target);
      if (callee) {
        results.push({ callee, relationship: rel });
      }
    }
    
    return results;
  }

  // ==================== Graph Traversal ====================

  /** Traversal direction */
  static readonly TRAVERSE_CALLERS = 'callers';
  static readonly TRAVERSE_CALLEES = 'callees';
  static readonly TRAVERSE_BOTH = 'both';

  /**
   * Traverse the call graph from a starting node
   * @param startId Starting node ID
   * @param depth Maximum depth (0 = unlimited)
   * @param direction 'callers', 'callees', or 'both'
   */
  traverse(
    startId: string,
    depth: number = 0,
    direction: 'callers' | 'callees' | 'both' = 'both'
  ): GraphNode[] {
    const visited = new Set<string>();
    const result: GraphNode[] = [];
    const queue: Array<{ id: string; currentDepth: number }> = [{ id: startId, currentDepth: 0 }];

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift()!;
      
      if (visited.has(id)) continue;
      visited.add(id);
      
      const node = this.getNode(id);
      if (node && id !== startId) {
        result.push(node);
      }

      // Stop if we've reached max depth
      if (depth > 0 && currentDepth >= depth) continue;

      // Add neighbors based on direction
      if (direction === 'callers' || direction === 'both') {
        const callers = this.getIncoming(id, RelType.CALLS);
        for (const rel of callers) {
          if (!visited.has(rel.source)) {
            queue.push({ id: rel.source, currentDepth: currentDepth + 1 });
          }
        }
      }

      if (direction === 'callees' || direction === 'both') {
        const callees = this.getOutgoing(id, RelType.CALLS);
        for (const rel of callees) {
          if (!visited.has(rel.target)) {
            queue.push({ id: rel.target, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    return result;
  }

  /**
   * Traverse with depth information
   * @returns Array of (node, hop_depth) pairs
   */
  traverseWithDepth(
    startId: string,
    depth: number = 0,
    direction: 'callers' | 'callees' | 'both' = 'both'
  ): Array<{ node: GraphNode; depth: number }> {
    const visited = new Set<string>();
    const result: Array<{ node: GraphNode; depth: number }> = [];
    const queue: Array<{ id: string; currentDepth: number }> = [{ id: startId, currentDepth: 0 }];

    while (queue.length > 0) {
      const { id, currentDepth } = queue.shift()!;
      
      if (visited.has(id)) continue;
      visited.add(id);
      
      const node = this.getNode(id);
      if (node && id !== startId) {
        result.push({ node, depth: currentDepth });
      }

      // Stop if we've reached max depth
      if (depth > 0 && currentDepth >= depth) continue;

      // Add neighbors based on direction
      if (direction === 'callers' || direction === 'both') {
        const callers = this.getIncoming(id, RelType.CALLS);
        for (const rel of callers) {
          if (!visited.has(rel.source)) {
            queue.push({ id: rel.source, currentDepth: currentDepth + 1 });
          }
        }
      }

      if (direction === 'callees' || direction === 'both') {
        const callees = this.getOutgoing(id, RelType.CALLS);
        for (const rel of callees) {
          if (!visited.has(rel.target)) {
            queue.push({ id: rel.target, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    return result;
  }

  // ==================== Heritage Queries ====================

  /**
   * Get the parent class (if this class extends another)
   */
  getParentClass(nodeId: string): GraphNode | undefined {
    const outgoing = this.getOutgoing(nodeId, RelType.EXTENDS);
    const firstRel = outgoing[0];
    if (firstRel) {
      return this.getNode(firstRel.target);
    }
    return undefined;
  }

  /**
   * Get all child classes (classes that extend this one)
   */
  getChildClasses(nodeId: string): GraphNode[] {
    const incoming = this.getIncoming(nodeId, RelType.EXTENDS);
    return incoming
      .map(rel => this.getNode(rel.source))
      .filter((n): n is GraphNode => n !== undefined);
  }

  /**
   * Get interfaces implemented by a class
   */
  getImplementedInterfaces(nodeId: string): GraphNode[] {
    const outgoing = this.getOutgoing(nodeId, RelType.IMPLEMENTS);
    return outgoing
      .map(rel => this.getNode(rel.target))
      .filter((n): n is GraphNode => n !== undefined);
  }

  // ==================== Utility ====================

  /**
   * Clear all nodes and relationships
   */
  clear(): void {
    this._nodes.clear();
    this._relationships.clear();
    this._byLabel.clear();
    this._byRelType.clear();
    this._outgoing.clear();
    this._incoming.clear();
  }

  /**
   * Get graph statistics
   */
  stats(): GraphStats {
    const nodesByLabel: Record<string, number> = {};
    const relationshipsByType: Record<string, number> = {};

    for (const [label, nodes] of this._byLabel) {
      nodesByLabel[label] = nodes.size;
    }

    for (const [type, rels] of this._byRelType) {
      relationshipsByType[type] = rels.size;
    }

    return {
      nodeCount: this._nodes.size,
      relationshipCount: this._relationships.size,
      nodesByLabel,
      relationshipsByType,
    };
  }

  /**
   * Export to JSON
   */
  toJSON(): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
    return {
      nodes: this.getAllNodes(),
      relationships: this.getAllRelationships(),
    };
  }

  /**
   * Import from JSON
   */
  static fromJSON(data: { nodes: GraphNode[]; relationships: GraphRelationship[] }): KnowledgeGraph {
    const graph = new KnowledgeGraph();
    graph.addNodes(data.nodes);
    graph.addRelationships(data.relationships);
    return graph;
  }
}
