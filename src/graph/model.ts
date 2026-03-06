/**
 * Graph Model Types - Migrated from Axon (Python/Kuzu) to TypeScript/SQLite
 * 
 * This module defines the core types for the knowledge graph:
 * - NodeLabel: Types of nodes in the graph
 * - RelType: Types of relationships between nodes
 * - GraphNode: A node in the graph (symbol, file, folder, etc.)
 * - GraphRelationship: A relationship between two nodes
 */

/** Node labels for the knowledge graph */
export enum NodeLabel {
  FILE = 'file',
  FOLDER = 'folder',
  FUNCTION = 'function',
  CLASS = 'class',
  METHOD = 'method',
  INTERFACE = 'interface',
  TYPE_ALIAS = 'type_alias',
  ENUM = 'enum',
  COMMUNITY = 'community',
  PROCESS = 'process',
}

/** Relationship types for the knowledge graph */
export enum RelType {
  /** File/folder contains another file/folder/symbol */
  CONTAINS = 'contains',
  /** File defines a symbol */
  DEFINES = 'defines',
  /** Function/method calls another function/method */
  CALLS = 'calls',
  /** File/module imports another module */
  IMPORTS = 'imports',
  /** Class extends another class */
  EXTENDS = 'extends',
  /** Class implements an interface */
  IMPLEMENTS = 'implements',
  /** Method is a member of a class */
  MEMBER_OF = 'member_of',
  /** Step in a process flow */
  STEP_IN_PROCESS = 'step_in_process',
  /** Function/method uses a type */
  USES_TYPE = 'uses_type',
  /** Code instantiates a class (new ClassName()) */
  INSTANTIATES = 'instantiates',
  /** File exports a symbol */
  EXPORTS = 'exports',
  /** Files/symbols are coupled (co-changed in git history) */
  COUPLED_WITH = 'coupled_with',
}

/** Properties for GraphNode */
export interface GraphNodeProperties {
  [key: string]: string | number | boolean | undefined;
}

/** A node in the knowledge graph */
export class GraphNode {
  /** Unique identifier: {label}:{file_path}:{symbol_name} */
  id: string;
  /** Type of node */
  label: NodeLabel;
  /** Name of the node (symbol name, file name, etc.) */
  name: string;
  /** Absolute file path */
  filePath: string;
  /** Starting line number (1-indexed) */
  startLine: number | null;
  /** Ending line number (1-indexed) */
  endLine: number | null;
  /** Source code content */
  content: string | null;
  /** Function/class signature */
  signature: string | null;
  /** Programming language */
  language: string | null;
  /** Parent class name (for methods) */
  className: string | null;
  /** Whether this symbol is dead code (not called) */
  isDead: boolean;
  /** Whether this is an entry point (main, exported, etc.) */
  isEntryPoint: boolean;
  /** Whether this symbol is exported */
  isExported: boolean;
  /** Additional properties */
  properties: GraphNodeProperties;

  constructor(data: {
    id?: string;
    label: NodeLabel;
    name: string;
    filePath: string;
    startLine?: number | null;
    endLine?: number | null;
    content?: string | null;
    signature?: string | null;
    language?: string | null;
    className?: string | null;
    isDead?: boolean;
    isEntryPoint?: boolean;
    isExported?: boolean;
    properties?: GraphNodeProperties;
  }) {
    this.label = data.label;
    this.name = data.name;
    this.filePath = data.filePath;
    this.startLine = data.startLine ?? null;
    this.endLine = data.endLine ?? null;
    this.content = data.content ?? null;
    this.signature = data.signature ?? null;
    this.language = data.language ?? null;
    this.className = data.className ?? null;
    this.isDead = data.isDead ?? false;
    this.isEntryPoint = data.isEntryPoint ?? false;
    this.isExported = data.isExported ?? false;
    this.properties = data.properties ?? {};
    
    // Generate ID if not provided
    this.id = data.id ?? generateNodeId(data.label, data.filePath, data.name);
  }

  /** Convert to plain object for serialization */
  toJSON(): GraphNodeJSON {
    return {
      id: this.id,
      label: this.label,
      name: this.name,
      filePath: this.filePath,
      startLine: this.startLine,
      endLine: this.endLine,
      content: this.content,
      signature: this.signature,
      language: this.language,
      className: this.className,
      isDead: this.isDead,
      isEntryPoint: this.isEntryPoint,
      isExported: this.isExported,
      properties: this.properties,
    };
  }

