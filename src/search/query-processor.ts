export type QueryIntent = 
  | 'exact_symbol'
  | 'semantic'
  | 'usage'
  | 'navigation'
  | 'definition'
  | 'hybrid';

export interface ProcessedQuery {
  original: string;
  normalized: string;
  expandedTerms: string[];
  identifiers: string[];
  paths: string[];
  intent: QueryIntent;
  routingHints: RoutingHints;
}

export interface RoutingHints {
  preferExactMatch: boolean;
  preferVectorSearch: boolean;
  preferGraphExpansion: boolean;
  includeCallers: boolean;
  includeCallees: boolean;
  includeRelated: boolean;
  weightBoost: {
    fts: number;
    vector: number;
    graph: number;
  };
}

export interface QueryProcessingOptions {
  expandCamelCase: boolean;
  expandSnakeCase: boolean;
  expandKebabCase: boolean;
  preserveExactIdentifiers: boolean;
  expandPaths: boolean;
  detectIntent: boolean;
}

export const DEFAULT_PROCESSING_OPTIONS: QueryProcessingOptions = {
  expandCamelCase: true,
  expandSnakeCase: true,
  expandKebabCase: true,
  preserveExactIdentifiers: true,
  expandPaths: true,
  detectIntent: true,
};

const SEMANTIC_EXPANSION_MAP: Record<string, string[]> = {
  'retry': ['backoff', 'exponential', 'timeout', 'reattempt', 'resilience'],
  'backoff': ['retry', 'exponential', 'delay', 'jitter', 'throttle'],
  'timeout': ['deadline', 'cancel', 'abort', 'timeoutms', 'duration'],
  'auth': ['authentication', 'login', 'session', 'token', 'credential', 'oauth', 'jwt'],
  'authentication': ['auth', 'login', 'signin', 'credential', 'identity'],
  'permission': ['authorization', 'access', 'role', 'privilege', 'acl', 'rbac'],
  'authorization': ['permission', 'access', 'role', 'privilege', 'policy'],
  'validation': ['validate', 'sanitize', 'check', 'verify', 'schema', 'input'],
  'sanitize': ['validation', 'escape', 'clean', 'filter', 'xss', 'injection'],
  'cache': ['caching', 'memoize', 'ttl', 'expiry', 'invalidate', 'lru', 'redis'],
  'ttl': ['cache', 'expiry', 'expire', 'timeout', 'eviction'],
  'database': ['db', 'sql', 'query', 'transaction', 'pool', 'connection', 'postgres', 'mysql'],
  'transaction': ['atomic', 'commit', 'rollback', 'database', 'acid'],
  'error': ['exception', 'error', 'failure', 'throw', 'catch', 'handle'],
  'exception': ['error', 'throw', 'catch', 'try', 'failure'],
  'logging': ['log', 'logger', 'debug', 'trace', 'audit', 'monitor'],
  'config': ['configuration', 'settings', 'env', 'environment', 'options'],
  'http': ['request', 'response', 'api', 'rest', 'fetch', 'client', 'server'],
  'request': ['http', 'api', 'fetch', 'call', 'client'],
  'response': ['http', 'result', 'return', 'data', 'body'],
  'queue': ['message', 'broker', 'async', 'worker', 'job', 'kafka', 'rabbitmq'],
  'encrypt': ['crypto', 'cipher', 'decrypt', 'security', 'hash', 'aes', 'rsa'],
  'decrypt': ['encrypt', 'crypto', 'cipher', 'security'],
  'security': ['crypto', 'encrypt', 'auth', 'token', 'secure', 'ssl', 'tls'],
  'date': ['time', 'datetime', 'timestamp', 'format', 'parse', 'utc', 'timezone'],
  'time': ['date', 'datetime', 'timestamp', 'duration', 'interval'],
  'user': ['account', 'profile', 'identity', 'customer', 'member'],
  'file': ['filesystem', 'path', 'read', 'write', 'disk', 'storage'],
  'test': ['spec', 'mock', 'fixture', 'assert', 'expect', 'jest', 'mocha'],
};

