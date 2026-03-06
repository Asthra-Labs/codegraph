import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import type { ILanguageParser, ParseResult, SymbolInfo, ImportInfo, RelationshipInfo, SymbolKind } from './base.js';
import { generateSymbolId, extractLines } from './base.js';

export class GoParser implements ILanguageParser {
  readonly language = 'go';
  readonly extensions = ['go'];
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Go);
  }

  canHandle(filePath: string): boolean {
    return filePath.endsWith('.go');
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

    if (nodeType === 'function_declaration' || nodeType === 'method_declaration') {
      const symbol = this.extractFunction(node, content, filePath);
      if (symbol) symbols.push(symbol);
    } else if (nodeType === 'type_declaration') {
      this.extractTypeDeclaration(node, content, filePath, symbols);
    } else if (nodeType === 'import_declaration') {
      this.extractAllImports(node, imports);
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
    const paramsNode = node.childForFieldName('parameters');
    const resultNode = node.childForFieldName('result');
    
    if (!nameNode) return null;

    const name = nameNode.text;
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const isExported = name[0] === name[0].toUpperCase();
    const kind: SymbolKind = node.type === 'method_declaration' ? 'method' : 'function';

    let signature = 'func ';
    if (node.type === 'method_declaration') {
      const receiver = node.childForFieldName('receiver');
      if (receiver) {
        signature += `(${this.extractReceiver(receiver)}) `;
      }
    }
    signature += name;
    if (paramsNode) signature += this.extractParams(paramsNode);
    if (resultNode) signature += ` ${resultNode.text}`;

    return {
      id: generateSymbolId(filePath, name, kind),
      name,
      kind,
      filePath,
      startLine,
      endLine,
      content: extractLines(content, startLine, endLine),
      signature,
      decorators: [],
      isExported
    };
  }

  private extractTypeDeclaration(node: Parser.SyntaxNode, content: string, filePath: string, symbols: SymbolInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'type_spec') {
        const nameNode = child.childForFieldName('name');
        const typeNode = child.childForFieldName('type');
        
        if (!nameNode) continue;

        const name = nameNode.text;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;
        let kind: SymbolKind = 'typeAlias';
        
        if (typeNode?.type === 'struct_type') kind = 'class';
        else if (typeNode?.type === 'interface_type') kind = 'interface';

        symbols.push({
          id: generateSymbolId(filePath, name, kind),
          name,
          kind,
          filePath,
          startLine,
          endLine,
          content: extractLines(content, startLine, endLine),
          signature: `type ${name}`,
          decorators: [],
          isExported: name[0] === name[0].toUpperCase()
        });
      }
    }
  }

  private extractReceiver(receiver: Parser.SyntaxNode): string {
    for (let i = 0; i < receiver.childCount; i++) {
      const child = receiver.child(i);
      if (child?.type === 'parameter_declaration') {
        const name = child.childForFieldName('name');
        const type = child.childForFieldName('type');
        if (name && type) {
          return `${name.text} ${type.text}`;
        } else if (type) {
          return type.text;
        }
      } else if (child?.type === 'identifier') {
        const nextChild = receiver.child(i + 1);
        if (nextChild?.type === 'type_identifier') {
          return `${child.text} ${nextChild.text}`;
        }
        return child.text;
      }
    }
    return '';
  }

  private extractParams(paramsNode: Parser.SyntaxNode): string {
    const params: string[] = [];
    
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (child?.type === 'parameter_declaration') {
        const name = child.childForFieldName('name');
        const type = child.childForFieldName('type');
        if (name) {
          params.push(type ? `${name.text} ${type.text}` : name.text);
        }
      }
    }
    
    return `(${params.join(', ')})`;
  }

  private extractAllImports(node: Parser.SyntaxNode, imports: ImportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'import_spec') {
        const imp = this.extractSingleImport(child);
        if (imp) imports.push(imp);
      } else if (child?.type === 'import_spec_list') {
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j);
          if (spec?.type === 'import_spec') {
            const imp = this.extractSingleImport(spec);
            if (imp) imports.push(imp);
          }
        }
      }
    }
  }

  private extractSingleImport(spec: Parser.SyntaxNode): ImportInfo | null {
    const path = spec.childForFieldName('path');
    if (path) {
      const moduleName = path.text.replace(/"/g, '');
      return {
        module: moduleName,
        names: [moduleName.split('/').pop() || moduleName],
        isRelative: false
      };
    }
    return null;
  }

  private extractCall(node: Parser.SyntaxNode, content: string, filePath: string): RelationshipInfo | null {
    const funcNode = node.childForFieldName('function');
    if (!funcNode) return null;

    let targetName = '';
    if (funcNode.type === 'identifier') {
      targetName = funcNode.text;
    } else if (funcNode.type === 'selector_expression') {
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

export const goParser = new GoParser();
