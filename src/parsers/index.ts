import { pythonParser } from './python.js';
import { typescriptParser, javascriptParser } from './typescript.js';
import { goParser } from './go.js';
import { rustParser } from './rust.js';
import { javaParser } from './java.js';
import { phpParser } from './php.js';
import { rubyParser } from './ruby.js';
import { isCodeFile, getLanguageFromExtension } from './base.js';

export type {
  ILanguageParser,
  ParseResult,
  SymbolInfo,
  ImportInfo,
  RelationshipInfo,
  SymbolKind,
  RelationshipType,
} from './base.js';

import type { ILanguageParser, ParseResult } from './base.js';

const parsers: Map<string, ILanguageParser> = new Map();

parsers.set('python', pythonParser);
parsers.set('typescript', typescriptParser);
parsers.set('javascript', javascriptParser);
parsers.set('go', goParser);
parsers.set('rust', rustParser);
parsers.set('java', javaParser);
parsers.set('php', phpParser);
parsers.set('ruby', rubyParser);

export function initParsers(): void {}

export function getParserByExtension(filePath: string): ILanguageParser | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  const extMap: Record<string, string> = {
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
  
  const lang = ext ? extMap[ext] : null;
  return lang ? parsers.get(lang) ?? null : null;
}

export async function parseFile(content: string, filePath: string): Promise<ParseResult | null> {
  const parser = getParserByExtension(filePath);
  if (!parser) return null;
  return parser.parse(content, filePath);
}

export { isCodeFile, getLanguageFromExtension };

export function getParserForFile(filePath: string): ILanguageParser | null {
  return getParserByExtension(filePath);
}
