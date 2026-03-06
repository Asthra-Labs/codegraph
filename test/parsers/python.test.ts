import { describe, it, expect } from 'vitest';
import { pythonParser } from '../../src/parsers/python.js';

const py = String.raw;

describe('Python Parser', () => {
  describe('parse - functions', () => {
    it('should parse a simple function', async () => {
      const code = py`def add(a, b):
    return a + b`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].name).toBe('add');
      expect(result.symbols[0].kind).toBe('function');
      expect(result.symbols[0].startLine).toBe(1);
      expect(result.symbols[0].endLine).toBe(2);
    });

    it('should parse function with type hints', async () => {
      const code = py`def greet(name: str) -> str:
    return f"Hello, {name}"`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.symbols).toHaveLength(1);
      expect(result.symbols[0].signature).toContain('name: str');
      expect(result.symbols[0].signature).toContain('-> str');
    });

    it('should parse multiple functions', async () => {
      const code = py`def foo():
    pass

def bar():
    pass`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols.map(s => s.name)).toContain('foo');
      expect(result.symbols.map(s => s.name)).toContain('bar');
    });

    it('should parse decorated functions', async () => {
      const code = py`@staticmethod
def helper():
    pass

@app.route('/')
def web_handler():
    pass`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.symbols).toHaveLength(2);
      expect(result.symbols[0].decorators).toContain('@staticmethod');
    });
  });

  describe('parse - classes', () => {
    it('should parse a simple class', async () => {
      const code = py`class User:
    pass`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.symbols.some(s => s.name === 'User' && s.kind === 'class')).toBe(true);
    });

    it('should parse class with inheritance', async () => {
      const code = py`class User(Model):
    pass`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.symbols[0].signature).toContain('Model');
    });
  });

  describe('parse - imports', () => {
    it('should parse import statement', async () => {
      const code = py`import os
import sys as system`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.imports.length).toBeGreaterThan(0);
      expect(result.imports.some(i => i.module === 'os')).toBe(true);
    });

    it('should parse from...import', async () => {
      const code = py`from os import path
from typing import List, Dict`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.imports.length).toBeGreaterThan(0);
    });

    it('should parse relative imports', async () => {
      const code = py`from . import utils
from ..models import User`;
      
      const result = await pythonParser.parse(code, 'test.py');
      
      expect(result.imports.some(i => i.isRelative)).toBe(true);
    });
  });

  describe('canHandle', () => {
    it('should handle .py files', () => {
      expect(pythonParser.canHandle('test.py')).toBe(true);
      expect(pythonParser.canHandle('module.py')).toBe(true);
    });

    it('should not handle non-python files', () => {
      expect(pythonParser.canHandle('test.js')).toBe(false);
      expect(pythonParser.canHandle('test.ts')).toBe(false);
      expect(pythonParser.canHandle('test.txt')).toBe(false);
    });
  });
});
