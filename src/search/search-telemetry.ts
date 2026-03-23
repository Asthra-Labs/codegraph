/**
 * Search Telemetry Types
 * 
 * Structured telemetry for active-path search timing and counts.
 * Used for performance analysis, debugging, and benchmarking.
 */

import type { QueryType, DetectionConfidence } from './query-type-detector.js';

/** Reranking method used */
export type RerankMethod = 'model' | 'heuristic' | 'none';

/** Per-phase timing metrics */
export interface SearchPhaseTimings {
  /** Query embedding generation time */
  embed_ms: number;
  
  /** Graph FTS (BM25) query time */
  graph_fts_ms: number;
  
  /** Graph vector similarity query time */
  graph_vec_ms: number;
  
  /** Retrieval document FTS query time */
  retrieval_fts_ms: number;
  
  /** Retrieval document vector query time */
  retrieval_vec_ms: number;
  
  /** RRF fusion time */
  rrf_ms: number;
  
  /** Result normalization time */
  normalize_ms: number;
  
  /** Reranking time (0 if not used) */
  rerank_ms: number;
}

/** Result counts at each pipeline stage */
export interface SearchResultCounts {
  /** Results from graph FTS */
  graph_hits: number;
  
  /** Results from retrieval FTS/vector */
  retrieval_hits: number;
  
  /** Results after RRF fusion */
  fused_hits: number;
  
  /** Results after reranking (same as fused if no rerank) */
  reranked_hits: number;
  
  /** Final results returned to caller */
  final_hits: number;
}

/** Reranking details */
export interface RerankingDetails {
  /** Method used: 'model', 'heuristic', or 'none' */
  rerank_method: RerankMethod;
  
  /** If fallback occurred, why */
  rerank_fallback_reason?: string;
  
  /** Number of candidates sent to reranker */
  rerank_input_count: number;
  
  /** Number of results after reranking */
  rerank_output_count: number;
  
  /** Model name used (if model reranker) */
  model_used?: string;
  
  /** Time to check/load model (0 for heuristic) */
  rerank_model_load_ms: number;
  
  /** Time for reranking inference (same as rerank_ms for backward compat) */
  rerank_inference_ms: number;
  
  /** Query type detected by classifier (set when rerankMethod='auto') */
  detected_query_type?: QueryType;
  
  /** Confidence of query type detection */
  detected_query_confidence?: DetectionConfidence;
  
  /** Reason for the query type classification */
  detected_query_reason?: string;
  
  /** Rerank method selected by policy (may differ from rerank_method if fallback) */
  selected_rerank_method?: RerankMethod;
}

/** Complete search telemetry */
export interface SearchTelemetry extends SearchPhaseTimings, SearchResultCounts, RerankingDetails {
  /** Total search time from entry to return */
  total_search_ms: number;
  
  /** Timestamp when search started */
  start_time: number;
  
  /** Query string (truncated if too long) */
  query?: string;
  
  /** Whether search succeeded */
  success: boolean;
  
  /** Error message if search failed */
  error?: string;
}

/** Options for telemetry collection */
export interface TelemetryOptions {
  /** Whether to collect telemetry */
  enabled?: boolean;
  
  /** Whether to include query string */
  includeQuery?: boolean;
  
  /** Max query length to store */
  maxQueryLength?: number;
}

/** Default telemetry values */
export const DEFAULT_TELEMETRY: Omit<SearchTelemetry, 'start_time'> = {
  embed_ms: 0,
  graph_fts_ms: 0,
  graph_vec_ms: 0,
  retrieval_fts_ms: 0,
  retrieval_vec_ms: 0,
  rrf_ms: 0,
  normalize_ms: 0,
  rerank_ms: 0,
  graph_hits: 0,
  retrieval_hits: 0,
  fused_hits: 0,
  reranked_hits: 0,
  final_hits: 0,
  rerank_method: 'none',
  rerank_input_count: 0,
  rerank_output_count: 0,
  rerank_model_load_ms: 0,
  rerank_inference_ms: 0,
  detected_query_type: undefined,
  detected_query_confidence: undefined,
  detected_query_reason: undefined,
  selected_rerank_method: undefined,
  total_search_ms: 0,
  success: true,
};

/** Debug logging options */
export interface DebugLogOptions {
  /** Enable debug logging */
  enabled?: boolean;
  /** Log format: 'json' or 'pretty' */
  format?: 'json' | 'pretty';
  /** Minimum total time to log (ms) */
  minDuration?: number;
}

/** Default debug options */
export const DEFAULT_DEBUG_OPTIONS: Required<DebugLogOptions> = {
  enabled: false,
  format: 'pretty',
  minDuration: 0,
};

/** Check if debug logging is enabled via environment */
export function isDebugEnabled(): boolean {
  return process.env.CODEGRAPH_DEBUG === '1' || 
         process.env.CODEGRAPH_DEBUG === 'true' ||
         process.env.DEBUG?.includes('codegraph') === true;
}

