/**
 * Cross-encoder reranker via BGE Reranker v2 M3 ONNX sidecar.
 * 
 * The sidecar runs at localhost:7421 and takes (query, documents[]) pairs,
 * returning real relevance scores from a proper cross-encoder model.
 * 
 * Auto-starts the sidecar if configured and falls back gracefully if unavailable.
 */

import { spawn, type Subprocess } from "bun";
import { join } from "path";
import type { Config } from "./types.js";

const RERANKER_URL = "http://localhost:7421";
const STARTUP_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 500;

interface RerankerState {
  configured: boolean;
  healthy: boolean;
  lastCheck: number;
  process: Subprocess | null;
  startAttempts: number;
}

const state: RerankerState = {
  configured: false,
  healthy: false,
  lastCheck: 0,
  process: null,
  startAttempts: 0,
};

export async function initReranker(config: Config): Promise<void> {
  const mode = config.reranker?.mode ?? "none";
  state.configured = mode === "sidecar";

  if (!state.configured) {
    console.log("Reranker: disabled (mode=none)");
    return;
  }

  console.log("Reranker: sidecar mode — will auto-start");
  // Try to connect to existing sidecar or start one
  await startOrConnect();
}

async function startOrConnect(): Promise<void> {
  // First check if sidecar is already running
  if (await checkHealth()) {
    console.log("Reranker: connected to existing sidecar");
    return;
  }

  // Start the sidecar
  await startSidecar();
}

async function startSidecar(): Promise<void> {
  state.startAttempts++;
  if (state.startAttempts > 3) {
    console.error("Reranker: too many start attempts, giving up");
    state.configured = false;
    return;
  }

  const scriptPath = join(import.meta.dir, "..", "scripts", "reranker-server.py");
  console.log(`Reranker: starting sidecar (attempt ${state.startAttempts})...`);

  try {
    state.process = spawn({
      cmd: ["python3", scriptPath],
      stdout: "pipe",
      stderr: "pipe",
    });

    // Stream stdout/stderr for debugging
    if (state.process.stdout) {
      const reader = (state.process.stdout as ReadableStream<Uint8Array>).getReader();
      (async () => {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value).trim();
          if (text) console.log(`[reranker] ${text}`);
        }
      })();
    }
    if (state.process.stderr) {
      const reader = (state.process.stderr as ReadableStream<Uint8Array>).getReader();
      (async () => {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value).trim();
          if (text) console.error(`[reranker/err] ${text}`);
        }
      })();
    }

    // Wait for it to become healthy
    const start = Date.now();
    while (Date.now() - start < STARTUP_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
      if (await checkHealth()) {
        console.log(`Reranker: sidecar ready (${Date.now() - start}ms startup)`);
        state.startAttempts = 0;
        return;
      }
    }

    console.error("Reranker: sidecar startup timeout");
    killSidecar();
  } catch (err) {
    console.error("Reranker: failed to start sidecar:", err);
  }
}

function killSidecar(): void {
  if (state.process) {
    try {
      state.process.kill();
    } catch {
      // Already dead
    }
    state.process = null;
  }
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${RERANKER_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const ok = res.ok;
    state.healthy = ok;
    state.lastCheck = Date.now();
    return ok;
  } catch {
    state.healthy = false;
    state.lastCheck = Date.now();
    return false;
  }
}

export function isRerankerAvailable(): boolean {
  return state.configured && state.healthy;
}

export interface RerankerResult {
  scores: number[];
  elapsed_ms: number;
}

/**
 * Rerank documents against a query using the cross-encoder sidecar.
 * Returns null if reranker is unavailable (graceful fallback).
 */
export async function rerankDocuments(
  query: string,
  documents: string[]
): Promise<RerankerResult | null> {
  if (!state.configured || documents.length === 0) return null;

  // Periodic health check (every 30s)
  if (Date.now() - state.lastCheck > 30_000) {
    await checkHealth();
  }

  if (!state.healthy) {
    // Try to restart if we're configured but unhealthy
    if (state.process === null && state.startAttempts < 3) {
      console.log("Reranker: attempting restart...");
      await startSidecar();
    }
    if (!state.healthy) return null;
  }

  try {
    const res = await fetch(`${RERANKER_URL}/rerank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, documents }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`Reranker: HTTP ${res.status}`);
      return null;
    }

    return await res.json() as RerankerResult;
  } catch (err) {
    console.error("Reranker: request failed:", err);
    state.healthy = false;
    return null;
  }
}

/**
 * Clean up the sidecar process on shutdown.
 */
export function shutdownReranker(): void {
  killSidecar();
  console.log("Reranker: shutdown");
}
