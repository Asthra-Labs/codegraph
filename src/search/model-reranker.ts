/**
 * Model Reranker Adapter
 *
 * Thin adapter layer wrapping LlamaCpp.rerank() for use by shared-reranker.ts.
 * This avoids direct coupling to store.ts internals and provides a clean interface
 * for model-based reranking.
 *
 * Model: Qwen3-Reranker-0.6B (default)
 * Backend: llama.cpp via LlamaCpp class
 */

import type { LlamaCpp } from '../llm.js';
import { getDefaultLlamaCpp, withLLMSession } from '../llm.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Input format for model reranker (matches shared-reranker.ts RerankInput)
 */
export interface ModelRerankInput {
  id: string;
  filePath: string;
  symbolName?: string;
  symbolKind?: string;
  signature?: string;
  className?: string;
  content?: string;
  snippet?: string;
  score: number;
}

/**
 * Output format from model reranker
 */
export interface ModelRerankOutput {
  id: string;
  score: number;
  index: number;
}

/**
 * Options for model reranking
 */
export interface ModelRerankOptions {
  topK?: number;
  model?: string;
  batchSize?: number;
}

/**
 * Internal format for LlamaCpp.rerank()
 */
interface RerankDocument {
  file: string;
  text: string;
  title?: string;
}

/**
 * Result from LlamaCpp.rerank()
 */
interface RerankDocumentResult {
  file: string;
  score: number;
  index: number;
}

/**
 * Status of model reranker availability
 */
export interface ModelRerankerStatus {
  available: boolean;
  status: 'ready' | 'loading' | 'not_available' | 'error';
  model?: string;
  error?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Default model for reranking
 */
export const DEFAULT_MODEL_RERANK_MODEL = 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf';

/**
 * Default batch size for reranking (conservative)
 */
export const DEFAULT_MODEL_RERANK_BATCH_SIZE = 20;

// ============================================================================
// ADAPTER FUNCTIONS
// ============================================================================

/**
 * Convert ModelRerankInput to RerankDocument format for LlamaCpp
 */
function toRerankDocuments(inputs: ModelRerankInput[]): RerankDocument[] {
  return inputs.map((input) => {
    // Build text representation for reranking
    // Priority: content > snippet > signature > symbolName
    const textParts: string[] = [];
    
    if (input.content) {
      textParts.push(input.content);
    } else if (input.snippet) {
      textParts.push(input.snippet);
    }
    
    // Add signature if available (helps with function matching)
    if (input.signature) {
      textParts.unshift(input.signature);
    }
    
    // Fallback to symbol info if no content
    if (textParts.length === 0) {
      if (input.symbolName) {
        textParts.push(input.symbolName);
      }
      if (input.symbolKind) {
        textParts.unshift(input.symbolKind);
      }
    }
    
    // Build title from symbol info
    const titleParts: string[] = [];
    if (input.symbolKind) {
      titleParts.push(input.symbolKind);
    }
    if (input.symbolName) {
      titleParts.push(input.symbolName);
    }
    if (input.className) {
      titleParts.push(`in ${input.className}`);
    }
    
    return {
      file: input.id,
      text: textParts.join('\n') || input.filePath,
      title: titleParts.length > 0 ? titleParts.join(' ') : input.filePath,
    };
  });
}

/**
 * Check if model reranker is available
 */
export async function checkModelRerankerAvailable(): Promise<ModelRerankerStatus> {
  try {
    const llama = await getDefaultLlamaCpp();
    if (!llama) {
      return { available: false, status: 'not_available', error: 'LlamaCpp not initialized' };
    }
    
    // Check if rerank method exists
    if (typeof llama.rerank !== 'function') {
      return { available: false, status: 'not_available', error: 'rerank method not available' };
    }
    
    return { 
      available: true, 
      status: 'ready',
      model: DEFAULT_MODEL_RERANK_MODEL,
    };
  } catch (error) {
    return { 
      available: false, 
      status: 'error', 
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run model-based reranking using LlamaCpp
 *
 * @param query - The search query
 * @param inputs - Results to rerank
 * @param options - Reranking options
 * @returns Reranked results with scores, or null if model unavailable
 */
export async function runModelRerank(
  query: string,
  inputs: ModelRerankInput[],
  options: ModelRerankOptions = {}
): Promise<ModelRerankOutput[] | null> {
  const {
    topK = DEFAULT_MODEL_RERANK_BATCH_SIZE,
    model = DEFAULT_MODEL_RERANK_MODEL,
  } = options;

  if (inputs.length === 0) {
    return [];
  }

  // Limit to topK candidates
  const candidates = inputs.slice(0, topK);
  
  try {
    const llama = await getDefaultLlamaCpp();
    if (!llama || typeof llama.rerank !== 'function') {
      return null;
    }

    // Convert to LlamaCpp format
    const documents = toRerankDocuments(candidates);
    
    // Run reranking
    const result = await llama.rerank(query, documents, {
      model,
    });
    
    if (!result || !result.results) {
      return null;
    }
    
    // Map results back to our format
    const outputs: ModelRerankOutput[] = result.results.map((r: RerankDocumentResult) => ({
      id: r.file,
      score: r.score,
      index: r.index,
    }));
    
    // Sort by score descending
    outputs.sort((a, b) => b.score - a.score);
    
    return outputs;
  } catch (error) {
    // Log error but don't throw - allow fallback to heuristic
    console.error('[model-reranker] Reranking failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Get cached model reranker status (synchronous, may be stale)
 */
export function getModelRerankerStatusSync(): ModelRerankerStatus {
  // This is a quick synchronous check - actual availability checked at runtime
  return {
    available: true, // Assume available, will be verified at runtime
    status: 'ready',
    model: DEFAULT_MODEL_RERANK_MODEL,
  };
}
