/**
 * Cross-encoder reranker via node-llama-cpp
 */

import { getLlama, LlamaChatSession, LlamaContext, LlamaModel } from "node-llama-cpp";
import { existsSync } from "fs";
import type { Config } from "./types.js";

interface RerankerState {
  model: LlamaModel | null;
  context: LlamaContext | null;
  available: boolean;
  error?: string;
}

const state: RerankerState = {
  model: null,
  context: null,
  available: false,
};

/**
 * Initialize reranker model. Gracefully skip if model not found.
 */
export async function initReranker(config: Config): Promise<void> {
  const modelPath = config.models.reranker;

  // Check if reranker is configured and file exists
  if (!modelPath || modelPath.trim() === "") {
    console.warn("Reranker model path not configured, reranking will be skipped");
    state.available = false;
    return;
  }

  if (!existsSync(modelPath)) {
    console.warn(`Reranker model not found at ${modelPath}, reranking will be skipped`);
    state.available = false;
    state.error = "Model file not found";
    return;
  }

  try {
    console.log(`Loading reranker model from ${modelPath}...`);
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext({ contextSize: 2048 });

    state.model = model;
    state.context = context;
    state.available = true;

    console.log("Reranker model loaded successfully");
  } catch (err) {
    console.error("Failed to load reranker model:", err);
    state.available = false;
    state.error = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Score a (query, document) pair. Returns a relevance score (higher = more relevant).
 */
export async function scoreRelevance(query: string, document: string): Promise<number> {
  if (!state.available || !state.context || !state.model) {
    throw new Error("Reranker not available");
  }

  try {
    // Cross-encoder prompt format for reranking
    const prompt = `Query: ${query}\nDocument: ${document}\nRelevance:`;

    const session = new LlamaChatSession({ contextSequence: state.context.getSequence() });
    const response = await session.prompt(prompt, {
      maxTokens: 10,
      temperature: 0.1,
    });

    // Parse score from response (expecting a number)
    // Cross-encoders typically output a relevance score
    const scoreMatch = response.match(/(\d+\.?\d*)/);
    if (scoreMatch) {
      return parseFloat(scoreMatch[1]);
    }

    // Fallback: use response length as a proxy (longer = more relevant)
    return response.length / 100;
  } catch (err) {
    console.error("Reranking error:", err);
    return 0;
  }
}

/**
 * Batch score multiple (query, document) pairs
 */
export async function scoreRelevanceBatch(query: string, documents: string[]): Promise<number[]> {
  if (!state.available) {
    // Return zeros if reranker not available
    return documents.map(() => 0);
  }

  const scores: number[] = [];
  for (const doc of documents) {
    try {
      const score = await scoreRelevance(query, doc);
      scores.push(score);
    } catch (err) {
      console.error("Error scoring document:", err);
      scores.push(0);
    }
  }

  return scores;
}

/**
 * Check if reranker is available
 */
export function isRerankerAvailable(): boolean {
  return state.available;
}

/**
 * Get reranker status
 */
export function getRerankerStatus(): { available: boolean; error?: string } {
  return {
    available: state.available,
    error: state.error,
  };
}

/**
 * Dispose of reranker resources
 */
export async function disposeReranker(): Promise<void> {
  if (state.context) {
    state.context.dispose();
  }
  if (state.model) {
    state.model.dispose();
  }
  state.model = null;
  state.context = null;
  state.available = false;
}