  /** Create from plain object */
  static fromJSON(json: GraphNodeJSON): GraphNode {
    return new GraphNode({
      id: json.id,
      label: json.label as NodeLabel,
      name: json.name,
      filePath: json.filePath,
      startLine: json.startLine,
      endLine: json.endLine,
      content: json.content,
      signature: json.signature,
      language: json.language,
      className: json.className,
      isDead: json.isDead,
      isEntryPoint: json.isEntryPoint,
      isExported: json.isExported,
      properties: json.properties,
    });
  }
}

/** JSON representation of GraphNode */
export interface GraphNodeJSON {
  id: string;
  label: string;
  name: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  content: string | null;
  signature: string | null;
  language: string | null;
  className: string | null;
  isDead: boolean;
  isEntryPoint: boolean;
  isExported: boolean;
  properties: GraphNodeProperties;
}

/** Properties for GraphRelationship */
export interface GraphRelationshipProperties {
  /** Confidence score for inferred relationships (0-1) */
  confidence?: number;
  /** Role in a relationship (e.g., parameter name) */
  role?: string;
  /** Step number in a process */
  stepNumber?: number;
  /** Coupling strength */
  strength?: number;
  /** Number of co-changes in git history */
  coChanges?: number;
  /** Symbols involved in coupling */
  symbols?: string[];
  /** Line number where relationship occurs */
  line?: number;
  [key: string]: string | number | boolean | string[] | undefined;
}

/** A relationship between two nodes in the knowledge graph */
export class GraphRelationship {
  /** Unique identifier */
  id: string;
  /** Type of relationship */
  type: RelType;
  /** Source node ID */
  source: string;
  /** Target node ID */
  target: string;
  /** Additional properties */
  properties: GraphRelationshipProperties;

  constructor(data: {
    id?: string;
    type: RelType;
    source: string;
    target: string;
    properties?: GraphRelationshipProperties;
  }) {
    this.type = data.type;
    this.source = data.source;
    this.target = data.target;
    this.properties = data.properties ?? {};
    
    // Generate ID if not provided
    this.id = data.id ?? generateRelationshipId(data.type, data.source, data.target);
  }

  /** Convert to plain object for serialization */
  toJSON(): GraphRelationshipJSON {
    return {
      id: this.id,
      type: this.type,
      source: this.source,
      target: this.target,
      properties: this.properties,
    };
  }

  /** Create from plain object */
  static fromJSON(json: GraphRelationshipJSON): GraphRelationship {
    return new GraphRelationship({
      id: json.id,
      type: json.type as RelType,
      source: json.source,
      target: json.target,
      properties: json.properties,
    });
  }
}

/** JSON representation of GraphRelationship */
export interface GraphRelationshipJSON {
  id: string;
  type: string;
  source: string;
  target: string;
  properties: GraphRelationshipProperties;
}

/**
 * Generate a unique node ID
 * Format: {label}:{file_path}:{symbol_name}
 */
export function generateNodeId(label: NodeLabel, filePath: string, name: string): string {
  return `${label}:${filePath}:${name}`;
}

/**
 * Generate a unique relationship ID
 * Format: {type}:{source}:{target}
 */
export function generateRelationshipId(type: RelType, source: string, target: string): string {
  return `${type}:${source}:${target}`;
}

/**
 * Parse a node ID into its components
 */
export function parseNodeId(id: string): { label: string; filePath: string; name: string } | null {
  const parts = id.split(':');
  if (parts.length < 3) return null;
  
  const label = parts[0] ?? '';
  const name = parts[parts.length - 1] ?? '';
  const filePath = parts.slice(1, -1).join(':');
  
  return { label, filePath, name };
}

/** Labels that can be embedded (have semantic meaning) */
export const EMBEDDABLE_LABELS: Set<NodeLabel> = new Set([
  NodeLabel.FILE,
  NodeLabel.FUNCTION,
  NodeLabel.CLASS,
  NodeLabel.METHOD,
  NodeLabel.INTERFACE,
  NodeLabel.TYPE_ALIAS,
  NodeLabel.ENUM,
]);

/** Labels that represent code symbols */
export const SYMBOL_LABELS: Set<NodeLabel> = new Set([
  NodeLabel.FUNCTION,
  NodeLabel.CLASS,
  NodeLabel.METHOD,
  NodeLabel.INTERFACE,
  NodeLabel.TYPE_ALIAS,
  NodeLabel.ENUM,
]);

/** Check if a label represents a callable symbol */
export function isCallable(label: NodeLabel): boolean {
  return label === NodeLabel.FUNCTION || label === NodeLabel.METHOD;
}

/** Check if a label represents a type definition */
export function isTypeDefinition(label: NodeLabel): boolean {
  return label === NodeLabel.CLASS || 
         label === NodeLabel.INTERFACE || 
         label === NodeLabel.TYPE_ALIAS ||
         label === NodeLabel.ENUM;
}
