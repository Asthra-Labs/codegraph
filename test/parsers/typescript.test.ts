import { describe, it, expect } from 'vitest';
import { typescriptParser } from '../../src/parsers/typescript.js';

const ts = String.raw;

describe('TypeScript Parser', () => {
  describe('parse - functions', () => {
    it('should parse a simple function', async () => {
      const code = ts`function add(a: number, b: number): number {
  return a + b;
}`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.symbols.some(s => s.name === 'add')).toBe(true);
      expect(result.symbols.find(s => s.name === 'add')?.kind).toBe('function');
    });

    it('should parse arrow function', async () => {
      const code = ts`const add = (a: number, b: number): number => a + b;`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.symbols.some(s => s.name === 'add')).toBe(true);
    });

    it('should parse function with return type', async () => {
      const code = ts`function greet(name: string): string {
  return "Hello, " + name;
}`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      const func = result.symbols.find(s => s.name === 'greet');
      expect(func?.signature).toContain(': string');
    });
  });

  describe('parse - classes', () => {
    it('should parse a simple class', async () => {
      const code = ts`class User {
  name: string;
  
  constructor(name: string) {
    this.name = name;
  }
}`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.symbols.some(s => s.kind === 'class')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'class')?.name).toBe('User');
    });

    it('should parse class with inheritance', async () => {
      const code = ts`class User extends Model {
}`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      const userClass = result.symbols.find(s => s.kind === 'class');
      expect(userClass?.signature).toContain('extends Model');
    });

    it('should parse class methods', async () => {
      const code = ts`class User {
  greet(): string {
    return "Hello";
  }
}`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.symbols.some(s => s.kind === 'method')).toBe(true);
    });
  });

  describe('parse - interfaces', () => {
    it('should parse an interface', async () => {
      const code = ts`interface User {
  name: string;
  age: number;
}`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.symbols.some(s => s.kind === 'interface')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'interface')?.name).toBe('User');
    });

    it('should parse interface with extends', async () => {
      const code = ts`interface User extends Person {
  name: string;
}`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      const iface = result.symbols.find(s => s.kind === 'interface');
      expect(iface?.signature).toContain('extends Person');
    });
  });

  describe('parse - type aliases', () => {
    it('should parse type alias', async () => {
      const code = ts`type ID = string | number;`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.symbols.some(s => s.kind === 'typeAlias')).toBe(true);
    });

    it('should parse interface type', async () => {
      const code = ts`type User = {
  name: string;
  age: number;
};`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.symbols.some(s => s.kind === 'typeAlias')).toBe(true);
    });
  });

  describe('parse - enums', () => {
    it('should parse enum', async () => {
      const code = ts`enum Color {
  Red,
  Green,
  Blue,
}`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.symbols.some(s => s.kind === 'enum')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'enum')?.name).toBe('Color');
    });
  });

  describe('parse - imports', () => {
    it('should parse import statement', async () => {
      const code = ts`import { add } from './math';
import React from 'react';`;
      
      const result = await typescriptParser.parse(code, 'test.ts');
      
      expect(result.imports.length).toBeGreaterThan(0);
    });
  });

  describe('canHandle', () => {
    it('should handle .ts files', () => {
      expect(typescriptParser.canHandle('test.ts')).toBe(true);
      expect(typescriptParser.canHandle('module.ts')).toBe(true);
    });

    it('should handle .tsx files', () => {
      expect(typescriptParser.canHandle('component.tsx')).toBe(true);
    });

    it('should not handle non-typescript files', () => {
      expect(typescriptParser.canHandle('test.js')).toBe(false);
      expect(typescriptParser.canHandle('test.py')).toBe(false);
    });
  });
});