function expandSemanticTerms(query: string): string[] {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/);
  const expanded = new Set<string>();

  for (const word of words) {
    expanded.add(word);
    const expansions = SEMANTIC_EXPANSION_MAP[word];
    if (expansions) {
      expansions.forEach(e => expanded.add(e));
    }
  }

  return Array.from(expanded);
}

export function processQuery(
  query: string,
  options: QueryProcessingOptions = DEFAULT_PROCESSING_OPTIONS
): ProcessedQuery {
  const trimmed = query.trim();
  
  const identifiers = extractIdentifiers(trimmed);
  const paths = extractPaths(trimmed);
  const expandedTerms = expandQueryTerms(trimmed, options);
  const normalized = normalizeQuery(trimmed, options);
  const intent = options.detectIntent ? detectIntent(trimmed, identifiers, paths) : 'hybrid';
  const routingHints = computeRoutingHints(intent, identifiers, paths);

  return {
    original: trimmed,
    normalized,
    expandedTerms,
    identifiers,
    paths,
    intent,
    routingHints,
  };
}

export function extractIdentifiers(query: string): string[] {
  const identifiers: string[] = [];
  const seen = new Set<string>();

  const camelCasePattern = /\b[a-z][a-z0-9]*([A-Z][a-z0-9]*)+\b/g;
  let match;
  while ((match = camelCasePattern.exec(query)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      identifiers.push(match[0]);
    }
  }

  const pascalCasePattern = /\b[A-Z][a-z0-9]*([A-Z][a-z0-9]*)+\b/g;
  while ((match = pascalCasePattern.exec(query)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      identifiers.push(match[0]);
    }
  }

  const snakeCasePattern = /\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b/g;
  while ((match = snakeCasePattern.exec(query)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      identifiers.push(match[0]);
    }
  }

  const screamingSnakePattern = /\b[A-Z][A-Z0-9]*(_[A-Z0-9]+)+\b/g;
  while ((match = screamingSnakePattern.exec(query)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      identifiers.push(match[0]);
    }
  }

  const constantPattern = /\b[A-Z][A-Z0-9]{2,}\b/g;
  while ((match = constantPattern.exec(query)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      identifiers.push(match[0]);
    }
  }

  return identifiers;
}

function extractPaths(query: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  const unixPathPattern = /(?:^|\s)([a-zA-Z0-9_\-./]+\/[a-zA-Z0-9_\-./]+)(?:\s|$)/g;
  const windowsPathPattern = /(?:^|\s)([a-zA-Z]:\\[a-zA-Z0-9_\-./\\]+)(?:\s|$)/g;
  const modulePathPattern = /@?[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-./]+/g;

  let match;
  while ((match = unixPathPattern.exec(query)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      paths.push(match[1]);
    }
  }

  while ((match = windowsPathPattern.exec(query)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      paths.push(match[1]);
    }
  }

  while ((match = modulePathPattern.exec(query)) !== null) {
    if (!seen.has(match[0]) && !match[0].startsWith('@')) {
      seen.add(match[0]);
      paths.push(match[0]);
    }
  }

  return paths;
}

function expandQueryTerms(query: string, options: QueryProcessingOptions): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  const addTerm = (term: string) => {
    const lower = term.toLowerCase();
    if (!seen.has(lower) && lower.length > 1) {
      seen.add(lower);
      terms.push(lower);
    }
  };

  const words = query.split(/\s+/);
  for (const word of words) {
    addTerm(word);

    const semanticExpansions = SEMANTIC_EXPANSION_MAP[word.toLowerCase()];
    if (semanticExpansions) {
      for (const expansion of semanticExpansions) {
        addTerm(expansion);
      }
    }

    if (options.expandCamelCase) {
      const camelParts = splitCamelCase(word);
      for (const part of camelParts) {
        addTerm(part);
      }
    }

    if (options.expandSnakeCase) {
      const snakeParts = splitSnakeCase(word);
      for (const part of snakeParts) {
        addTerm(part);
      }
    }

    if (options.expandKebabCase) {
      const kebabParts = splitKebabCase(word);
      for (const part of kebabParts) {
        addTerm(part);
      }
    }
  }

  return terms;
}

