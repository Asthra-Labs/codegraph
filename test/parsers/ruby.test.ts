import { describe, it, expect } from 'vitest';
import { rubyParser } from '../../src/parsers/ruby.js';

describe('Ruby Parser', () => {
  it('extracts class and methods', async () => {
    const code = `class PaymentService
  def process(amount)
    format(amount)
  end

  def format(value)
    value.to_s
  end
end
`;
    const result = await rubyParser.parse(code, 'payment_service.rb');
    const names = result.symbols.map((s) => s.name);
    expect(names).toContain('PaymentService');
    expect(names).toContain('process');
    expect(names).toContain('format');
  });

  it('extracts require imports', async () => {
    const code = `require 'json'
require_relative 'support/helpers'

def serialize(data)
  JSON.generate(data)
end
`;
    const result = await rubyParser.parse(code, 'serialize.rb');
    expect(result.imports.length).toBe(2);
    expect(result.imports[0]?.module).toBe('json');
  });

  it('supports .rb extension', () => {
    expect(rubyParser.canHandle('service.rb')).toBe(true);
    expect(rubyParser.canHandle('service.php')).toBe(false);
  });
});
