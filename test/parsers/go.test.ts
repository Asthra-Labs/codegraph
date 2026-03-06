import { describe, it, expect } from 'vitest';
import { goParser } from '../../src/parsers/go.js';

describe('Go Parser', () => {
  describe('parse - functions', () => {
    it('should parse a simple function', async () => {
      const code = `func add(a int, b int) int {
  return a + b
}`;
      
      const result = await goParser.parse(code, 'test.go');
      
      expect(result.symbols.some(s => s.name === 'add')).toBe(true);
      expect(result.symbols.find(s => s.name === 'add')?.kind).toBe('function');
    });

    it('should parse function with return type', async () => {
      const code = `func greet(name string) string {
  return "Hello, " + name
}`;
      
      const result = await goParser.parse(code, 'test.go');
      
      const func = result.symbols.find(s => s.name === 'greet');
      expect(func?.signature).toContain('string');
    });

    it('should parse multiple return values', async () => {
      const code = `func divide(a, b int) (int, error) {
  if b == 0 {
    return 0, errors.New("division by zero")
  }
  return a / b, nil
}`;
      
      const result = await goParser.parse(code, 'test.go');
      
      expect(result.symbols.some(s => s.name === 'divide')).toBe(true);
    });
  });

  describe('parse - methods', () => {
    it('should parse methods with receivers', async () => {
      const code = `type User struct {
  Name string
}

func (u User) Greet() string {
  return "Hello, " + u.Name
}`;
      
      const result = await goParser.parse(code, 'test.go');
      
      expect(result.symbols.some(s => s.kind === 'method')).toBe(true);
      const method = result.symbols.find(s => s.kind === 'method');
      expect(method?.name).toBe('Greet');
      expect(method?.signature).toContain('(u User)');
    });
  });

  describe('parse - types', () => {
    it('should parse structs', async () => {
      const code = `type User struct {
  Name string
  Age  int
}`;
      
      const result = await goParser.parse(code, 'test.go');
      
      expect(result.symbols.some(s => s.kind === 'class')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'class')?.name).toBe('User');
    });

    it('should parse interfaces', async () => {
      const code = `type Reader interface {
  Read(p []byte) (n int, err error)
}`;
      
      const result = await goParser.parse(code, 'test.go');
      
      expect(result.symbols.some(s => s.kind === 'interface')).toBe(true);
    });
  });

  describe('parse - imports', () => {
    it('should parse imports', async () => {
      const code = `package main

import (
  "fmt"
  "os"
)`;
      
      const result = await goParser.parse(code, 'main.go');
      
      expect(result.imports.length).toBeGreaterThanOrEqual(2);
    });

    it('should parse external imports', async () => {
      const code = `import "github.com/gin-gonic/gin"`;
      
      const result = await goParser.parse(code, 'main.go');
      
      expect(result.imports.some(i => i.module.includes('gin'))).toBe(true);
    });
  });

  describe('canHandle', () => {
    it('should handle .go files', () => {
      expect(goParser.canHandle('test.go')).toBe(true);
      expect(goParser.canHandle('main.go')).toBe(true);
    });

    it('should not handle non-go files', () => {
      expect(goParser.canHandle('test.js')).toBe(false);
      expect(goParser.canHandle('test.py')).toBe(false);
    });
  });
});
