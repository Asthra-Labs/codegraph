import Parser from 'tree-sitter';
import Rust from 'tree-sitter-rust';
import type { ILanguageParser, ParseResult, SymbolInfo, ImportInfo, RelationshipInfo, SymbolKind } from './base.js';
import { generateSymbolId, extractLines } from './base.js';

export class RustParser implements ILanguageParser {
  readonly language = 'rust';
  readonly extensions = ['rs'];
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Rust);
  }

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.rs');
  }

  async parse(content: string, filePath: string): Promise<ParseResult> {
    const tree = this.parser.parse(content);
    
    const symbols: SymbolInfo[] = [];
    const imports: ImportInfo[] = [];
    const relationships: RelationshipInfo[] = [];
    const exports: string[] = [];
    const errors: string[] = [];

    this.walkTree(tree.rootNode, content, filePath, symbols, imports, relationships, exports, errors);

    return { symbols, imports, relationships, exports, language: this.language, errors };
  }

  private walkTree(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    symbols: SymbolInfo[],
    imports: ImportInfo[],
    relationships: RelationshipInfo[],
    exports: string[],
    errors: string[]
  ): void {
    const nodeType = node.type;

    if (nodeType === 'function_item') {
      const symbol = this.extractFunction(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'struct_item') {
      const symbol = this.extractStruct(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'enum_item') {
      const symbol = this.extractEnum(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'trait_item') {
      const symbol = this.extractTrait(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'impl_item') {
      this.extractImpl(node, content, filePath, symbols);
    } else if (nodeType === 'use_declaration') {
      const imp = this.extractImport(node, content);
      if (imp) imports.push(imp);
    } else if (nodeType === 'call_expression') {
      const rel = this.extractCall(node, content, filePath);
      if (rel) relationships.push(rel);
    }

    for (let i = 0; i < node.childCount; i++) {
      this.walkTree(node.child(i)!, content, filePath, symbols, imports, relationships, exports, errors);
    }
  }

  private extractFunction(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const isExported = this.isPublic(node);

    let signature = 'fn ' + name;
    let returnType = '';
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'parameters') {
        signature += this.extractParams(child);
      } else if (child?.type === 'type_identifier' || child?.type === 'generic_type' || child?.type === 'primitive_type') {
        returnType = child.text;
      }
    }
    
    if (returnType) {
      signature += ` -> ${returnType}`;
    }

    return {
      id: generateSymbolId(filePath, name, 'function'),
      name,
      kind: 'function',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature,
      decorators: [],
      isExported
    };
  }

  private extractStruct(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    return {
      id: generateSymbolId(filePath, name, 'class'),
      name,
      kind: 'class',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature: `struct ${name}`,
      decorators: [],
      isExported: this.isPublic(node)
    };
  }

  private extractEnum(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    return {
      id: generateSymbolId(filePath, name, 'enum'),
      name,
      kind: 'enum',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature: `enum ${name}`,
      decorators: [],
      isExported: this.isPublic(node)
    };
  }

  private extractTrait(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    return {
      id: generateSymbolId(filePath, name, 'interface'),
      name,
      kind: 'interface',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature: `trait ${name}`,
      decorators: [],
      isExported: this.isPublic(node)
    };
  }

  private extractImpl(node: Parser.SyntaxNode, content: string, filePath: string, symbols: SymbolInfo[]): void {
    const typeNode = node.childForFieldName('type');
    
    if (!typeNode) return;

    const name = typeNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    let signature = 'impl ' + name;
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'trait') {
        signature = `impl ${child.text} for ${name}`;
        break;
      }
    }

    symbols.push({
      id: generateSymbolId(filePath, `impl_${name}`, 'class'),
      name: `impl ${name}`,
      kind: 'class',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature,
      decorators: [],
      isExported: false
    });

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'function_item') {
        const method = this.extractFunction(child, content, filePath);
        if (method) {
          method.className = name;
          method.kind = 'method';
          symbols.push(method);
        }
      }
    }
  }

  private isPublic(node: Parser.SyntaxNode): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'visibility_modifier') {
        return child.text === 'pub';
      }
    }
    return false;
  }

  private extractParams(paramsNode: Parser.SyntaxNode): string {
    const params: string[] = [];
    
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (child?.type === 'parameter') {
        const pattern = child.childForFieldName('pattern');
        const type = child.childForFieldName('type');
        if (pattern) {
          params.push(type ? `${pattern.text}: ${type.text}` : pattern.text);
        }
      }
    }
    
    return `(${params.join(', ')})`;
  }

  private extractImport(node: Parser.SyntaxNode, content: string): ImportInfo | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'scoped_identifier' || child?.type === 'use_clause') {
        const moduleName = this.extractUsePath(child);
        if (moduleName) {
          return {
            module: moduleName,
            names: [moduleName.split('::').pop() || moduleName],
            isRelative: moduleName.startsWith('crate') || moduleName.startsWith('super')
          };
        }
      }
    }
    return null;
  }

  private extractUsePath(node: Parser.SyntaxNode): string {
    if (node.type === 'scoped_identifier' || node.type === 'identifier') {
      return node.text;
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) {
        const path = this.extractUsePath(child);
        if (path) return path;
      }
    }
    return '';
  }

  private extractCall(node: Parser.SyntaxNode, content: string, filePath: string): RelationshipInfo | null {
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    let targetName = '';
    if (funcNode.type === 'identifier') {
      targetName = funcNode.text;
    } else if (funcNode.type === 'field_expression') {
      const field = funcNode.childForFieldName('field');
      if (field) targetName = field.text;
    }

    if (!targetName) return null;

    return {
      type: 'calls',
      sourceId: `call:${filePath}:${node.startPosition.row + 1}`,
      target: targetName,
      confidence: 0.5,
      line: node.startPosition.row + 1
    };
  }
}

export const rustParser = new RustParser();
