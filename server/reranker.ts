/**
 * Cross-encoder reranker via LM Studio chat API (batched scoring)
 */

import type { Config } from "./types.js";

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
 * Initialize reranker. Check if LM Studio is reachable and config is valid.
 */
export async function initReranker(config: Config): Promise<void> {
  state.config = config;

  // Check reranker mode
  if (!config.reranker?.mode || config.reranker.mode === "none") {
    console.warn("Reranker disabled (mode=none)");
    state.available = false;
    return;
  }

  if (config.reranker.mode === "lmstudio") {
    // Check if LM Studio is reachable
    try {
      const url = `${config.lmstudio.baseUrl}/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.reranker.lmstudio?.model || config.lmstudio.chatModel,
          messages: [{ role: "user", content: "test" }],
          max_tokens: 1,
          temperature: 0,
        }),
      });

      if (!response.ok) {
        throw new Error(`LM Studio returned status ${response.status}`);
      }

      state.available = true;
      console.log(`Reranker ready (LM Studio: ${config.reranker.lmstudio?.model || config.lmstudio.chatModel})`);
    } catch (err) {
      console.warn(`⚠️  Reranker unavailable: ${err instanceof Error ? err.message : String(err)}`);
      state.available = false;
      state.error = err instanceof Error ? err.message : String(err);
    }
  } else {
    console.warn(`Unknown reranker mode: ${config.reranker.mode}`);
    state.available = false;
    state.error = "Unknown reranker mode";
  }
}

/**
 * Score a batch of (query, document) pairs using a single LM Studio chat API call.
 * Much more efficient than N sequential calls.
 */
export async function scoreRelevanceBatch(query: string, documents: string[]): Promise<number[]> {
  if (!state.available || !state.config) {
    // Return zeros if reranker not available
    return documents.map(() => 0);
  }

  if (documents.length === 0) {
    return [];
  }

  const startTime = Date.now();
  const timeoutMs = 3000; // 3s budget

  try {
    // Build batched prompt with all documents
    const docSnippets = documents.map((doc, i) => {
      const snippet = doc.split(/\s+/).slice(0, 50).join(" "); // First ~50 words
      return `Doc ${i + 1}: ${snippet}`;
    });

    const userPrompt = `Rate how relevant each document is to the query on a scale of 0-10. Reply with ONLY comma-separated numbers, one per document.

Query: ${query}

${docSnippets.join("\n\n")}`;

    const url = `${state.config.lmstudio.baseUrl}/chat/completions`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: state.config.reranker.lmstudio?.model || state.config.lmstudio.chatModel,
        messages: [
          { role: "user", content: userPrompt },
          { role: "assistant", content: "Scores:" }, // Assistant prefill
        ],
        max_tokens: 50,
        temperature: 0,
        stop: ["\n\n"],
      }),
    });

    if (!response.ok) {
      console.error(`Reranker API error: ${response.status}`);
      return documents.map(() => 0);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content?.trim() || "";

    // Parse comma-separated scores
    const scoresText = content.replace(/^Scores:\s*/i, "").trim();
    const scoreParts = scoresText.split(/[\s,]+/).filter(s => s.length > 0);

    const scores: number[] = [];
    for (let i = 0; i < documents.length; i++) {
      if (i < scoreParts.length) {
        const match = scoreParts[i].match(/(\d+\.?\d*)/);
        if (match) {
          const score = parseFloat(match[1]);
          scores.push(Math.min(10, Math.max(0, score))); // Clamp to [0, 10]
        } else {
          scores.push(0);
        }
      } else {
        scores.push(0);
      }
    }

    console.log(`  Reranking: ${elapsed}ms for ${documents.length} docs`);
    return scores;

  } catch (err) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      console.warn(`⚠️  Reranker timeout (${elapsed}ms), skipping reranking`);
    } else {
      console.error("Reranking error:", err);
    }
    return documents.map(() => 0);
  }
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
export function getRerankerStatus(): { available: boolean; error?: string; mode?: string } {
  return {
    available: state.available,
    error: state.error,
    mode: state.config?.reranker?.mode || "none",
  };
}

/**
 * Dispose of reranker resources (no-op for LM Studio mode)
 */
export async function disposeReranker(): Promise<void> {
  state.config = null;
  state.available = false;
}