function normalizeQuery(query: string, options: QueryProcessingOptions): string {
  let normalized = query;

  if (options.expandCamelCase || options.expandSnakeCase || options.expandKebabCase) {
    const words = normalized.split(/\s+/);
    const expanded: string[] = [];

    for (const word of words) {
      expanded.push(word);

      if (!options.preserveExactIdentifiers || !looksLikeIdentifier(word)) {
        const parts: string[] = [];

        if (options.expandCamelCase) {
          parts.push(...splitCamelCase(word));
        }
        if (options.expandSnakeCase) {
          parts.push(...splitSnakeCase(word));
        }
        if (options.expandKebabCase) {
          parts.push(...splitKebabCase(word));
        }

        const uniqueParts = [...new Set(parts)].filter(p => p.length > 1 && p.toLowerCase() !== word.toLowerCase());
        if (uniqueParts.length > 0) {
          expanded.push(...uniqueParts);
        }
      }
    }

    normalized = [...new Set(expanded)].join(' ');
  }

  return normalized;
}

function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(s => s.length > 0);
}

function splitSnakeCase(str: string): string[] {
  return str.split('_').filter(s => s.length > 0);
}

function splitKebabCase(str: string): string[] {
  return str.split('-').filter(s => s.length > 0);
}

function looksLikeIdentifier(word: string): boolean {
  return /^[@_$a-zA-Z][_$a-zA-Z0-9]*$/.test(word);
}

function detectIntent(query: string, identifiers: string[], paths: string[]): QueryIntent {
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/);

  if (identifiers.length === 1 && words.length === 1 && !paths.length) {
    const id = identifiers[0];
    if (id && /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(id)) {
      return 'exact_symbol';
    }
  }

  const definitionKeywords = ['define', 'definition', 'declaration', 'declare', 'interface', 'class', 'type', 'function'];
  if (words.some(w => definitionKeywords.includes(w))) {
    return 'definition';
  }

  const usageKeywords = ['who uses', 'where used', 'callers of', 'who calls', 'references to', 'where is', 'find usages'];
  if (usageKeywords.some(kw => lower.includes(kw))) {
    return 'usage';
  }

  const navigationKeywords = ['go to', 'open', 'show me', 'find file', 'navigate to', 'jump to'];
  if (navigationKeywords.some(kw => lower.includes(kw))) {
    return 'navigation';
  }

  const semanticKeywords = ['how do i', 'how to', 'what does', 'explain', 'example of', 'implement', 'create'];
  if (semanticKeywords.some(kw => lower.includes(kw))) {
    return 'semantic';
  }

  if (paths.length > 0) {
    return 'navigation';
  }

  return 'hybrid';
}

function computeRoutingHints(intent: QueryIntent, identifiers: string[], paths: string[]): RoutingHints {
  const base: RoutingHints = {
    preferExactMatch: false,
    preferVectorSearch: false,
    preferGraphExpansion: false,
    includeCallers: false,
    includeCallees: false,
    includeRelated: false,
    weightBoost: { fts: 1.0, vector: 1.0, graph: 1.0 },
  };

  switch (intent) {
    case 'exact_symbol':
      return {
        ...base,
        preferExactMatch: true,
        weightBoost: { fts: 1.5, vector: 0.8, graph: 0.7 },
      };

    case 'definition':
      return {
        ...base,
        preferExactMatch: true,
        includeRelated: true,
        weightBoost: { fts: 1.3, vector: 0.9, graph: 0.8 },
      };

    case 'usage':
      return {
        ...base,
        preferGraphExpansion: true,
        includeCallers: true,
        weightBoost: { fts: 1.0, vector: 0.7, graph: 1.5 },
      };

    case 'navigation':
      return {
        ...base,
        preferExactMatch: paths.length > 0,
        weightBoost: { fts: 1.3, vector: 0.8, graph: 0.9 },
      };

    case 'semantic':
      return {
        ...base,
        preferVectorSearch: true,
        includeRelated: true,
        weightBoost: { fts: 0.8, vector: 1.5, graph: 0.7 },
      };

    case 'hybrid':
    default:
      return {
        ...base,
        includeRelated: identifiers.length > 0,
        weightBoost: { fts: 1.0, vector: 1.0, graph: 1.0 },
      };
  }
}
