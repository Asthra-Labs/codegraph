import { describe, it, expect } from 'vitest';
import { rustParser } from '../../src/parsers/rust.js';

describe('Rust Parser', () => {
  describe('parse - functions', () => {
    it('should parse a simple function', async () => {
      const code = `fn add(a: i32, b: i32) -> i32 {
  a + b
}`;
      
      const result = await rustParser.parse(code, 'test.rs');
      
      expect(result.symbols.some(s => s.name === 'add')).toBe(true);
      expect(result.symbols.find(s => s.name === 'add')?.kind).toBe('function');
    });

    it('should parse function with return type', async () => {
      const code = `fn greet(name: &str) -> String {
  format!("Hello, {}", name)
}`;
      
      const result = await rustParser.parse(code, 'test.rs');
      
      const func = result.symbols.find(s => s.name === 'greet');
      expect(func?.signature).toContain('String');
    });

    it('should parse public functions', async () => {
      const code = `pub fn public_api() -> Result<(), Error> {
  Ok(())
}`;
      
      const result = await rustParser.parse(code, 'test.rs');
      
      const func = result.symbols.find(s => s.name === 'public_api');
      expect(func?.isExported).toBe(true);
    });
  });

  describe('parse - structs', () => {
    it('should parse a struct', async () => {
      const code = `struct User {
  name: String,
  age: u32,
}`;
      
      const result = await rustParser.parse(code, 'test.rs');
      
      expect(result.symbols.some(s => s.kind === 'class')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'class')?.name).toBe('User');
    });

    it('should parse public structs', async () => {
      const code = `pub struct Config {
  value: String,
}`;
      
      const result = await rustParser.parse(code, 'test.rs');
      
      const structSym = result.symbols.find(s => s.kind === 'class');
      expect(structSym?.isExported).toBe(true);
    });
  });

  describe('parse - enums', () => {
    it('should parse an enum', async () => {
      const code = `enum Color {
  Red,
  Green,
  Blue,
}`;
      
      const result = await rustParser.parse(code, 'test.rs');
      
      expect(result.symbols.some(s => s.kind === 'enum')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'enum')?.name).toBe('Color');
    });
  });

  describe('parse - traits', () => {
    it('should parse a trait', async () => {
      const code = `trait Drawable {
  fn draw(&self);
}`;
      
      const result = await rustParser.parse(code, 'test.rs');
      
      expect(result.symbols.some(s => s.kind === 'interface')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'interface')?.name).toBe('Drawable');
    });
  });

  describe('parse - impl', () => {
    it('should parse impl blocks', async () => {
      const code = `impl User {
  fn new(name: String) -> Self {
    User { name, age: 0 }
  }
}`;
      
      const result = await rustParser.parse(code, 'test.rs');
      
      expect(result.symbols.some(s => s.kind === 'class')).toBe(true);
    });
  });

  describe('parse - imports', () => {
    it('should parse use declarations', async () => {
      const code = `use std::collections::HashMap;
use crate::module::Item;`;
      
      const result = await rustParser.parse(code, 'lib.rs');
      
      expect(result.imports.length).toBeGreaterThan(0);
    });
  });

  describe('canHandle', () => {
    it('should handle .rs files', () => {
      expect(rustParser.canHandle('test.rs')).toBe(true);
      expect(rustParser.canHandle('lib.rs')).toBe(true);
    });

    it('should not handle non-rust files', () => {
      expect(rustParser.canHandle('test.js')).toBe(false);
      expect(rustParser.canHandle('test.go')).toBe(false);
    });
  });
});
