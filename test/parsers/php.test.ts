import { describe, it, expect } from 'vitest';
import { phpParser } from '../../src/parsers/php.js';

describe('PHP Parser', () => {
  it('extracts class and methods', async () => {
    const code = `<?php
class UserService {
  public function createUser($name) {
    return trim($name);
  }

  private function normalize($value) {
    return strtolower($value);
  }
}
`;
    const result = await phpParser.parse(code, 'UserService.php');
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('UserService');
    expect(names).toContain('createUser');
    expect(names).toContain('normalize');
  });

  it('extracts imports and calls', async () => {
    const code = `<?php
use Carbon\\Carbon;
use Carbon\\CarbonInterval as Interval;

function build($ts) {
  $date = Carbon::parse($ts);
  return formatDate($date);
}
`;
    const result = await phpParser.parse(code, 'helpers.php');
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    expect(result.relationships.some((rel) => rel.target === 'parse')).toBe(true);
    expect(result.relationships.some((rel) => rel.target === 'formatDate')).toBe(true);
  });

  it('supports .php and .phtml extensions', () => {
    expect(phpParser.canHandle('index.php')).toBe(true);
    expect(phpParser.canHandle('layout.phtml')).toBe(true);
    expect(phpParser.canHandle('main.rb')).toBe(false);
  });
});
