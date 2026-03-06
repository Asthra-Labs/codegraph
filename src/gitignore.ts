/**
 * gitignore.ts - Parse and apply .gitignore patterns
 *
 * Supports standard gitignore syntax:
 * - Comments (#)
 * - Negation (!)
 * - Directory-only (trailing /)
 * - Anchored patterns (leading /)
 * - Glob patterns (*, **, ?)
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join, resolve, relative, isAbsolute } from "path";

// Simple glob matching without picomatch dependency
function minimatch(pattern: string, path: string): boolean {
  // Convert glob pattern to regex
  let regexPattern = pattern
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  
  // Handle directory-only patterns
  if (regexPattern.endsWith("/")) {
    regexPattern = regexPattern.slice(0, -1) + "(/.*)?";
  }
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(path);
}

export interface GitignorePattern {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  original: string;
}

export interface GitignoreRule {
  basePath: string;
  patterns: GitignorePattern[];
}

/**
 * Parse a single gitignore line into a pattern object
 */
function parsePattern(line: string): GitignorePattern | null {
  const trimmed = line.trim();
  
  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  
  let pattern = trimmed;
  let negated = false;
  let directoryOnly = false;
  let anchored = false;
  
  // Check for negation
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  
  // Check for directory-only (trailing /)
  if (pattern.endsWith("/")) {
    directoryOnly = true;
    pattern = pattern.slice(0, -1);
  }
  
  // Check for anchored (leading /)
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  
  return {
    pattern,
    negated,
    directoryOnly,
    anchored,
    original: trimmed,
  };
}

/**
 * Read and parse a .gitignore file
 */
export function parseGitignore(gitignorePath: string): GitignoreRule | null {
  if (!existsSync(gitignorePath)) {
    return null;
  }
  
  try {
    const content = readFileSync(gitignorePath, "utf-8");
    const lines = content.split("\n");
    const patterns: GitignorePattern[] = [];
    
    for (const line of lines) {
      const pattern = parsePattern(line);
      if (pattern) {
        patterns.push(pattern);
      }
    }
    
    return {
      basePath: resolve(gitignorePath, ".."),
      patterns,
    };
  } catch (error) {
    console.warn(`Warning: Failed to parse ${gitignorePath}: ${error}`);
    return null;
  }
}

/**
 * Find all .gitignore files from a directory up to root
 */
export function findGitignoreFiles(startPath: string): string[] {
  const gitignoreFiles: string[] = [];
  let currentPath = resolve(startPath);
  const root = resolve("/");
  
  while (currentPath !== root) {
    const gitignorePath = join(currentPath, ".gitignore");
    if (existsSync(gitignorePath)) {
      gitignoreFiles.push(gitignorePath);
    }
    const parentPath = resolve(currentPath, "..");
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }
  
  return gitignoreFiles;
}

/**
 * Load all gitignore rules for a given path
 */
export function loadGitignoreRules(path: string): GitignoreRule[] {
  const gitignoreFiles = findGitignoreFiles(path);
  const rules: GitignoreRule[] = [];
  
  for (const gitignorePath of gitignoreFiles) {
    const rule = parseGitignore(gitignorePath);
    if (rule) {
      rules.push(rule);
    }
  }
  
  return rules;
}

/**
 * Convert a gitignore pattern to a picomatch-compatible pattern
 */
function toPicomatchPattern(pattern: GitignorePattern, relativeTo: string): string {
  let result = pattern.pattern;
  
  // Handle anchored patterns (relative to the gitignore location)
  if (pattern.anchored) {
    // Already anchored, use as-is but relative to base
    result = relativeTo + "/" + result;
  } else {
    // Unanchored patterns match at any level
    // Convert to **/pattern for picomatch
    if (!result.includes("/")) {
      // Simple file/directory name - match at any depth
      result = "**/" + result;
    } else {
      // Pattern contains / but not anchored
      // It can match at root or any subdirectory
      result = "**/" + result;
    }
  }
  
  // Handle directory-only patterns
  if (pattern.directoryOnly) {
    // Directory patterns should match the directory and its contents
    result = result + "/**";
  }
  
  return result;
}

/**
 * Check if a file path should be ignored based on gitignore rules
 */
export function shouldIgnore(
  filePath: string,
  rules: GitignoreRule[],
  basePath: string
): boolean {
  const resolvedFile = resolve(filePath);
  let ignored = false;
  
  for (const rule of rules) {
    // Calculate relative path from rule's base to the file
    const relativePath = relative(rule.basePath, resolvedFile);
    
    // Skip if file is outside this rule's scope
    if (relativePath.startsWith("..")) {
      continue;
    }
    
    for (const pattern of rule.patterns) {
      const picomatchPattern = toPicomatchPattern(pattern, ".");
      
      if (minimatch(picomatchPattern, relativePath)) {
        if (pattern.negated) {
          ignored = false;
        } else {
          ignored = true;
        }
      }
    }
  }
  
  return ignored;
}

/**
 * Build a list of ignore patterns for fast-glob from gitignore rules
 * This is an optimization - we can pass these to fast-glob's ignore option
 */
export function buildIgnorePatterns(rules: GitignoreRule[]): string[] {
  const patterns: string[] = [];
  
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (pattern.negated) {
        // Negated patterns are tricky with fast-glob, skip for now
        continue;
      }
      
      const picomatchPattern = toPicomatchPattern(pattern, relative(rule.basePath, ".") || ".");
      patterns.push(picomatchPattern);
    }
  }
  
  return patterns;
}

/**
 * Get default exclusions that are always applied
 */
export function getDefaultExclusions(): string[] {
  return [
    "**/node_modules/**",
    "**/.git/**",
    "**/.cache/**",
    "**/vendor/**",
    "**/dist/**",
    "**/build/**",
    "**/.env*",
    "**/*.log",
    "**/coverage/**",
    "**/.next/**",
    "**/target/**",
    "**/__pycache__/**",
    "**/*.pyc",
    "**/.DS_Store",
  ];
}
