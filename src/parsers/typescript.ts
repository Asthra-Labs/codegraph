import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import JavaScript from 'tree-sitter-javascript';
import type { ILanguageParser, ParseResult, SymbolInfo, ImportInfo, RelationshipInfo, SymbolKind } from './base.js';
import { generateSymbolId, extractLines } from './base.js';

export class TypeScriptParser implements ILanguageParser {
  readonly language = 'typescript';
  readonly extensions = ['ts', 'tsx'];
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(TypeScript.typescript);
  }

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
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

    if (nodeType === 'function_declaration' || nodeType === 'method_definition') {
      const symbol = this.extractFunction(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'variable_declarator') {
      const symbol = this.extractArrowFunction(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'class_declaration') {
      const symbol = this.extractClass(node, content, filePath);
      if (symbol) symbols.push(symbol);
      this.extractHeritage(node, content, filePath, relationships);
    } else if (nodeType === 'interface_declaration') {
      const symbol = this.extractInterface(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'type_alias_declaration') {
      const symbol = this.extractTypeAlias(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'enum_declaration') {
      const symbol = this.extractEnum(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'import_statement') {
      const imp = this.extractImport(node, content);
      if (imp) imports.push(imp);
    } else if (nodeType === 'call_expression') {
      const rel = this.extractCall(node, content, filePath);
      if (rel) relationships.push(rel);
    } else if (nodeType === 'new_expression') {
      const rel = this.extractInstantiation(node, content, filePath);
      if (rel) relationships.push(rel);
    } else if (nodeType === 'required_parameter' || nodeType === 'optional_parameter') {
      this.extractTypeUsage(node, content, filePath, relationships);
    } else if (nodeType === 'variable_declarator') {
      this.extractVariableTypeUsage(node, content, filePath, relationships);
    }

    for (let i = 0; i < node.childCount; i++) {
      this.walkTree(node.child(i)!, content, filePath, symbols, imports, relationships, exports, errors);
    }
  }

  private extractArrowFunction(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    const valueNode = node.childForFieldName('value');
    
    if (!nameNode || !valueNode) return null;
    
    if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression') {
      return null;
    }

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    let signature = name;
    
    for (let i = 0; i < valueNode.childCount; i++) {
      const child = valueNode.child(i);
      if (child?.type === 'parameters') {
        signature += this.extractParams(child);
      } else if (child?.type === 'type_annotation' || child?.type === 'type_identifier') {
        signature += `: ${child.text}`;
      }
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
      isExported: this.isExported(node.parent),
      docstring: this.extractJSDoc(node, content)
    };
  }

  private extractFunction(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    const paramsNode = node.childForFieldName('parameters');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    
    const className = this.getClassName(node);
    const kind: SymbolKind = className ? 'method' : 'function';

    let signature = name;
    if (paramsNode) {
      signature += this.extractParams(paramsNode);
    }
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'type_annotation') {
        signature += ` ${child.text}`;
        break;
      }
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
      decorators: [],
      isExported: this.isExported(node),
      docstring: this.extractJSDoc(node, content)
    };
  }

  private extractClass(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    let signature = `class ${name}`;
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'class_heritage') {
        signature += ` ${child.text}`;
      }
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
      decorators: [],
      isExported: this.isExported(node),
      docstring: this.extractJSDoc(node, content)
    };
  }

  private extractInterface(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    let signature = `interface ${name}`;
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'extends_type_clause') {
        signature += ` ${child.text}`;
      }
    }

    return {
      id: generateSymbolId(filePath, name, 'interface'),
      name,
      kind: 'interface',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature,
      decorators: [],
      isExported: this.isExported(node),
      docstring: this.extractJSDoc(node, content)
    };
  }

  private extractTypeAlias(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    return {
      id: generateSymbolId(filePath, name, 'typeAlias'),
      name,
      kind: 'typeAlias',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature: `type ${name}`,
      decorators: [],
      isExported: this.isExported(node),
      docstring: this.extractJSDoc(node, content)
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
      isExported: this.isExported(node),
      docstring: this.extractJSDoc(node, content)
    };
  }

  private getClassName(node: Parser.SyntaxNode): string | undefined {
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'class_declaration') {
        const nameNode = parent.childForFieldName('name');
        return nameNode?.text;
      }
      parent = parent.parent;
    }
    return undefined;
  }

  private isExported(node: Parser.SyntaxNode): boolean {
    const parent = node.parent;
    if (!parent) return false;
    return parent.type === 'export_statement';
  }

  private extractJSDoc(node: Parser.SyntaxNode, _content: string): string | undefined {
    const prevSibling = node.previousSibling;
    if (!prevSibling || prevSibling.type !== 'comment') return undefined;

    const commentText = prevSibling.text;
    if (!commentText.startsWith('/**') && !commentText.startsWith('*')) return undefined;

    const lines = commentText.split('\n');
    const cleanedLines = lines
      .map(line => line.replace(/^\s*\*?\s?/, '').replace(/\s*\*\/\s*$/, ''))
      .filter(line => line.length > 0 && !line.startsWith('@'));

    return cleanedLines.join(' ').trim() || undefined;
  }

  private extractParams(paramsNode: Parser.SyntaxNode): string {
    const params: string[] = [];
    
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (child?.type === 'required_parameter' || child?.type === 'optional_parameter') {
        const name = child.childForFieldName('name');
        const type = child.childForFieldName('type');
        if (name) {
          params.push(type ? `${name.text}: ${type.text}` : name.text);
        }
      }
    }
    
    return `(${params.join(', ')})`;
  }

  private extractImport(node: Parser.SyntaxNode, content: string): ImportInfo | null {
    let moduleName = '';
    const names: string[] = [];
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'string') {
        moduleName = child.text.replace(/['"]/g, '');
      } else if (child?.type === 'import_clause') {
        for (let j = 0; j < child.childCount; j++) {
          const clauseChild = child.child(j);
          if (clauseChild?.type === 'identifier' || clauseChild?.type === 'named_imports') {
            if (clauseChild.type === 'identifier') {
              names.push(clauseChild.text);
            } else {
              for (let k = 0; k < clauseChild.childCount; k++) {
                const specifier = clauseChild.child(k);
                if (specifier?.type === 'import_specifier') {
                  const name = specifier.childForFieldName('name');
                  if (name) names.push(name.text);
                }
              }
            }
          }
        }
      }
    }

    if (!moduleName) return null;

    return {
      module: moduleName,
      names: names.length > 0 ? names : ['default'],
      isRelative: moduleName.startsWith('.') || moduleName.startsWith('@')
    };
  }

  private extractCall(node: Parser.SyntaxNode, content: string, filePath: string): RelationshipInfo | null {
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    let targetName = '';
    if (funcNode.type === 'identifier') {
      targetName = funcNode.text;
    } else if (funcNode.type === 'member_expression') {
      const property = funcNode.childForFieldName('property');
      if (property) targetName = property.text;
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

  private extractHeritage(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    relationships: RelationshipInfo[]
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    
    const className = nameNode.text;
    const classId = generateSymbolId(filePath, className, 'class');

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'class_heritage') {
        for (let j = 0; j < child.childCount; j++) {
          const heritageChild = child.child(j);
          if (heritageChild?.type === 'extends_clause') {
            const typeIdentifier = this.findFirstTypeIdentifier(heritageChild);
            if (typeIdentifier) {
              relationships.push({
                type: 'extends',
                sourceId: classId,
                target: typeIdentifier.text,
                confidence: 1.0,
                line: heritageChild.startPosition.row + 1
              });
            }
          } else if (heritageChild?.type === 'implements_clause') {
            for (let k = 0; k < heritageChild.childCount; k++) {
              const implChild = heritageChild.child(k);
              if (implChild?.type === 'type_identifier' || implChild?.type === 'generic_type') {
                const typeName = implChild.type === 'type_identifier' 
                  ? implChild.text 
                  : implChild.childForFieldName('name')?.text;
                if (typeName) {
                  relationships.push({
                    type: 'implements',
                    sourceId: classId,
                    target: typeName,
                    confidence: 1.0,
                    line: implChild.startPosition.row + 1
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  private findFirstTypeIdentifier(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (node.type === 'type_identifier' || node.type === 'identifier') return node;
    for (let i = 0; i < node.childCount; i++) {
      const result = this.findFirstTypeIdentifier(node.child(i)!);
      if (result) return result;
    }
    return null;
  }

  private extractInstantiation(node: Parser.SyntaxNode, content: string, filePath: string): RelationshipInfo | null {
    const constructorNode = node.childForFieldName('constructor');
    if (!constructorNode) return null;

    let className = '';
    if (constructorNode.type === 'identifier') {
      className = constructorNode.text;
    } else if (constructorNode.type === 'member_expression') {
      const property = constructorNode.childForFieldName('property');
      if (property) className = property.text;
    } else if (constructorNode.type === 'type_identifier') {
      className = constructorNode.text;
    }

    if (!className) return null;

    const enclosingSymbolId = this.findEnclosingSymbolId(node, filePath);

    return {
      type: 'instantiates',
      sourceId: enclosingSymbolId,
      target: className,
      confidence: 0.8,
      line: node.startPosition.row + 1
    };
  }

  private extractTypeUsage(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    relationships: RelationshipInfo[]
  ): void {
    const typeNode = node.childForFieldName('type');
    if (!typeNode) return;

    const typeIdentifiers = this.findAllTypeIdentifiers(typeNode);
    const enclosingSymbolId = this.findEnclosingSymbolId(node, filePath);

    for (const typeIdentifier of typeIdentifiers) {
      const typeName = typeIdentifier.text;
      if (this.isBuiltinType(typeName)) continue;

      relationships.push({
        type: 'uses_type',
        sourceId: enclosingSymbolId,
        target: typeName,
        confidence: 0.7,
        line: node.startPosition.row + 1
      });
    }
  }

  private extractVariableTypeUsage(
    node: Parser.SyntaxNode,
    content: string,
    filePath: string,
    relationships: RelationshipInfo[]
  ): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'type_annotation') {
        const typeIdentifiers = this.findAllTypeIdentifiers(child);
        const enclosingSymbolId = this.findEnclosingSymbolId(node, filePath);

        for (const typeIdentifier of typeIdentifiers) {
          const typeName = typeIdentifier.text;
          if (this.isBuiltinType(typeName)) continue;

          relationships.push({
            type: 'uses_type',
            sourceId: enclosingSymbolId,
            target: typeName,
            confidence: 0.7,
            line: node.startPosition.row + 1
          });
        }
      }
    }
  }

  private findAllTypeIdentifiers(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const results: Parser.SyntaxNode[] = [];
    
    if (node.type === 'type_identifier') {
      results.push(node);
      return results;
    }

    for (let i = 0; i < node.childCount; i++) {
      results.push(...this.findAllTypeIdentifiers(node.child(i)!));
    }

    return results;
  }

  private isBuiltinType(typeName: string): boolean {
    const builtins = new Set([
      'string', 'number', 'boolean', 'void', 'null', 'undefined',
      'any', 'unknown', 'never', 'object', 'symbol', 'bigint',
      'String', 'Number', 'Boolean', 'Object', 'Array', 'Map', 'Set',
      'Promise', 'Date', 'RegExp', 'Error', 'Function'
    ]);
    return builtins.has(typeName);
  }

  private findEnclosingSymbolId(node: Parser.SyntaxNode, filePath: string): string {
    let current: Parser.SyntaxNode | null = node.parent;
    
    while (current) {
      const nodeType = current.type;
      if (nodeType === 'function_declaration' || nodeType === 'method_definition') {
        const nameNode = current.childForFieldName('name');
        if (nameNode) {
          const kind = this.getClassName(current) ? 'method' : 'function';
          return generateSymbolId(filePath, nameNode.text, kind);
        }
      } else if (nodeType === 'class_declaration') {
        const nameNode = current.childForFieldName('name');
        if (nameNode) {
          return generateSymbolId(filePath, nameNode.text, 'class');
        }
      } else if (nodeType === 'arrow_function') {
        const parent = current.parent;
        if (parent?.type === 'variable_declarator') {
          const nameNode = parent.childForFieldName('name');
          if (nameNode) {
            return generateSymbolId(filePath, nameNode.text, 'function');
          }
        }
      }
      current = current.parent;
    }

    return `file:${filePath}:global`;
  }
}

export class JavaScriptParser implements ILanguageParser {
  readonly language = 'javascript';
  readonly extensions = ['js', 'jsx', 'mjs', 'cjs'];
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(JavaScript);
  }

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs');
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

    if (nodeType === 'function_declaration' || nodeType === 'method_definition') {
      const symbol = this.extractFunction(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'class_declaration') {
      const symbol = this.extractClass(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'import_statement') {
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
    const className = this.getClassName(node);
    const kind: SymbolKind = className ? 'method' : 'function';

    return {
      id: generateSymbolId(filePath, name, kind),
      name,
      kind,
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature: name,
      className,
      decorators: [],
      isExported: false
    };
  }

  private extractClass(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
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
      signature: `class ${name}`,
      decorators: [],
      isExported: false
    };
  }

  private getClassName(node: Parser.SyntaxNode): string | undefined {
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'class_declaration') {
        const nameNode = parent.childForFieldName('name');
        return nameNode?.text;
      }
      parent = parent.parent;
    }
    return undefined;
  }

  private extractImport(node: Parser.SyntaxNode, content: string): ImportInfo | null {
    let moduleName = '';
    const names: string[] = [];
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'string') {
        moduleName = child.text.replace(/['"]/g, '');
      }
    }

    if (!moduleName) return null;

    return {
      module: moduleName,
      names: ['default'],
      isRelative: moduleName.startsWith('.')
    };
  }

  private extractCall(node: Parser.SyntaxNode, content: string, filePath: string): RelationshipInfo | null {
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    let targetName = '';
    if (funcNode.type === 'identifier') {
      targetName = funcNode.text;
    } else if (funcNode.type === 'member_expression') {
      const property = funcNode.childForFieldName('property');
      if (property) targetName = property.text;
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

  private extractJSDoc(node: Parser.SyntaxNode, content: string): string | undefined {
    const prevSibling = node.previousSibling;
    if (!prevSibling || prevSibling.type !== 'comment') return undefined;

    const commentText = prevSibling.text;
    if (!commentText.startsWith('/**') && !commentText.startsWith('*')) return undefined;

    const lines = commentText.split('\n');
    const cleanedLines = lines
      .map(line => line.replace(/^\s*\*?\s?/, '').replace(/\s*\*\/\s*$/, ''))
      .filter(line => line.length > 0 && !line.startsWith('@'));

    return cleanedLines.join(' ').trim() || undefined;
  }
}

export const typescriptParser = new TypeScriptParser();
export const javascriptParser = new JavaScriptParser();
