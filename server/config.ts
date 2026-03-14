/**
 * Configuration loading with priority: CLI args > env vars > config.json > defaults
 */

import { readFileSync } from "fs";
import { join } from "path";
import type { Config } from "./types.js";

function expandTilde(path: string): string {
  if (path.startsWith("~/")) {
    return join(process.env.HOME || "~", path.slice(2));
  }
  return path;
}

export function loadConfig(configPath?: string): Config {
  // Load config.json
  const defaultConfigPath = join(import.meta.dir, "..", "config.json");
  const jsonPath = expandTilde(configPath || defaultConfigPath);

  let config: Config;
  try {
    const json = readFileSync(jsonPath, "utf-8");
    config = JSON.parse(json);
  } catch (err) {
    console.warn(`Could not read config at ${jsonPath}, using defaults:`, err);
    config = getDefaultConfig();
  }

  // Environment variable overrides
  if (process.env.PORT) {
    config.port = Number(process.env.PORT);
  }
  if (process.env.LMSTUDIO_URL) {
    config.lmstudio = config.lmstudio || { baseUrl: "", embeddingModel: "", chatModel: "" };
    config.lmstudio.baseUrl = process.env.LMSTUDIO_URL;
  }
  if (process.env.EMBEDDING_MODEL) {
    config.lmstudio = config.lmstudio || { baseUrl: "", embeddingModel: "", chatModel: "" };
    config.lmstudio.embeddingModel = process.env.EMBEDDING_MODEL;
  }
  if (process.env.RERANKER_MODE) {
    config.reranker = config.reranker || { mode: "none" };
    config.reranker.mode = process.env.RERANKER_MODE as "lmstudio" | "none";
  }
  if (process.env.RERANKER_MODEL) {
    config.reranker = config.reranker || { mode: "lmstudio" };
    config.reranker.lmstudio = config.reranker.lmstudio || { model: "" };
    config.reranker.lmstudio.model = process.env.RERANKER_MODEL;
  }

  // Expand tildes in paths
  if (config.collections) {
    for (const col of config.collections) {
      col.path = expandTilde(col.path);
    }
  }

  return config;
}

function getDefaultConfig(): Config {
  return {
    port: 7420,
    lmstudio: {
      baseUrl: "http://localhost:1234/v1",
      embeddingModel: "text-embedding-nomic-embed-text-v1.5",
      chatModel: "qwen/qwen3.5-9b",
    },
    reranker: {
      mode: "lmstudio",
      lmstudio: {
        model: "qwen/qwen3.5-9b",
      },
    },
    collections: [
      {
        name: "memory",
        path: "~/.lobs/workspace",
        pattern: ["MEMORY.md", "memory/**/*.md"],
      },
    ],
    search: {
      vectorWeight: 0.7,
      textWeight: 0.3,
      candidateMultiplier: 4,
      maxResults: 8,
      mmr: { enabled: true, lambda: 0.7 },
      temporalDecay: { enabled: true, halfLifeDays: 30 },
      reranking: { enabled: true, candidateCount: 20 },
      queryExpansion: { enabled: false }, // Disabled for v1
    },
    chunking: {
      targetTokens: 400,
      overlapTokens: 80,
    },
    indexing: {
      debounceMs: 2000,
      watchEnabled: true,
    },
  };
}
