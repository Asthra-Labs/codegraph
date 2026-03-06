import { describe, it, expect } from 'vitest';
import { javaParser } from '../../src/parsers/java.js';

describe('Java Parser', () => {
  describe('parse - methods', () => {
    it('should parse a simple method', async () => {
      const code = `public class Test {
  public int add(int a, int b) {
    return a + b;
  }
}`;
      
      const result = await javaParser.parse(code, 'Test.java');
      
      expect(result.symbols.some(s => s.name === 'add')).toBe(true);
    });

    it('should parse method with return type', async () => {
      const code = `public String greet(String name) {
  return "Hello, " + name;
}`;
      
      const result = await javaParser.parse(code, 'Test.java');
      
      const method = result.symbols.find(s => s.name === 'greet');
      expect(method?.signature).toContain('String');
    });

    it('should parse static methods', async () => {
      const code = `public static void main(String[] args) {
  System.out.println("Hello");
}`;
      
      const result = await javaParser.parse(code, 'Main.java');
      
      const method = result.symbols.find(s => s.name === 'main');
      expect(method?.isExported).toBe(true);
    });
  });

  describe('parse - classes', () => {
    it('should parse a class', async () => {
      const code = `public class User {
  private String name;
  
  public User(String name) {
    this.name = name;
  }
}`;
      
      const result = await javaParser.parse(code, 'User.java');
      
      expect(result.symbols.some(s => s.kind === 'class')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'class')?.name).toBe('User');
    });

    it('should parse class with inheritance', async () => {
      const code = `public class User extends Model implements Serializable {}`;
      
      const result = await javaParser.parse(code, 'User.java');
      
      const userClass = result.symbols.find(s => s.kind === 'class');
      expect(userClass?.signature).toContain('extends Model');
      expect(userClass?.signature).toContain('implements Serializable');
    });
  });

  describe('parse - interfaces', () => {
    it('should parse an interface', async () => {
      const code = `public interface Comparable<T> {
  int compareTo(T o);
}`;
      
      const result = await javaParser.parse(code, 'Comparable.java');
      
      expect(result.symbols.some(s => s.kind === 'interface')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'interface')?.name).toBe('Comparable');
    });
  });

  describe('parse - enums', () => {
    it('should parse an enum', async () => {
      const code = `public enum Color {
  RED,
  GREEN,
  BLUE
}`;
      
      const result = await javaParser.parse(code, 'Color.java');
      
      expect(result.symbols.some(s => s.kind === 'enum')).toBe(true);
      expect(result.symbols.find(s => s.kind === 'enum')?.name).toBe('Color');
    });
  });

  describe('parse - imports', () => {
    it('should parse import statements', async () => {
      const code = `package com.example;

import java.util.List;
import java.util.ArrayList;`;
      
      const result = await javaParser.parse(code, 'Test.java');
      
      expect(result.imports.some(i => i.module.includes('java.util.List'))).toBe(true);
    });
  });

  describe('canHandle', () => {
    it('should handle .java files', () => {
      expect(javaParser.canHandle('Test.java')).toBe(true);
      expect(javaParser.canHandle('User.java')).toBe(true);
    });

    it('should not handle non-java files', () => {
      expect(javaParser.canHandle('test.js')).toBe(false);
      expect(javaParser.canHandle('test.py')).toBe(false);
    });
  });
});
