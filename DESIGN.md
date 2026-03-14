# Design: lobs-memory

## Problem

lobs memory search has two backends:
1. **Builtin** — fast (sub-ms) but basic (BM25 + cosine, no reranking, no query expansion)
2. **QMD** — high quality (reranking + expansion + hybrid) but cold-starts models every CLI call (~3.2s)

We need: QMD quality + builtin speed.

## Solution

Persistent HTTP server that keeps all models loaded in memory. lobs plugin routes `memory_search` calls to the server instead of shelling out to QMD CLI.

## Key Design Decisions

### Runtime: Bun
- Fast startup, native TypeScript, good FFI
- QMD already uses Bun + node-llama-cpp, proven combo on this machine
- Alternative considered: Node.js (heavier), Python (FastAPI + sentence-transformers — more deps)

### Models: LM Studio + node-llama-cpp hybrid
- **Embeddings**: LM Studio API (localhost:1234) — nomic-embed-text-v1.5 already loaded, 23ms per call, 768-dim
- **Query expansion**: LM Studio API — qwen3.5-9b chat model (already loaded, just text generation)
- **Reranker**: node-llama-cpp in-process — qwen3-reranker-0.6b GGUF (cross-encoders aren't supported by LM Studio's OpenAI-compatible API)
- This means only one GGUF model loaded in the server process (~639MB), everything else hits LM Studio
- LM Studio is already running and keeps models hot — zero additional overhead

### Storage: SQLite + FTS5 + sqlite-vec
- Single file, portable, proven
- FTS5 for BM25 keyword search
- sqlite-vec for accelerated vector distance queries
- Embedding cache: don't re-embed unchanged chunks

### Query Priority
- Server maintains two queues: search (high priority) and index (low priority)
- Incoming search requests preempt indexing work
- Indexing pauses during search, resumes after
- Implementation: simple mutex/semaphore on model access

### File Watching
- chokidar watches configured directories
- Debounced (configurable, default 2s)
- Changed files re-chunked and re-embedded in background
- Deletions remove chunks from index

## Search Pipeline Detail

### 1. Query Expansion
- Input: raw query string
- Model: qmd-query-expansion-1.7B (instruction-tuned for search queries)
- Output: 2-3 alternative phrasings
- All phrasings searched in parallel (BM25 + vector)
- Can be disabled for speed (config flag)

### 2. BM25 Keyword Search
- SQLite FTS5 on chunk text
- Score: `1 / (1 + max(0, bm25Rank))`
- Returns top `maxResults * candidateMultiplier` candidates

### 3. Vector Similarity Search
- Embed query with embeddinggemma-300M
- Cosine similarity against stored embeddings (sqlite-vec)
- Returns top `maxResults * candidateMultiplier` candidates

### 4. Weighted Merge
- Union candidates by chunk ID
- `finalScore = vectorWeight * vectorScore + textWeight * textScore`
- Default: 0.7 vector, 0.3 text

### 5. Neural Reranking
- Take top-K merged results (default 20)
- Score each (query, chunk) pair with qwen3-reranker cross-encoder
- Re-sort by reranker score
- This is the biggest quality win — cross-encoders are much more accurate than bi-encoder similarity

### 6. MMR Diversity
- Iteratively select results that maximize relevance while minimizing similarity to already-selected results
- Lambda: 0.7 (slight relevance bias)
- Uses Jaccard text similarity between chunks

### 7. Temporal Decay
- Exponential decay: `score *= e^(-λ * ageInDays)` where λ = ln(2)/halfLifeDays
- Dated files (YYYY-MM-DD.md) use filename date
- Evergreen files (MEMORY.md, non-dated) skip decay
- Default half-life: 30 days

### 8. Return Top-K
- Default: 8 results
- Each result: `{ path, startLine, endLine, score, snippet, source, citation }`

## lobs Plugin

