import type { ILanguageParser, ImportInfo, ParseResult, RelationshipInfo, SymbolInfo, SymbolKind } from './base.js';
import { extractLines, generateSymbolId } from './base.js';

const PHP_CALL_KEYWORDS = new Set([
  'if', 'for', 'foreach', 'while', 'switch', 'catch', 'echo', 'isset', 'empty', 'array', 'new', 'clone',
  'include', 'include_once', 'require', 'require_once', 'return', 'throw', 'function', 'class', 'trait', 'interface',
]);

type PhpClassScope = {
  name: string;
  startLine: number;
  endLine: number;
};

export class PhpParser implements ILanguageParser {
  readonly language = 'php';
  readonly extensions = ['php', 'phtml'];

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.php') || filePath.endsWith('.phtml');
  }

  async parse(content: string, filePath: string): Promise<ParseResult> {
    const lines = content.split('\n');
    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const relationships: RelationshipInfo[] = [];
    const exports: string[] = [];
    const errors: string[] = [];

    const classScopes = this.collectClasses(content, filePath, lines, symbols, exports);
    this.collectImports(lines, imports);
    this.collectFunctions(content, filePath, lines, classScopes, symbols, relationships, exports);

    return { symbols, imports, relationships, exports, language: this.language, errors };
  }

  private collectImports(lines: string[], imports: ImportInfo[]): void {
    for (const line of lines) {
      const useMatch = line.match(/^\s*use\s+([^;]+);/);
      if (!useMatch?.[1]) continue;
      const names = useMatch[1]
        .split(',')
        .map((entry) => entry.trim().replace(/\s+as\s+.+$/i, '').trim())
        .filter((entry) => entry.length > 0);
      if (names.length === 0) continue;
      imports.push({
        module: names[0]!,
        names,
        isRelative: false,
      });
    }
  }

  private collectClasses(
    content: string,
    filePath: string,
    lines: string[],
    symbols: SymbolInfo[],
    exports: string[]
  ): PhpClassScope[] {
    const scopes: PhpClassScope[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const classMatch = line.match(/^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (!classMatch?.[1]) continue;
      const className = classMatch[1];
      const endLine = this.findBraceBlockEnd(lines, i);
      const startLine = i + 1;
      const symbol: SymbolInfo = {
        id: generateSymbolId(filePath, className, 'class'),
        name: className,
        kind: 'class',
        filePath,
        startLine,
        endLine,
        content: extractLines(content, startLine, endLine),
        signature: className,
        isExported: true,
      };
      symbols.push(symbol);
      exports.push(className);
      scopes.push({ name: className, startLine, endLine });
    }
    return scopes;
  }

  private collectFunctions(
    content: string,
    filePath: string,
    lines: string[],
    classScopes: PhpClassScope[],
    symbols: SymbolInfo[],
    relationships: RelationshipInfo[],
    exports: string[]
  ): void {
    const functionRegex = /^\s*(?:(public|protected|private)\s+)?(?:(static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const match = line.match(functionRegex);
      if (!match?.[3]) continue;

      const visibility = (match[1] || '').toLowerCase();
      const functionName = match[3];
      const params = match[4] || '';
      const startLine = i + 1;
      const endLine = this.findBraceBlockEnd(lines, i);
      const classScope = classScopes.find((scope) => startLine >= scope.startLine && startLine <= scope.endLine);
      const className = classScope?.name;
      const kind: SymbolKind = className ? 'method' : 'function';
      const signature = `${functionName}(${params.trim()})`;
      const isPrivate = visibility === 'private';
      const isExported = !isPrivate;

      const symbol: SymbolInfo = {
        id: generateSymbolId(filePath, functionName, kind),
        name: functionName,
        kind,
        filePath,
        startLine,
        endLine,
        content: extractLines(content, startLine, endLine),
        signature,
        className,
        isExported,
      };
      symbols.push(symbol);
      if (isExported) {
        exports.push(functionName);
      }

      const body = extractLines(content, startLine, endLine);
      relationships.push(...this.extractCallRelationships(body, symbol.id, startLine));
    }
  }

  private extractCallRelationships(body: string, sourceId: string, bodyStartLine: number): RelationshipInfo[] {
    const rels: RelationshipInfo[] = [];
    const lines = body.split('\n');
    const callRegex = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let match: RegExpExecArray | null;
      while ((match = callRegex.exec(line)) !== null) {
        const target = match[1];
        if (!target || PHP_CALL_KEYWORDS.has(target.toLowerCase())) continue;
        rels.push({
          type: 'calls',
          sourceId,
          target,
          confidence: 0.6,
          line: bodyStartLine + i,
        });
      }
    }

    return rels;
  }

  private findBraceBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    let seenOpeningBrace = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i] || '';
      const openCount = (line.match(/\{/g) || []).length;
      const closeCount = (line.match(/\}/g) || []).length;
      if (openCount > 0) {
        seenOpeningBrace = true;
      }
      depth += openCount;
      depth -= closeCount;
      if (seenOpeningBrace && depth <= 0) {
        return i + 1;
      }
    }

    return startIndex + 1;
  }
}

export const phpParser = new PhpParser();
