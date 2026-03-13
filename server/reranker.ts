/**
 * Cross-encoder reranker via BGE Reranker v2 M3 ONNX sidecar.
 * 
 * The sidecar runs at localhost:7421 and takes (query, documents[]) pairs,
 * returning real relevance scores from a proper cross-encoder model.
 * 
 * Falls back gracefully if the sidecar isn't running.
 */

import type { Config } from "./types.js";

const RERANKER_URL = "http://localhost:7421";

interface RerankerState {
  config: Config | null;
  available: boolean;
  error?: string;
}

const state: RerankerState = {
  config: null,
  available: false,
};

/**
 * Initialize reranker. Check if the ONNX sidecar is running.
 */
export async function initReranker(config: Config): Promise<void> {
  state.config = config;

  if (!config.reranker?.mode || config.reranker.mode === "none") {
    console.warn("Reranker disabled (mode=none)");
    state.available = false;
    return;
  }

  if (config.reranker.mode === "onnx-sidecar") {
    try {
      const response = await fetch(`${RERANKER_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error(`Sidecar returned ${response.status}`);
      const data = await response.json() as { status: string; model: string };
      state.available = true;
      console.log(`Reranker ready (ONNX sidecar: ${data.model})`);
    } catch (err) {
      console.warn(`⚠️  Reranker sidecar unavailable: ${err instanceof Error ? err.message : String(err)}`);
      state.available = false;
      state.error = err instanceof Error ? err.message : String(err);
    }
  } else if (config.reranker.mode === "lmstudio") {
    // Legacy LM Studio mode — kept for reference but not recommended
    // (1.5B models can't do relevance scoring, they just count)
    console.warn("Reranker: LM Studio mode not recommended (use onnx-sidecar instead)");
    state.available = false;
  } else {
    console.warn(`Unknown reranker mode: ${config.reranker.mode}`);
    state.available = false;
  }
}

/**
 * Score a batch of (query, document) pairs using the ONNX cross-encoder sidecar.
 * Returns raw logit scores (higher = more relevant, can be negative).
 */
export async function scoreRelevanceBatch(query: string, documents: string[]): Promise<number[]> {
  if (!state.available || !state.config) {
    return documents.map(() => 0);
  }

  if (documents.length === 0) return [];

  try {
    const response = await fetch(`${RERANKER_URL}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        documents: documents.map(d => d.split(/\s+/).slice(0, 60).join(" ")), // First ~60 words
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      console.error(`Reranker sidecar error: ${response.status}`);
      return documents.map(() => 0);
    }

    const data = await response.json() as { scores: number[]; elapsed_ms: number };
    console.log(`  Reranking: ${data.elapsed_ms}ms for ${documents.length} docs`);
    return data.scores;
  } catch (err) {
    console.warn(`Reranking error: ${err instanceof Error ? err.message : String(err)}`);
    return documents.map(() => 0);
  }
}

export function isRerankerAvailable(): boolean {
  return state.available;
}

export function getRerankerStatus(): { available: boolean; error?: string; mode?: string } {
  return {
    available: state.available,
    error: state.error,
    mode: state.config?.reranker?.mode || "none",
  };
}

export async function disposeReranker(): Promise<void> {
  state.config = null;
  state.available = false;
}
