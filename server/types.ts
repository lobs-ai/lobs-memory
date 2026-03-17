// Shared types for lobs-memory server

export interface Config {
  port: number;
  lmstudio: {
    baseUrl: string;
    embeddingModel: string;
    chatModel: string;
  };
  reranker?: {
    mode: "sidecar" | "lmstudio" | "none";
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
  exclude?: string[];
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
  syncIntervalMs?: number;  // Background periodic sync interval (default 60000)
}

// Search request/response types (what the plugin sends/receives)

export interface SearchRequest {
  query: string;
  maxResults?: number;
  minScore?: number;
  collections?: string[];
  conversationContext?: string;  // Feature 2: bias search toward conversation topic
  entityFilter?: { type: string; value: string };  // Feature 3: filter by entity
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

// Batch search types

export interface BatchSearchItem {
  id: string;              // caller-chosen key for matching results
  query: string;
  maxResults?: number;
  minScore?: number;
  collections?: string[];
  conversationContext?: string;
}

export interface BatchSearchRequest {
  searches: BatchSearchItem[];
}

export interface BatchSearchResponse {
  results: Record<string, SearchResponse>;  // keyed by BatchSearchItem.id
  timings: { totalMs: number };
}

// Graph query types (Feature 4)

export interface GraphRequest {
  entity: string;
  depth?: number;
  type?: string;
}

export interface GraphNode {
  name: string;
  type: string;
}

export interface GraphEdge {
  from: string;
  relation: string;
  to: string;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sourceChunks: Array<{
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
  }>;
}
