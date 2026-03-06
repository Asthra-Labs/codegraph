/**
 * Ingestion Pipeline - Orchestrates graph building from source code
 * 
 * Migrated from Axon's pipeline.py with phases:
 * 1. File walking - Discover source files
 * 2. Structure - Create File/Folder nodes
 * 3. Parsing - Parse symbols from files
 * 4. Imports - Resolve import relationships
 * 5. Calls - Build call graph
 * 6. Heritage - Class extends/implements
 * 7. Types - Type usage relationships
 * 8. Dead code - Flag unreachable symbols
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  GraphNode,
  GraphRelationship,
  NodeLabel,
  RelType,
  KnowledgeGraph,
  generateNodeId,
  generateRelationshipId,
  SYMBOL_LABELS,
  isCallable,
  detectCommunities,
  detectProcesses,
  detectChangeCoupling,
} from '../graph/index.js';
import type { StorageBackend } from '../graph/storage-backend.js';
import type { Community, DetectedProcess, ChangeCoupling } from '../graph/index.js';
import { getParserForFile, type ILanguageParser, type ParseResult } from '../parsers/index.js';

/** Progress callback for pipeline phases */
export type ProgressCallback = (phase: string, progress: number, message?: string) => void;

/** Result of running the pipeline */
export interface PipelineResult {
  /** Number of files processed */
  filesProcessed: number;
  /** Number of symbols extracted */
  symbolsExtracted: number;
  /** Number of relationships created */
  relationshipsCreated: number;
  /** Number of embeddings generated */
  embeddingsGenerated: number;
  /** Dead code symbols found */
  deadCodeCount: number;
  /** Processing duration in seconds */
  durationSeconds: number;
  /** Errors encountered */
  errors: Array<{ file: string; error: string }>;
}

/** Options for running the pipeline */
export interface PipelineOptions {
  storage?: StorageBackend;
  generateEmbeddings?: boolean;
  detectDeadCode?: boolean;
  detectCommunities?: boolean;
  detectProcesses?: boolean;
  detectChangeCoupling?: boolean;
  repoPath?: string;
  extensions?: string[];
  ignorePatterns?: string[];
  onProgress?: ProgressCallback;
  forceReindex?: boolean;
}

/** Default source file extensions */
const DEFAULT_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt', '.kts',
  '.swift',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.rb',
  '.php',
  '.scala', '.sc',
  '.lua',
  '.vue', '.svelte',
];

/** Directories to skip when walking */
const SKIP_DIRS = new Set([
  // Dependencies
  'node_modules', 'vendor', 'third_party',
  // Python
  'venv', '.venv', 'env', '.env', 'site-packages',
  '__pycache__', '.pytest_cache', '.mypy_cache', 'eggs', '.eggs',
  // Build outputs
  'dist', 'build', 'target', 'out', 'bin', '.next', '.nuxt', '.output',
  // Version control
  '.git', '.svn', '.hg',
  // IDEs
  '.idea', '.vscode', '.vs',
  // Test/coverage
  'coverage', '.nyc_output', '.coverage', 'htmlcov',
  // Temp/cache
  'temp', 'temp-build', 'tmp', '.cache', '.temp',
  // Misc
  '.husky', '.github', '.gitlab',
]);

/**
 * Ingestion Pipeline
 * 
 * Orchestrates the complete graph building process.
 */
export class IngestionPipeline {
  private graph: KnowledgeGraph;
  private storage: StorageBackend | null = null;
  private options: PipelineOptions;
  private repoPath: string = '';
  private errors: Array<{ file: string; error: string }> = [];
  private indexedFiles: Map<string, string> = new Map(); // filePath -> hash

  constructor(options: PipelineOptions = {}) {
    this.graph = new KnowledgeGraph();
    this.options = {
      generateEmbeddings: true,
      detectDeadCode: true,
      extensions: DEFAULT_EXTENSIONS,
      ...options,
    };
    this.storage = options.storage ?? null;
  }

