// Shared types for lobs-memory server

export interface Config {
  port: number;
  lmstudio: {
    baseUrl: string;
    embeddingModel: string;
    chatModel: string;
  };
  reranker?: {
    mode: "lmstudio" | "none";
    lmstudio?: {
      model: string;
    };
  };
  collections: Collection[];
  search: SearchConfig;
  chunking: ChunkingConfig;
  indexing: IndexingConfig;
}

export interface Collection {
  name: string;
  path: string;
  pattern: string | string[];
}

export interface SearchConfig {
  vectorWeight: number;
  textWeight: number;
  candidateMultiplier: number;
  maxResults: number;
  mmr: { enabled: boolean; lambda: number };
  temporalDecay: { enabled: boolean; halfLifeDays: number };
  reranking: { enabled: boolean; candidateCount: number };
  queryExpansion: { 
    enabled: boolean;
    strongSignalThreshold?: number;  // BM25 score above which we skip expansion
  };
}

export interface ChunkingConfig {
  targetTokens: number;
  overlapTokens: number;
}

export interface IndexingConfig {
  debounceMs: number;
  watchEnabled: boolean;
}

// Search request/response types (what the plugin sends/receives)

export interface SearchRequest {
  query: string;
  maxResults?: number;
  minScore?: number;
  collections?: string[];
}

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
  citation: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  expandedQueries?: string[];
  timings: {
    totalMs: number;
    expansionMs?: number;
    bm25Ms: number;
    vectorMs: number;
    rerankMs?: number;
  };
}

export interface HealthResponse {
  status: "ok" | "degraded" | "error";
  uptime: number;
  models: {
    embedding: { loaded: boolean; model: string };
    reranker: { loaded: boolean; mode: string; model?: string };
    queryExpansion: { loaded: boolean; path: string };
  };
  index: {
    documents: number;
    chunks: number;
    collections: string[];
    lastUpdate: string | null;
  };
}

// Internal types

export interface Chunk {
  id?: number;
  docId: number;
  text: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

export interface ScoredChunk extends Chunk {
  path: string;
  collection: string;
  score: number;
  bm25Score?: number;
  vectorScore?: number;
  rerankScore?: number;
}
