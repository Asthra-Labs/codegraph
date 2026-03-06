import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import type { ILanguageParser, ParseResult, SymbolInfo, ImportInfo, RelationshipInfo, SymbolKind } from './base.js';
import { generateSymbolId, extractLines } from './base.js';

export class PythonParser implements ILanguageParser {
  readonly language = 'python';
  readonly extensions = ['py'];
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Python);
  }

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.py');
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

    if (nodeType === 'function_definition') {
      const symbol = this.extractFunction(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'class_definition') {
      const symbol = this.extractClass(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'import_statement') {
      const imp = this.extractImport(node, content);
      if (imp) imports.push(imp);
    } else if (nodeType === 'import_from_statement') {
      const imp = this.extractImportFrom(node, content);
      if (imp) imports.push(imp);
    } else if (nodeType === 'call') {
      const rel = this.extractCall(node, content, filePath);
      if (rel) relationships.push(rel);
    }

    for (let i = 0; i < node.childCount; i++) {
      this.walkTree(node.child(i)!, content, filePath, symbols, imports, relationships, exports, errors);
    }
  }

  private extractFunction(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    const paramsNode = node.childForFieldName('parameters');
    const returnType = node.childForFieldName('return_type');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const className = this.getClassName(node);
    const kind: SymbolKind = className ? 'method' : 'function';
    const decorators = this.extractDecorators(node);

    let signature = name;
    if (paramsNode) {
      signature += this.extractParams(paramsNode);
    }
    if (returnType) {
      signature += ` -> ${returnType.text}`;
    }

    return {
      id: generateSymbolId(filePath, name, kind),
      name,
      kind,
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature,
      className,
      decorators
    };
  }

  private extractClass(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    const argListNode = node.childForFieldName('superclasses');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const decorators = this.extractDecorators(node);

    let signature = name;
    if (argListNode && argListNode.text) {
      signature += `(${argListNode.text})`;
    }

    return {
      id: generateSymbolId(filePath, name, 'class'),
      name,
      kind: 'class',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature,
      decorators
    };
  }

  private extractDecorators(node: Parser.SyntaxNode): string[] {
    const decorators: string[] = [];
    let prev = node.previousSibling;
    
    while (prev && prev.type === 'decorator') {
      decorators.unshift(prev.text);
      prev = prev.previousSibling;
    }
    
    return decorators;
  }

  private getClassName(node: Parser.SyntaxNode): string | undefined {
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'class_definition') {
        const nameNode = parent.childForFieldName('name');
        return nameNode?.text;
      }
      parent = parent.parent;
    }
    return undefined;
  }

  private extractParams(paramsNode: Parser.SyntaxNode): string {
    const params: string[] = [];
    
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (child?.type === 'identifier' || child?.type === 'typed_parameter' || child?.type === 'default_parameter') {
        const name = child.childForFieldName('name')?.text || child.text.split('=')[0].split(':')[0].trim();
        const type = child.childForFieldName('type');
        params.push(type ? `${name}: ${type.text}` : name);
      }
    }
    
    return `(${params.join(', ')})`;
  }

  private extractImport(node: Parser.SyntaxNode, content: string): ImportInfo | null {
    const names: string[] = [];
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'dotted_name' || child?.type === 'identifier') {
        names.push(child.text);
      } else if (child?.type === 'aliased_import') {
        const name = child.childForFieldName('name');
        if (name) names.push(name.text);
      }
    }

    if (names.length === 0) return null;

    return {
      module: names[0],
      names,
      isRelative: false
    };
  }

  private extractImportFrom(node: Parser.SyntaxNode, content: string): ImportInfo | null {
    const moduleNode = node.childForFieldName('module_name');
    const moduleName = moduleNode?.text || '';
    
    const names: string[] = [];
    const wildCard = node.childForFieldName('wildcard');
    
    if (wildCard) {
      names.push('*');
    } else {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'dotted_name' || child?.type === 'identifier') {
          if (child !== moduleNode) {
            names.push(child.text);
          }
        } else if (child?.type === 'aliased_import') {
          const name = child.childForFieldName('name');
          if (name) names.push(name.text);
        }
      }
    }

    return {
      module: moduleName,
      names: names.length > 0 ? names : [moduleName.split('.').pop() || moduleName],
      isRelative: moduleName.startsWith('.')
    };
  }

  private extractCall(node: Parser.SyntaxNode, content: string, filePath: string): RelationshipInfo | null {
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    let targetName = '';
    if (funcNode.type === 'identifier') {
      targetName = funcNode.text;
    } else if (funcNode.type === 'attribute') {
      const attr = funcNode.childForFieldName('attr');
      if (attr) targetName = attr.text;
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

export const pythonParser = new PythonParser();