  /**
   * Run the full ingestion pipeline
   */
  async run(repoPath: string): Promise<{ graph: KnowledgeGraph; result: PipelineResult }> {
    const startTime = Date.now();
    this.repoPath = path.resolve(repoPath);
    this.errors = [];

    // Initialize storage if provided and not already initialized
    if (this.storage) {
      const needsInit = !this.storage['db'];  // Check if already initialized
      if (needsInit) {
        const dbPath = path.join(this.repoPath, '.xyne', 'codegraph-index', 'index.db');
        await this.storage.initialize(dbPath);
      }

      // Load indexed files for incremental indexing
      if (!this.options.forceReindex) {
        const indexedFiles = await this.storage.getIndexedFiles();
        this.indexedFiles = new Map(
          Array.from(indexedFiles.entries()).map(([fp, info]) => [fp, info.hash])
        );
      }
    }

    // Phase 1: Discover files
    this.reportProgress('discovery', 0, 'Discovering source files...');
    const files = await this.discoverFiles(repoPath);
    this.reportProgress('discovery', 1, `Found ${files.length} files`);
    
    this.reportProgress('structure', 0, 'Building file structure...');
    await this.buildStructure(files);
    this.reportProgress('structure', 1, 'File structure complete');
    
    this.reportProgress('parsing', 0, 'Parsing symbols...');
    const parseResults = await this.parseFiles(files);
    this.reportProgress('parsing', 1, `Parsed ${parseResults.size} files`);
    
    this.reportProgress('imports', 0, 'Resolving imports...');
    this.buildImportGraph(parseResults);
    this.reportProgress('imports', 1, 'Imports resolved');
    
    this.reportProgress('calls', 0, 'Building call graph...');
    this.buildCallGraph(parseResults);
    this.reportProgress('calls', 1, 'Call graph complete');
    
    this.reportProgress('heritage', 0, 'Resolving class heritage...');
    this.buildHeritageGraph(parseResults);
    this.reportProgress('heritage', 1, 'Heritage resolved');
    
    this.reportProgress('types', 0, 'Resolving type usage...');
    this.buildTypeUsageGraph(parseResults);
    this.reportProgress('types', 1, 'Types resolved');
    
    if (this.options.detectDeadCode) {
      this.reportProgress('deadcode', 0, 'Detecting dead code...');
      this.detectDeadCode();
      this.reportProgress('deadcode', 1, 'Dead code detection complete');
    }
    
    if (this.options.detectCommunities) {
      this.reportProgress('communities', 0, 'Detecting communities...');
      this.detectCommunities();
      this.reportProgress('communities', 1, 'Community detection complete');
    }
    
    if (this.options.detectProcesses) {
      this.reportProgress('processes', 0, 'Detecting processes...');
      this.detectProcesses();
      this.reportProgress('processes', 1, 'Process detection complete');
    }
    
    if (this.options.detectChangeCoupling) {
      this.reportProgress('coupling', 0, 'Analyzing change coupling...');
      this.detectChangeCoupling();
      this.reportProgress('coupling', 1, 'Change coupling analysis complete');
    }
    
    if (this.storage) {
      this.reportProgress('persisting', 0, 'Persisting to storage...');
      await this.storage.bulkLoad(this.graph);
      this.reportProgress('persisting', 1, 'Persisted to storage');
    }

    // Phase 9: Persist to storage
    if (this.storage) {
      this.reportProgress('persisting', 0, 'Persisting to storage...');
      await this.storage.bulkLoad(this.graph);
      this.reportProgress('persisting', 1);
    }

    // Build result
    const stats = this.graph.stats();
    const endTime = Date.now();
    const result: PipelineResult = {
      filesProcessed: files.length,
      symbolsExtracted: stats.nodeCount - files.length, // Subtract file nodes
      relationshipsCreated: stats.relationshipCount,
      embeddingsGenerated: 0, // Will be filled by embedding phase
      deadCodeCount: stats.nodesByLabel['function'] ?? 0, // Approximation
      durationSeconds: (endTime - startTime) / 1000,
      errors: this.errors,
    };

    return { graph: this.graph, result };
  }

  // ==================== Phase Implementations ====================

