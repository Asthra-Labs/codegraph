import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { 
  initParsers, 
  getParserByExtension, 
  parseFile, 
  isCodeFile,
  getLanguageFromExtension 
} from '../../src/parsers/index.js';
import type { ILanguageParser } from '../src/parsers/base.js';

describe('Parser Factory', () => {
  beforeAll(async () => {
    await initParsers();
  });

  describe('initParsers', () => {
    it('should initialize without errors', () => {
      expect(() => initParsers()).not.toThrow();
    });
  });

  describe('getParserByExtension', () => {
    it('should return Python parser for .py', () => {
      const parser = getParserByExtension('test.py');
      expect(parser?.language).toBe('python');
    });

    it('should return TypeScript parser for .ts', () => {
      const parser = getParserByExtension('test.ts');
      expect(parser?.language).toBe('typescript');
    });

    it('should return TypeScript parser for .tsx', () => {
      const parser = getParserByExtension('component.tsx');
      expect(parser?.language).toBe('typescript');
    });

    it('should return JavaScript parser for .js', () => {
      const parser = getParserByExtension('test.js');
      expect(parser?.language).toBe('javascript');
    });

    it('should return JavaScript parser for .jsx', () => {
      const parser = getParserByExtension('component.jsx');
      expect(parser?.language).toBe('javascript');
    });

    it('should return JavaScript parser for .mjs', () => {
      const parser = getParserByExtension('module.mjs');
      expect(parser?.language).toBe('javascript');
    });

    it('should return Go parser for .go', () => {
      const parser = getParserByExtension('test.go');
      expect(parser?.language).toBe('go');
    });

    it('should return Rust parser for .rs', () => {
      const parser = getParserByExtension('test.rs');
      expect(parser?.language).toBe('rust');
    });

    it('should return Java parser for .java', () => {
      const parser = getParserByExtension('Test.java');
      expect(parser?.language).toBe('java');
    });

    it('should return PHP parser for .php', () => {
      const parser = getParserByExtension('index.php');
      expect(parser?.language).toBe('php');
    });

    it('should return Ruby parser for .rb', () => {
      const parser = getParserByExtension('worker.rb');
      expect(parser?.language).toBe('ruby');
    });

    it('should return null for unknown extensions', () => {
      expect(getParserByExtension('test.txt')).toBeNull();
      expect(getParserByExtension('test.json')).toBeNull();
      expect(getParserByExtension('test.md')).toBeNull();
    });

    it('should return null for no extension', () => {
      expect(getParserByExtension('Makefile')).toBeNull();
    });
  });

  describe('getLanguageFromExtension', () => {
    it('should return language for known extensions', () => {
      expect(getLanguageFromExtension('.py')).toBe('python');
      expect(getLanguageFromExtension('.ts')).toBe('typescript');
      expect(getLanguageFromExtension('.js')).toBe('javascript');
      expect(getLanguageFromExtension('.go')).toBe('go');
      expect(getLanguageFromExtension('.rs')).toBe('rust');
      expect(getLanguageFromExtension('.java')).toBe('java');
      expect(getLanguageFromExtension('.php')).toBe('php');
      expect(getLanguageFromExtension('.rb')).toBe('ruby');
    });

    it('should return null for unknown extensions', () => {
      expect(getLanguageFromExtension('.txt')).toBeNull();
      expect(getLanguageFromExtension('.md')).toBeNull();
    });
  });

  describe('isCodeFile', () => {
    it('should return true for code files', () => {
      expect(isCodeFile('test.py')).toBe(true);
      expect(isCodeFile('test.ts')).toBe(true);
      expect(isCodeFile('test.js')).toBe(true);
      expect(isCodeFile('test.go')).toBe(true);
      expect(isCodeFile('test.rs')).toBe(true);
      expect(isCodeFile('test.java')).toBe(true);
      expect(isCodeFile('index.php')).toBe(true);
      expect(isCodeFile('worker.rb')).toBe(true);
    });

    it('should return false for non-code files', () => {
      expect(isCodeFile('README.md')).toBe(false);
      expect(isCodeFile('config.json')).toBe(false);
      expect(isCodeFile('data.yaml')).toBe(false);
      expect(isCodeFile('Dockerfile')).toBe(false);
    });
  });

  describe('parseFile', () => {
    it('should parse Python files', async () => {
      const code = `def hello():
    print("world")`;
      
      const result = await parseFile(code, 'hello.py');
      
      expect(result).toBeDefined();
      expect(result!.language).toBe('python');
      expect(result!.symbols.length).toBeGreaterThan(0);
    });

    it('should parse TypeScript files', async () => {
      const code = `function hello(): void {
  console.log("world");
}`;
      
      const result = await parseFile(code, 'hello.ts');
      
      expect(result).toBeDefined();
      expect(result!.language).toBe('typescript');
    });

    it('should parse JavaScript files', async () => {
      const code = `function hello() {
  console.log("world");
}`;
      
      const result = await parseFile(code, 'hello.js');
      
      expect(result).toBeDefined();
      expect(result!.language).toBe('javascript');
    });

    it('should parse Go files', async () => {
      const code = `func hello() {
  fmt.Println("world")
}`;
      
      const result = await parseFile(code, 'hello.go');
      
      expect(result).toBeDefined();
      expect(result!.language).toBe('go');
    });

    it('should parse Rust files', async () => {
      const code = `fn hello() {
  println!("world");
}`;
      
      const result = await parseFile(code, 'hello.rs');
      
      expect(result).toBeDefined();
      expect(result!.language).toBe('rust');
    });

    it('should parse Java files', async () => {
      const code = `public class Hello {
  public static void main(String[] args) {
    System.out.println("world");
  }
}`;
      
      const result = await parseFile(code, 'Hello.java');
      
      expect(result).toBeDefined();
      expect(result!.language).toBe('java');
    });

    it('should parse PHP files', async () => {
      const code = `<?php
function hello($name) {
  return strtoupper($name);
}`;
      const result = await parseFile(code, 'hello.php');
      expect(result).toBeDefined();
      expect(result!.language).toBe('php');
      expect(result!.symbols.length).toBeGreaterThan(0);
    });

    it('should parse Ruby files', async () => {
      const code = `def hello(name)
  name.upcase
end`;
      const result = await parseFile(code, 'hello.rb');
      expect(result).toBeDefined();
      expect(result!.language).toBe('ruby');
      expect(result!.symbols.length).toBeGreaterThan(0);
    });

    it('should return null for unknown file types', async () => {
      const result = await parseFile('some content', 'readme.md');
      expect(result).toBeNull();
    });
  });
});
