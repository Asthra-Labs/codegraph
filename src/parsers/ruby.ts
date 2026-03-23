import type { ILanguageParser, ImportInfo, ParseResult, RelationshipInfo, SymbolInfo, SymbolKind } from './base.js';
import { extractLines, generateSymbolId } from './base.js';

const RUBY_CALL_KEYWORDS = new Set([
  'if', 'elsif', 'else', 'unless', 'while', 'until', 'case', 'when', 'begin', 'rescue', 'ensure', 'for',
  'return', 'yield', 'super', 'class', 'module', 'def', 'do', 'end',
]);

type RubyClassScope = {
  name: string;
  startLine: number;
  endLine: number;
};

export class RubyParser implements ILanguageParser {
  readonly language = 'ruby';
  readonly extensions = ['rb'];

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.rb');
  }

  async parse(content: string, filePath: string): Promise<ParseResult> {
    const lines = content.split('\n');
    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const relationships: RelationshipInfo[] = [];
    const exports: string[] = [];
    const errors: string[] = [];

    this.collectImports(lines, imports);
    const classScopes = this.collectClassScopes(content, filePath, lines, symbols, exports);
    this.collectMethods(content, filePath, lines, classScopes, symbols, relationships, exports);

    return { symbols, imports, relationships, exports, language: this.language, errors };
  }

  private collectImports(lines: string[], imports: ImportInfo[]): void {
    for (const line of lines) {
      const requireMatch = line.match(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/);
      if (!requireMatch?.[1]) continue;
      imports.push({
        module: requireMatch[1],
        names: [requireMatch[1]],
        isRelative: line.includes('require_relative'),
      });
    }
  }

  private collectClassScopes(
    content: string,
    filePath: string,
    lines: string[],
    symbols: SymbolInfo[],
    exports: string[]
  ): RubyClassScope[] {
    const scopes: RubyClassScope[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const classMatch = line.match(/^\s*(?:class|module)\s+([A-Za-z_][A-Za-z0-9_:]*)/);
      if (!classMatch?.[1]) continue;
      const className = classMatch[1];
      const endLine = this.findRubyBlockEnd(lines, i);
      const startLine = i + 1;
      symbols.push({
        id: generateSymbolId(filePath, className, 'class'),
        name: className,
        kind: 'class',
        filePath,
        startLine,
        endLine,
        content: extractLines(content, startLine, endLine),
        signature: className,
        isExported: true,
      });
      exports.push(className);
      scopes.push({ name: className, startLine, endLine });
    }
    return scopes;
  }

  private collectMethods(
    content: string,
    filePath: string,
    lines: string[],
    classScopes: RubyClassScope[],
    symbols: SymbolInfo[],
    relationships: RelationshipInfo[],
    exports: string[]
  ): void {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const defMatch = line.match(/^\s*def\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_!?=]*)/);
      if (!defMatch?.[1]) continue;

      const methodName = defMatch[1];
      const startLine = i + 1;
      const endLine = this.findRubyBlockEnd(lines, i);
      const classScope = classScopes.find((scope) => startLine >= scope.startLine && startLine <= scope.endLine);
      const className = classScope?.name;
      const kind: SymbolKind = className ? 'method' : 'function';
      const signature = `${methodName}()`;

      const symbol: SymbolInfo = {
        id: generateSymbolId(filePath, methodName, kind),
        name: methodName,
        kind,
        filePath,
        startLine,
        endLine,
        content: extractLines(content, startLine, endLine),
        signature,
        className,
        isExported: true,
      };
      symbols.push(symbol);
      exports.push(methodName);
      relationships.push(...this.extractCallRelationships(symbol.content, symbol.id, startLine));
    }
  }

  private extractCallRelationships(body: string, sourceId: string, bodyStartLine: number): RelationshipInfo[] {
    const rels: RelationshipInfo[] = [];
    const lines = body.split('\n');
    const callRegex = /([A-Za-z_][A-Za-z0-9_!?=]*)\s*\(/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let match: RegExpExecArray | null;
      while ((match = callRegex.exec(line)) !== null) {
        const target = match[1];
        if (!target || RUBY_CALL_KEYWORDS.has(target.toLowerCase())) continue;
        rels.push({
          type: 'calls',
          sourceId,
          target,
          confidence: 0.55,
          line: bodyStartLine + i,
        });
      }
    }

    return rels;
  }

  private findRubyBlockEnd(lines: string[], startIndex: number): number {
    let depth = 0;
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i] || '';
      const stripped = line.replace(/#.*$/, '');
      const openerCount = (stripped.match(/\b(class|module|def|if|unless|case|begin|do)\b/g) || []).length;
      const closerCount = (stripped.match(/\bend\b/g) || []).length;
      depth += openerCount;
      depth -= closerCount;
      if (i > startIndex && depth <= 0) {
        return i + 1;
      }
    }
    return startIndex + 1;
  }
}

export const rubyParser = new RubyParser();