  /**
   * Phase 1: Discover source files
   */
  private async discoverFiles(repoPath: string): Promise<string[]> {
    const files: string[] = [];
    // Normalize extensions to include leading dot for comparison with path.extname()
    const rawExtensions = this.options.extensions ?? DEFAULT_EXTENSIONS;
    const extensions = new Set(
      rawExtensions.map(ext => ext.startsWith('.') ? ext : `.${ext}`)
    );
    const ignorePatterns = this.options.ignorePatterns ?? [];
    
    const minimatch = await import('minimatch');
    const isIgnored = (filePath: string, isDir: boolean = false): boolean => {
      const relativePath = path.relative(repoPath, filePath);
      
      return ignorePatterns.some(pattern => {
        if (minimatch.minimatch(relativePath, pattern)) {
          return true;
        }
        
        if (isDir) {
          if (pattern.startsWith('**/') && pattern.endsWith('/**')) {
            const dirName = pattern.slice(3, -3);
            if (relativePath === dirName || relativePath.endsWith('/' + dirName)) {
              return true;
            }
          }
          
          if (pattern.startsWith('**/') && !pattern.includes('*') && !pattern.endsWith('/**')) {
            const dirPattern = pattern.slice(3);
            if (relativePath === dirPattern || relativePath.endsWith('/' + dirPattern)) {
              return true;
            }
          }
        }
        
        return false;
      });
    };

    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) {
            continue;
          }
          if (ignorePatterns.length > 0 && isIgnored(fullPath, true)) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.has(ext)) {
            if (ignorePatterns.length > 0 && isIgnored(fullPath, false)) {
              continue;
            }
            files.push(fullPath);
          }
        }
      }
    };

    walk(repoPath);
    
    console.log(`   Discovered ${files.length} files to process`);
    
    return files;
  }

  /**
   * Phase 2: Build file/folder structure
   */
  private async buildStructure(files: string[]): Promise<void> {
    const folders = new Set<string>();
    const repoPath = this.repoPath;

    // Collect all folders
    for (const file of files) {
      let dir = path.dirname(file);
      while (dir !== repoPath && dir.length > repoPath.length) {
        folders.add(dir);
        dir = path.dirname(dir);
      }
    }

    // Create folder nodes
    for (const folder of folders) {
      const name = path.basename(folder);
      const node = new GraphNode({
        label: NodeLabel.FOLDER,
        name,
        filePath: folder,
      });
      this.graph.addNode(node);

      // Create CONTAINS relationship from parent
      const parent = path.dirname(folder);
      if (parent !== repoPath && folders.has(parent)) {
        const parentId = generateNodeId(NodeLabel.FOLDER, parent, path.basename(parent));
        const rel = new GraphRelationship({
          type: RelType.CONTAINS,
          source: parentId,
          target: node.id,
        });
        this.graph.addRelationship(rel);
      }
    }

    // Create file nodes
    for (const file of files) {
      const name = path.basename(file);
      const ext = path.extname(file);
      const language = this.extensionToLanguage(ext);
      
      const node = new GraphNode({
        label: NodeLabel.FILE,
        name,
        filePath: file,
        language,
      });
      this.graph.addNode(node);

      // Create CONTAINS relationship from folder
      const folder = path.dirname(file);
      if (folders.has(folder)) {
        const folderId = generateNodeId(NodeLabel.FOLDER, folder, path.basename(folder));
        const rel = new GraphRelationship({
          type: RelType.CONTAINS,
          source: folderId,
          target: node.id,
        });
        this.graph.addRelationship(rel);
      }
    }
  }

  /**
   * Phase 3: Parse files and extract symbols
   */
  private async parseFiles(files: string[]): Promise<Map<string, ParseResult>> {
    const results = new Map<string, ParseResult>();
    let processed = 0;

    for (const file of files) {
      try {
        const parser = getParserForFile(file);
        if (!parser) {
          // Skip files without parsers
          continue;
        }

        const content = fs.readFileSync(file, 'utf-8');
        const parseResult = await parser.parse(content, file);
        results.set(file, parseResult);

        // Create symbol nodes
        for (const symbol of parseResult.symbols) {
          const node = new GraphNode({
            label: this.symbolKindToLabel(symbol.kind),
            name: symbol.name,
            filePath: file,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            content: symbol.content ?? null,
            signature: symbol.signature ?? null,
            language: parseResult.language,
            className: symbol.className ?? null,
            isExported: symbol.isExported ?? false,
          });
          this.graph.addNode(node);

          // Create DEFINES relationship from file
          const fileId = generateNodeId(NodeLabel.FILE, file, path.basename(file));
          const rel = new GraphRelationship({
            type: RelType.DEFINES,
            source: fileId,
            target: node.id,
          });
          this.graph.addRelationship(rel);

          // Create MEMBER_OF relationship for methods
          if (symbol.className && symbol.kind === 'method') {
            const classId = generateNodeId(NodeLabel.CLASS, file, symbol.className);
            const memberRel = new GraphRelationship({
              type: RelType.MEMBER_OF,
              source: node.id,
              target: classId,
            });
            this.graph.addRelationship(memberRel);
          }
        }

        processed++;
        if (processed % 50 === 0) {
          this.reportProgress('parsing', processed / files.length, `Parsed ${processed}/${files.length} files`);
        }
      } catch (error) {
        this.errors.push({
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * Phase 4: Build import graph
   */
  private buildImportGraph(parseResults: Map<string, ParseResult>): void {
    for (const [file, result] of parseResults) {
      const fileId = generateNodeId(NodeLabel.FILE, file, path.basename(file));

      for (const imp of result.imports) {
        // Try to resolve the import to a file
        const resolvedPath = this.resolveImport(file, imp.module, parseResults);
        
        if (resolvedPath) {
          const targetId = generateNodeId(NodeLabel.FILE, resolvedPath, path.basename(resolvedPath));
          const rel = new GraphRelationship({
            type: RelType.IMPORTS,
            source: fileId,
            target: targetId,
            properties: {
              role: imp.names?.join(', '),
            },
          });
          this.graph.addRelationship(rel);
        }
      }
    }
  }

  /**
   * Phase 5: Build call graph
   */
  private buildCallGraph(parseResults: Map<string, ParseResult>): void {
    for (const [file, result] of parseResults) {
      // Get all symbols in this file for local resolution
      const fileSymbols = new Map<string, GraphNode>();
      for (const symbol of result.symbols) {
        const id = generateNodeId(this.symbolKindToLabel(symbol.kind), file, symbol.name);
        const node = this.graph.getNode(id);
        if (node) {
          fileSymbols.set(symbol.name, node);
        }
      }

      // Process relationships from parser
      for (const rel of result.relationships) {
        if (rel.type === 'calls') {
          const sourceId = rel.sourceId;
          const targetName = rel.target;
          
          // Try to resolve the call target
          const target = this.resolveCall(file, targetName, fileSymbols);
          
          if (target) {
            const callRel = new GraphRelationship({
              type: RelType.CALLS,
              source: sourceId,
              target: target.id,
              properties: {
                confidence: target.confidence,
                line: rel.line,
              },
            });
            this.graph.addRelationship(callRel);
          }
        }
      }
    }
  }

  /**
   * Phase 6: Build heritage graph (extends/implements)
   */
  private buildHeritageGraph(parseResults: Map<string, ParseResult>): void {
    for (const [file, result] of parseResults) {
      for (const rel of result.relationships) {
        if (rel.type === 'extends' || rel.type === 'implements') {
          const sourceId = rel.sourceId;
          const targetName = rel.target;

          // Try to resolve the parent class/interface
          const targets = this.graph.getNodesByLabel(NodeLabel.CLASS);
          const ifaces = this.graph.getNodesByLabel(NodeLabel.INTERFACE);
          const allTypes = [...targets, ...ifaces];

          for (const typeNode of allTypes) {
            if (typeNode.name === targetName) {
              const heritageRel = new GraphRelationship({
                type: rel.type === 'extends' ? RelType.EXTENDS : RelType.IMPLEMENTS,
                source: sourceId,
                target: typeNode.id,
              });
              this.graph.addRelationship(heritageRel);
              break;
            }
          }
        }
      }
    }
  }

  /**
   * Phase 7: Build type usage graph
   */
  private buildTypeUsageGraph(parseResults: Map<string, ParseResult>): void {
    for (const [file, result] of parseResults) {
      for (const rel of result.relationships) {
        if (rel.type === 'uses_type') {
          const sourceId = rel.sourceId;
          const typeName = rel.target;

          // Try to resolve the type
          const classes = this.graph.getNodesByLabel(NodeLabel.CLASS);
          const interfaces = this.graph.getNodesByLabel(NodeLabel.INTERFACE);
          const typeAliases = this.graph.getNodesByLabel(NodeLabel.TYPE_ALIAS);
          const enums = this.graph.getNodesByLabel(NodeLabel.ENUM);
          const allTypes = [...classes, ...interfaces, ...typeAliases, ...enums];

          for (const typeNode of allTypes) {
            if (typeNode.name === typeName) {
              const typeRel = new GraphRelationship({
                type: RelType.USES_TYPE,
                source: sourceId,
                target: typeNode.id,
              });
              this.graph.addRelationship(typeRel);
              break;
            }
          }
        }
      }
    }
  }

  /**
   * Phase 8: Detect dead code
   */
  private detectDeadCode(): void {
    const entryPoints = new Set<string>();
    const frameworkDecorators = new Set([
      'task', 'router', 'fixture', 'receiver', 'signal', 'slot',
      'property', 'setter', 'getter', 'abstractmethod', 'overload',
      'staticmethod', 'classmethod', 'contextmanager', 'asynccontextmanager',
      'cached_property', 'functools.cached_property',
    ]);

    for (const node of this.graph.iterNodes()) {
      if (isCallable(node.label)) {
        if (node.isExported) {
          entryPoints.add(node.id);
        }
        if (node.name === 'main' || node.name === '__main__') {
          entryPoints.add(node.id);
        }
        if (this.isTestFunction(node)) {
          entryPoints.add(node.id);
        }
        if (this.hasFrameworkDecorator(node, frameworkDecorators)) {
          entryPoints.add(node.id);
        }
        if (this.isConstructor(node) || this.isDunderMethod(node)) {
          entryPoints.add(node.id);
        }
      }
      if (node.label === NodeLabel.CLASS) {
        if (this.isTestClass(node) || this.isEnumClass(node) || this.isProtocolClass(node)) {
          entryPoints.add(node.id);
        }
      }
    }

    const reachable = new Set<string>();
    for (const entryId of entryPoints) {
      const callGraph = this.graph.traverse(entryId, 0, 'callees');
      reachable.add(entryId);
      for (const node of callGraph) {
        reachable.add(node.id);
      }
    }

    const methodOverrides = this.buildMethodOverrideMap();

    for (const node of this.graph.iterNodes()) {
      if (isCallable(node.label) && !reachable.has(node.id)) {
        const isFalsePositive = 
          this.isOverrideOfCalledMethod(node, methodOverrides, reachable) ||
          this.isProtocolConformanceMethod(node);
        
        if (!isFalsePositive) {
          node.isDead = true;
          node.isEntryPoint = false;
        } else {
          node.isDead = false;
        }
      } else if (reachable.has(node.id)) {
        node.isEntryPoint = true;
        node.isDead = false;
      }
    }
  }

  private isTestFunction(node: GraphNode): boolean {
    if (node.name.startsWith('test_') || node.name.startsWith('it_') || node.name.startsWith('describe_')) {
      return true;
    }
    if (node.filePath.includes('/test/') || node.filePath.includes('/tests/') || node.filePath.includes('/__tests__/')) {
      return true;
    }
    if (node.filePath.endsWith('.test.ts') || node.filePath.endsWith('.test.js') || 
        node.filePath.endsWith('.spec.ts') || node.filePath.endsWith('.spec.js')) {
      return true;
    }
    return false;
  }

  private isTestClass(node: GraphNode): boolean {
    if (node.name.startsWith('Test') || node.name.endsWith('Test') || node.name.endsWith('Tests')) {
      return true;
    }
    if (node.filePath.includes('/test/') || node.filePath.includes('/tests/')) {
      return true;
    }
    return false;
  }

  private hasFrameworkDecorator(node: GraphNode, decorators: Set<string>): boolean {
    const content = node.content || '';
    const decoratorPattern = /@\s*([\w.]+)/g;
    let match;
    while ((match = decoratorPattern.exec(content)) !== null) {
      const decoratorName = match[1];
      if (decoratorName && decorators.has(decoratorName)) {
        return true;
      }
    }
    return false;
  }

  private isConstructor(node: GraphNode): boolean {
    return node.name === '__init__' || node.name === '__new__' || node.name === 'constructor';
  }

  private isDunderMethod(node: GraphNode): boolean {
    return node.name.startsWith('__') && node.name.endsWith('__');
  }

  private isEnumClass(node: GraphNode): boolean {
    const content = node.content || '';
    return content.includes('extends Enum') || 
           content.includes('extends enumeratum') ||
           content.includes('@enum') ||
           content.includes('enum ');
  }

  private isProtocolClass(node: GraphNode): boolean {
    const content = node.content || '';
    return content.includes('Protocol') || 
           content.includes('ABC') ||
           content.includes('abstractmethod') ||
           content.includes('@abstract');
  }

  private buildMethodOverrideMap(): Map<string, string[]> {
    const overrideMap = new Map<string, string[]>();
    
    for (const rel of this.graph.iterRelationships()) {
      if (rel.type === RelType.EXTENDS || rel.type === RelType.IMPLEMENTS) {
        const childClass = this.graph.getNode(rel.source);
        const parentClass = this.graph.getNode(rel.target);
        
        if (childClass && parentClass) {
          const childMethods = this.getClassMethods(childClass.id);
          for (const methodId of childMethods) {
            const overrides = overrideMap.get(methodId) || [];
            overrides.push(parentClass.id);
            overrideMap.set(methodId, overrides);
          }
        }
      }
    }
    
    return overrideMap;
  }

  private getClassMethods(classId: string): string[] {
    const methods: string[] = [];
    for (const rel of this.graph.iterRelationships()) {
      if (rel.type === RelType.MEMBER_OF && rel.target === classId) {
        const node = this.graph.getNode(rel.source);
        if (node && node.label === NodeLabel.METHOD) {
          methods.push(rel.source);
        }
      }
    }
    return methods;
  }

  private isOverrideOfCalledMethod(node: GraphNode, overrideMap: Map<string, string[]>, reachable: Set<string>): boolean {
    const parentClasses = overrideMap.get(node.id);
    if (!parentClasses) return false;
    
    for (const parentId of parentClasses) {
      for (const rel of this.graph.iterRelationships()) {
        if (rel.type === RelType.MEMBER_OF && rel.target === parentId) {
          if (reachable.has(rel.source)) {
            const parentMethod = this.graph.getNode(rel.source);
            if (parentMethod && parentMethod.name === node.name) {
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  private isProtocolConformanceMethod(node: GraphNode): boolean {
    if (node.label !== NodeLabel.METHOD) return false;
    
    for (const rel of this.graph.iterRelationships()) {
      if (rel.type === RelType.MEMBER_OF && rel.source === node.id) {
        const classNode = this.graph.getNode(rel.target);
        if (classNode && this.isProtocolClass(classNode)) {
          return true;
        }
      }
    }
    return false;
  }

  private detectCommunities(): void {
    const result = detectCommunities(this.graph, {
      minCommunitySize: 2,
      maxIterations: 100,
    });

    for (const community of result.communities) {
      const communityNode = new GraphNode({
        label: NodeLabel.COMMUNITY,
        name: community.name,
        properties: {
          memberCount: community.memberIds.length,
          cohesion: community.cohesion,
          hubNodeId: community.hubNodeId,
        },
      });
      this.graph.addNode(communityNode);

      for (const memberId of community.memberIds) {
        const memberRel = new GraphRelationship({
          type: RelType.MEMBER_OF,
          source: memberId,
          target: communityNode.id,
        });
        this.graph.addRelationship(memberRel);
      }
    }

    this.stats.relationshipsCreated += result.communities.reduce(
      (sum, c) => sum + c.memberIds.length,
      0
    );
  }

  private detectProcesses(): void {
    const result = detectProcesses(this.graph, {
      minSteps: 3,
      maxSteps: 20,
      maxDepth: 15,
    });

    for (const process of result.processes) {
      const processNode = new GraphNode({
        label: NodeLabel.PROCESS,
        name: process.name,
        properties: {
          description: process.description,
          stepCount: process.steps.length,
          entryPoints: process.entryPoints,
          exitPoints: process.exitPoints,
          filePaths: process.filePaths,
        },
      });
      this.graph.addNode(processNode);

      for (const step of process.steps) {
        const stepRel = new GraphRelationship({
          type: RelType.STEP_IN_PROCESS,
          source: processNode.id,
          target: step.nodeId,
          properties: {
            order: step.order,
            isEntry: step.isEntryPoint,
            isExit: step.isExitPoint,
          },
        });
        this.graph.addRelationship(stepRel);
      }
    }

    this.stats.relationshipsCreated += result.processes.reduce(
      (sum, p) => sum + p.steps.length,
      0
    );
  }

  private detectChangeCoupling(): void {
    if (!this.options.repoPath) return;

    const result = detectChangeCoupling(this.options.repoPath, {
      maxCommits: 500,
      minCoChangeCount: 2,
      since: '6 months ago',
    });

    const topCouplings = result.couplings.slice(0, 100);

    for (const coupling of topCouplings) {
      const coupleRel = new GraphRelationship({
        type: RelType.COUPLED_WITH,
        source: coupling.fileA,
        target: coupling.fileB,
        properties: {
          strength: coupling.strength,
          coChangeCount: coupling.coChangeCount,
        },
      });
      this.graph.addRelationship(coupleRel);
    }

    this.stats.relationshipsCreated += topCouplings.length;
  }

  // ==================== Helpers ====================

  private reportProgress(phase: string, progress: number, message?: string): void {
    this.options.onProgress?.(phase, progress, message);
  }

  private extensionToLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java',
      '.kt': 'kotlin',
      '.kts': 'kotlin',
      '.swift': 'swift',
      '.c': 'c',
      '.cpp': 'cpp',
      '.cc': 'cpp',
      '.cxx': 'cpp',
      '.h': 'c',
      '.hpp': 'cpp',
      '.rb': 'ruby',
      '.php': 'php',
      '.scala': 'scala',
      '.sc': 'scala',
      '.lua': 'lua',
      '.vue': 'vue',
      '.svelte': 'svelte',
    };
    return map[ext.toLowerCase()] ?? 'unknown';
  }

  private symbolKindToLabel(kind: string): NodeLabel {
    const map: Record<string, NodeLabel> = {
      'function': NodeLabel.FUNCTION,
      'method': NodeLabel.METHOD,
      'class': NodeLabel.CLASS,
      'interface': NodeLabel.INTERFACE,
      'enum': NodeLabel.ENUM,
      'typeAlias': NodeLabel.TYPE_ALIAS,
      'constant': NodeLabel.FUNCTION, // Treat constants as functions for now
      'variable': NodeLabel.FUNCTION,
    };
    return map[kind] ?? NodeLabel.FUNCTION;
  }

  private resolveImport(
    fromFile: string,
    modulePath: string,
    parseResults: Map<string, ParseResult>
  ): string | null {
    // Handle relative imports
    if (modulePath.startsWith('.')) {
      const fromDir = path.dirname(fromFile);
      const resolved = path.resolve(fromDir, modulePath);
      
      // Try with extensions
      for (const ext of this.options.extensions ?? DEFAULT_EXTENSIONS) {
        const tryPath = resolved + ext;
        if (parseResults.has(tryPath)) {
          return tryPath;
        }
      }
      
      // Try as index file
      for (const ext of this.options.extensions ?? DEFAULT_EXTENSIONS) {
        const tryPath = path.join(resolved, 'index' + ext);
        if (parseResults.has(tryPath)) {
          return tryPath;
        }
      }
    }

    // For absolute imports, look for matching files
    const moduleName = path.basename(modulePath);
    for (const [file] of parseResults) {
      if (file.endsWith(moduleName + '.ts') || file.endsWith(moduleName + '.js')) {
        return file;
      }
    }

    return null;
  }

  private resolveCall(
    fromFile: string,
    targetName: string,
    fileSymbols: Map<string, GraphNode>
  ): { id: string; confidence: number } | null {
    // Priority 1: Same-file exact match (confidence 1.0)
    const local = fileSymbols.get(targetName);
    if (local) {
      return { id: local.id, confidence: 1.0 };
    }

    // Priority 2: Global search by name (confidence 0.5)
    for (const node of this.graph.iterNodes()) {
      if (isCallable(node.label) && node.name === targetName) {
        return { id: node.id, confidence: 0.5 };
      }
    }

    return null;
  }

  /**
   * Compute file hash for incremental indexing
   */
  static computeFileHash(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }

  /**
   * Incremental re-indexing for specific files
   */
  async reindexFiles(
    changedFiles: string[],
    deletedFiles: string[] = []
  ): Promise<{ symbolsUpdated: number; relationshipsUpdated: number; errors: Array<{ file: string; error: string }> }> {
    if (!this.storage) {
      throw new Error('Storage backend required for incremental re-indexing');
    }

    let symbolsUpdated = 0;
    let relationshipsUpdated = 0;
    const reindexErrors: Array<{ file: string; error: string }> = [];

    for (const file of deletedFiles) {
      await this.storage.removeNodesByFile(file);
    }

    for (const file of changedFiles) {
      await this.storage.removeNodesByFile(file);

      const parser = getParserForFile(file);
      if (!parser) {
        reindexErrors.push({ file, error: 'No parser available for file type' });
        continue;
      }

      try {
        const content = fs.readFileSync(file, 'utf-8');
        const parseResult = await parser.parse(content, file);

        const newNodes: GraphNode[] = [];
        const newRels: GraphRelationship[] = [];

        for (const symbol of parseResult.symbols) {
          const node = new GraphNode({
            label: this.symbolKindToLabel(symbol.kind),
            name: symbol.name,
            filePath: file,
            startLine: symbol.startLine,
            endLine: symbol.endLine,
            content: symbol.content ?? null,
            signature: symbol.signature ?? null,
            language: parseResult.language,
            className: symbol.className ?? null,
            isExported: symbol.isExported ?? false,
          });
          newNodes.push(node);

          const fileId = generateNodeId(NodeLabel.FILE, file, path.basename(file));
          const defRel = new GraphRelationship({
            type: RelType.DEFINES,
            source: fileId,
            target: node.id,
          });
          newRels.push(defRel);

          if (symbol.className && symbol.kind === 'method') {
            const classId = generateNodeId(NodeLabel.CLASS, file, symbol.className);
            const memberRel = new GraphRelationship({
              type: RelType.MEMBER_OF,
              source: node.id,
              target: classId,
            });
            newRels.push(memberRel);
          }
        }

        if (newNodes.length > 0) {
          await this.storage.addNodes(newNodes);
          symbolsUpdated += newNodes.length;
        }
        if (newRels.length > 0) {
          await this.storage.addRelationships(newRels);
          relationshipsUpdated += newRels.length;
        }

        const hash = IngestionPipeline.computeFileHash(content);
        await this.storage.updateFileHash(file, hash);

      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        reindexErrors.push({ file, error: errMsg });
        this.errors.push({ file, error: errMsg });
      }
    }

    if (reindexErrors.length > 0) {
      console.log(`   ⚠️  Parser errors during re-index:`);
      for (const err of reindexErrors.slice(0, 3)) {
        console.log(`      - ${err.file.split('/').slice(-2).join('/')}: ${err.error.substring(0, 60)}`);
      }
    }

    await this.rebuildCrossFileRelationships(changedFiles);

    return { symbolsUpdated, relationshipsUpdated, errors: reindexErrors };
  }

  private async rebuildCrossFileRelationships(files: string[]): Promise<void> {
    const allSymbols = await this.storage!.getAllSymbols();
    const symbolByName = new Map<string, GraphNode>();
    for (const sym of allSymbols) {
      symbolByName.set(sym.name, sym);
    }

    const newRels: GraphRelationship[] = [];

    for (const file of files) {
      const parser = getParserForFile(file);
      if (!parser) continue;

      try {
        const content = fs.readFileSync(file, 'utf-8');
        const parseResult = await parser.parse(content, file);

        for (const rel of parseResult.relationships) {
          if (rel.type === 'calls') {
            const target = symbolByName.get(rel.target);
            if (target) {
              newRels.push(new GraphRelationship({
                type: RelType.CALLS,
                source: rel.sourceId,
                target: target.id,
                properties: { line: rel.line },
              }));
            }
          } else if (rel.type === 'extends' || rel.type === 'implements') {
            const target = symbolByName.get(rel.target);
            if (target) {
              newRels.push(new GraphRelationship({
                type: rel.type === 'extends' ? RelType.EXTENDS : RelType.IMPLEMENTS,
                source: rel.sourceId,
                target: target.id,
              }));
            }
          } else if (rel.type === 'uses_type') {
            const target = symbolByName.get(rel.target);
            if (target) {
              newRels.push(new GraphRelationship({
                type: RelType.USES_TYPE,
                source: rel.sourceId,
                target: target.id,
              }));
            }
          }
        }
      } catch {
        // Error already logged in reindexFiles
      }
    }

    if (newRels.length > 0) {
      await this.storage!.addRelationships(newRels);
    }
  }
}

/**
 * Run the ingestion pipeline (convenience function)
 */
export async function ingestRepository(
  repoPath: string,
  options?: PipelineOptions
): Promise<{ graph: KnowledgeGraph; result: PipelineResult }> {
  const pipeline = new IngestionPipeline(options);
  return pipeline.run(repoPath);
}