/** Format telemetry for debug output */
export function formatTelemetry(telemetry: SearchTelemetry, format: 'json' | 'pretty' = 'pretty'): string {
  if (format === 'json') {
    return JSON.stringify(telemetry);
  }
  
  const lines = [
    `[CODEGRAPH] Search Telemetry`,
    `  Total: ${telemetry.total_search_ms}ms`,
    `  Phases:`,
    `    embed: ${telemetry.embed_ms}ms`,
    `    graph_fts: ${telemetry.graph_fts_ms}ms`,
    `    graph_vec: ${telemetry.graph_vec_ms}ms`,
    `    rrf: ${telemetry.rrf_ms}ms`,
    `    normalize: ${telemetry.normalize_ms}ms`,
    `    rerank: ${telemetry.rerank_ms}ms (${telemetry.rerank_method})`,
  ];
  
  if (telemetry.rerank_method === 'model') {
    lines.push(`      model_load: ${telemetry.rerank_model_load_ms}ms`);
    lines.push(`      inference: ${telemetry.rerank_inference_ms}ms`);
    if (telemetry.model_used) {
      lines.push(`      model: ${telemetry.model_used}`);
    }
  }
  
  lines.push(
    `  Results:`,
    `    graph_hits: ${telemetry.graph_hits}`,
    `    fused_hits: ${telemetry.fused_hits}`,
    `    reranked_hits: ${telemetry.reranked_hits}`,
    `    final_hits: ${telemetry.final_hits}`,
  );
  
  if (telemetry.rerank_fallback_reason) {
    lines.push(`  Rerank fallback: ${telemetry.rerank_fallback_reason}`);
  }
  
  if (telemetry.detected_query_type) {
    lines.push(`  Query detection:`);
    lines.push(`    type: ${telemetry.detected_query_type}`);
    lines.push(`    confidence: ${telemetry.detected_query_confidence}`);
    lines.push(`    reason: ${telemetry.detected_query_reason}`);
    lines.push(`    selected_method: ${telemetry.selected_rerank_method}`);
  }
  
  if (!telemetry.success && telemetry.error) {
    lines.push(`  Error: ${telemetry.error}`);
  }
  
  return lines.join('\n');
}

/** Log telemetry if debug enabled */
export function logTelemetry(telemetry: SearchTelemetry, options: DebugLogOptions = {}): void {
  const opts = { ...DEFAULT_DEBUG_OPTIONS, ...options };
  
  if (!opts.enabled && !isDebugEnabled()) {
    return;
  }
  
  if (telemetry.total_search_ms < opts.minDuration) {
    return;
  }
  
  console.error(formatTelemetry(telemetry, opts.format));
}

/** Helper class for collecting telemetry */
export class TelemetryCollector {
  private start_time: number;
  private timings: SearchPhaseTimings;
  private counts: SearchResultCounts;
  private reranking: RerankingDetails;
  private success = true;
  private error?: string;

  constructor() {
    this.start_time = Date.now();
    this.timings = {
      embed_ms: 0,
      graph_fts_ms: 0,
      graph_vec_ms: 0,
      retrieval_fts_ms: 0,
      retrieval_vec_ms: 0,
      rrf_ms: 0,
      normalize_ms: 0,
      rerank_ms: 0,
    };
    this.counts = {
      graph_hits: 0,
      retrieval_hits: 0,
      fused_hits: 0,
      reranked_hits: 0,
      final_hits: 0,
    };
    this.reranking = {
      rerank_method: 'none',
      rerank_input_count: 0,
      rerank_output_count: 0,
      rerank_model_load_ms: 0,
      rerank_inference_ms: 0,
    };
  }

  /** Time a phase and record its duration */
  time<K extends keyof SearchPhaseTimings>(phase: K, fn: () => void): void {
    const start = Date.now();
    fn();
    this.timings[phase] = Date.now() - start;
  }

  /** Time an async phase and record its duration */
  async timeAsync<K extends keyof SearchPhaseTimings>(phase: K, fn: () => Promise<void>): Promise<void> {
    const start = Date.now();
    await fn();
    this.timings[phase] = Date.now() - start;
  }

  /** Record result count at a stage */
  setCount<K extends keyof SearchResultCounts>(stage: K, count: number): void {
    this.counts[stage] = count;
  }

  /** Set reranking details */
  setReranking(details: Partial<RerankingDetails>): void {
    this.reranking = { ...this.reranking, ...details };
    
    // Update rerank_ms to reflect total rerank stage time
    // This is the sum of model load time (if any) and inference time
    if (details.rerank_model_load_ms !== undefined || details.rerank_inference_ms !== undefined) {
      this.timings.rerank_ms = (details.rerank_model_load_ms ?? this.reranking.rerank_model_load_ms ?? 0) +
                                (details.rerank_inference_ms ?? this.reranking.rerank_inference_ms ?? 0);
    }
  }

  /** Set query type detection details */
  setQueryDetection(details: {
    queryType: QueryType;
    confidence: DetectionConfidence;
    reason: string;
    selectedMethod: RerankMethod;
  }): void {
    this.reranking.detected_query_type = details.queryType;
    this.reranking.detected_query_confidence = details.confidence;
    this.reranking.detected_query_reason = details.reason;
    this.reranking.selected_rerank_method = details.selectedMethod;
  }

  /** Mark search as failed */
  markFailed(error: string): void {
    this.success = false;
    this.error = error;
  }

  /** Build final telemetry object */
  build(query?: string, options?: TelemetryOptions): SearchTelemetry {
    const opts = { includeQuery: true, maxQueryLength: 100, ...options };
    
    return {
      ...this.timings,
      ...this.counts,
      ...this.reranking,
      start_time: this.start_time,
      total_search_ms: Date.now() - this.start_time,
      success: this.success,
      error: this.error,
      query: opts.includeQuery && query 
        ? query.substring(0, opts.maxQueryLength) 
        : undefined,
    };
  }
}
