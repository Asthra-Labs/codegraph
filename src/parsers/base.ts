import type Parser from 'tree-sitter';

export type SymbolKind = 
  | 'function' 
  | 'method' 
  | 'class' 
  | 'interface' 
  | 'enum' 
  | 'typeAlias' 
  | 'constant'
  | 'variable';

export type RelationshipType = 'calls' | 'imports' | 'extends' | 'implements' | 'uses_type' | 'instantiates';

export interface SymbolInfo {
  id: string;
  name: string;
  kind: SymbolKind;
  filePath: string;
  startLine: number;
  endLine: number;
  content: string;
  signature: string;
  className?: string;
  decorators?: string[];
  isExported?: boolean;
  docstring?: string;
}

export interface ImportInfo {
  module: string;
  names: string[];
  isRelative: boolean;
  alias?: string;
}

export interface RelationshipInfo {
  type: RelationshipType;
  sourceId: string;
  target: string;
  confidence: number;
  line: number;
}

export interface ParseResult {
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  relationships: RelationshipInfo[];
  exports: string[];
  language: string;
  errors?: string[];
}

export interface ILanguageParser {
  readonly language: string;
  readonly extensions: string[];
  canHandle(filePath: string): boolean;
  parse(content: string, filePath: string): Promise<ParseResult>;
}

export function generateSymbolId(filePath: string, name: string, kind: SymbolKind): string {
  return `${kind}:${filePath}:${name}`;
}

export function extractLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n');
  return lines.slice(startLine - 1, endLine).join('\n');
}

const CODE_EXTENSIONS = new Set([
  'py', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'go', 'rs', 'java', 'c', 'cpp', 'h', 'hpp',
  'cs', 'rb', 'php', 'swift', 'kt', 'scala'
]);

export function isCodeFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? CODE_EXTENSIONS.has(ext) : false;
}

const LANGUAGE_MAP: Record<string, string> = {
  'py': 'python',
  'ts': 'typescript',
  'tsx': 'typescript',
  'js': 'javascript',
  'jsx': 'javascript',
  'mjs': 'javascript',
  'cjs': 'javascript',
  'go': 'go',
  'rs': 'rust',
  'java': 'java',
  'php': 'php',
  'phtml': 'php',
  'rb': 'ruby',
};

export function getLanguageFromExtension(ext: string): string | null {
  const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext;
  return LANGUAGE_MAP[cleanExt.toLowerCase()] || null;
}
