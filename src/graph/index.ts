/**
 * Graph Module Index
 */

// Model types
export {
  NodeLabel,
  RelType,
  GraphNode,
  GraphRelationship,
  generateNodeId,
  generateRelationshipId,
  parseNodeId,
  EMBEDDABLE_LABELS,
  SYMBOL_LABELS,
  isCallable,
  isTypeDefinition,
} from './model.js';

export type {
  GraphNodeProperties,
  GraphRelationshipProperties,
  GraphNodeJSON,
  GraphRelationshipJSON,
} from './model.js';

// Knowledge graph
export { KnowledgeGraph } from './knowledge-graph.js';
export type { GraphStats } from './knowledge-graph.js';

// Storage backend interface
export type {
  StorageBackend,
  SearchResult,
  NodeEmbedding,
  NodeWithDepth,
  FileHashInfo,
  TraversalDirection,
} from './storage-backend.js';

// SQLite implementation
export { SQLiteBackend } from './sqlite-backend.js';

// Community detection
export { detectCommunities } from './community-detection.js';
export type { Community, CommunityDetectionResult } from './community-detection.js';

// Process detection
export { detectProcesses, findProcessForNode, getProcessSteps } from './process-detection.js';
export type { ProcessStep, DetectedProcess, ProcessDetectionResult } from './process-detection.js';

// Change coupling
export { detectChangeCoupling, getCoupledFiles, getChangePrediction } from './change-coupling.js';
export type { ChangeCoupling, ChangeCouplingResult, FileChangeHistory } from './change-coupling.js';