### Tool Registration
```typescript
// memory_search → HTTP POST to server
api.registerTool((ctx) => {
  return [{
    name: "memory_search",
    description: "Semantically search memory files...",
    parameters: { query: string, maxResults?: number, minScore?: number },
    handler: async (params) => {
      const res = await fetch(`${serverUrl}/search`, {
        method: "POST",
        body: JSON.stringify(params)
      });
      return res.json();
    }
  }, {
    name: "memory_get",
    description: "Read memory file content...",
    parameters: { path: string, from?: number, lines?: number },
    handler: async (params) => {
      // Read file directly, same as builtin
      return readMemoryFile(params, ctx.config);
    }
  }];
}, { names: ["memory_search", "memory_get"] });
```

### Config Schema
```json
{
  "type": "object",
  "properties": {
    "serverUrl": { "type": "string", "default": "http://localhost:7420" },
    "enabled": { "type": "boolean", "default": true },
    "timeoutMs": { "type": "number", "default": 5000 },
    "fallbackToBuiltin": { "type": "boolean", "default": true }
  }
}
```

### Fallback Behavior
- If server is unreachable, fall back to lobs's builtin memory search
- Log warning so we know something's wrong
- Health check on plugin init to verify server is running

## Server Lifecycle

### Startup
1. Load config
2. Initialize SQLite database (create tables if needed)
3. Load embedding model (GGUF → node-llama-cpp)
4. Load reranker model
5. Load query expansion model
6. Start file watchers on configured collections
7. Run initial index sync (background)
8. Start HTTP server on configured port
9. Log readiness + model info

### Shutdown (SIGTERM/SIGINT)
1. Stop accepting new requests
2. Flush any pending index writes
3. Dispose llama.cpp contexts
4. Close SQLite
5. Exit

### Running as a Service
- launchd plist for macOS (auto-start on boot)
- Or just run in tmux/screen
- Health endpoint for monitoring

## Database Schema

```sql
-- Documents (source files)
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  collection TEXT NOT NULL,
  mtime REAL NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Chunks (text segments)
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  token_count INTEGER NOT NULL
);

-- FTS5 for BM25
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content=chunks, content_rowid=id);

-- Embeddings (sqlite-vec)
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[768]
);

-- Embedding cache (avoid re-embedding unchanged text)
CREATE TABLE embedding_cache (
  text_hash TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## File Structure

```
lobs-memory/
├── server/
│   ├── index.ts          # Entry point, HTTP server
│   ├── config.ts         # Config loading
│   ├── db.ts             # SQLite setup + queries
│   ├── chunker.ts        # Markdown chunking
│   ├── embedder.ts       # Embedding model wrapper
│   ├── reranker.ts       # Reranker model wrapper
│   ├── expander.ts       # Query expansion model wrapper
│   ├── search.ts         # Search pipeline orchestration
│   ├── indexer.ts        # File indexing + watching
│   ├── queue.ts          # Priority queue (search > index)
│   └── types.ts          # Shared types
├── plugin/
│   ├── index.ts          # lobs plugin entry
│   ├── lobs.plugin.json
│   └── package.json
├── config.json           # Default server config
├── package.json
├── tsconfig.json
├── DESIGN.md
└── README.md
```

## Performance Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| Search (full pipeline) | <200ms | With reranking on 20 candidates |
| Search (no expansion) | <100ms | Skip query expansion for speed |
| Search (BM25 only) | <10ms | Keyword search fallback |
| Embedding (single chunk) | <20ms | Model stays loaded |
| Reranking (20 candidates) | <50ms | Cross-encoder batch |
| Index (single file) | <500ms | Chunk + embed + store |
| Startup (cold) | <10s | Load 3 models + init DB |

## Future Enhancements

- Ollama integration for bigger/better embedding models
- Session transcript indexing (lobs session JSONL files)
- Collection-level search scoping
- Configurable pipeline stages (skip expansion, skip reranking)
- Metrics/observability endpoint
- Multiple index support (per-agent isolation)
