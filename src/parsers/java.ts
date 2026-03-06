import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import type { ILanguageParser, ParseResult, SymbolInfo, ImportInfo, RelationshipInfo, SymbolKind } from './base.js';
import { generateSymbolId, extractLines } from './base.js';

export class JavaParser implements ILanguageParser {
  readonly language = 'java';
  readonly extensions = ['java'];
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Java);
  }

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.java');
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

    if (nodeType === 'method_declaration') {
      const symbol = this.extractMethod(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'class_declaration') {
      const symbol = this.extractClass(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'interface_declaration') {
      const symbol = this.extractInterface(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'enum_declaration') {
      const symbol = this.extractEnum(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'import_declaration') {
      const imp = this.extractImport(node, content);
      if (imp) imports.push(imp);
    } else if (nodeType === 'method_invocation') {
      const rel = this.extractCall(node, content, filePath);
      if (rel) relationships.push(rel);
    }

    for (let i = 0; i < node.childCount; i++) {
      this.walkTree(node.child(i)!, content, filePath, symbols, imports, relationships, exports, errors);
    }
  }

  private extractMethod(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    
    const isPublic = this.hasModifier(node, 'public');
    const isStatic = this.hasModifier(node, 'static');
    const className = this.getClassName(node);

    let signature = '';
    if (isPublic) signature += 'public ';
    if (isStatic) signature += 'static ';
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'type_identifier' || child?.type === 'void_type' || child?.type === 'integral_type' || child?.type === 'boolean_type') {
        signature += child.text + ' ';
      } else if (child?.type === 'formal_parameters') {
        signature += name + this.extractParams(child);
      }
    }

    return {
      id: generateSymbolId(filePath, name, 'method'),
      name,
      kind: 'method',
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature,
      className,
      decorators: [],
      isExported: isPublic
    };
  }

  private extractClass(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;

    let signature = 'class ' + name;
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'superclass' || child?.type === 'super_interfaces') {
        signature += ' ' + child.text;
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
      isExported: this.hasModifier(node, 'public')
    };
  }

  private extractInterface(node: Parser.SyntaxNode, content: string, filePath: string): SymbolInfo | null {
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
      signature: `interface ${name}`,
      decorators: [],
      isExported: this.hasModifier(node, 'public')
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
      isExported: this.hasModifier(node, 'public')
    };
  }

  private hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        for (let j = 0; j < child.childCount; j++) {
          const mod = child.child(j);
          if (mod?.text === modifier) return true;
        }
      }
    }
    return false;
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

  private extractParams(paramsNode: Parser.SyntaxNode): string {
    const params: string[] = [];
    
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (child?.type === 'formal_parameter') {
        let type = '';
        let name = '';
        for (let j = 0; j < child.childCount; j++) {
          const p = child.child(j);
          if (p?.type === 'type_identifier' || p?.type === 'integral_type' || p?.type === 'boolean_type' || p?.type === 'array_type') {
            type = p.text;
          } else if (p?.type === 'identifier') {
            name = p.text;
          }
        }
        if (type && name) {
          params.push(`${type} ${name}`);
        }
      }
    }
    
    return `(${params.join(', ')})`;
  }

  private extractImport(node: Parser.SyntaxNode, content: string): ImportInfo | null {
    let moduleName = '';
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'scoped_identifier' || child?.type === 'identifier') {
        moduleName = child.text;
        break;
      }
    }

    if (!moduleName) return null;

    const isStatic = this.hasModifier(node, 'static');
    const names = [moduleName.split('.').pop() || moduleName];

    return {
      module: moduleName,
      names,
      isRelative: false
    };
  }

  private extractCall(node: Parser.SyntaxNode, content: string, filePath: string): RelationshipInfo | null {
    const nameNode = node.childForFieldName('name');
    
    if (!nameNode) return null;

    let targetName = nameNode.text;
    
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'object' || child?.type === 'field_access' || child?.type === 'primary') {
        targetName = `${child.text}.${targetName}`;
        break;
      }
    }

    return {
      type: 'calls',
      sourceId: `call:${filePath}:${node.startPosition.row + 1}`,
      target: targetName,
      confidence: 0.5,
      line: node.startPosition.row + 1
    };
  }
}

export const javaParser = new JavaParser();
