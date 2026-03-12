# lobs-memory

Local memory search server + OpenClaw plugin. Persistent vector search with neural reranking and query expansion.

## Why

OpenClaw's builtin memory search is fast but basic (BM25 + cosine similarity). QMD has great features (reranking, query expansion, hybrid search) but cold-starts models on every CLI call (~3s latency). This project keeps models loaded in a persistent server process, giving QMD-quality results with sub-200ms latency.

## Architecture

```
┌─────────────┐     HTTP      ┌──────────────────────────────┐
│  OpenClaw   │ ──────────────│  lobs-memory server (Bun)    │
│  Plugin     │  POST /search │                              │
│  (memory_   │  POST /index  │  Embedding (GGUF, in-proc)   │
│   search)   │  GET  /health │  Reranker  (GGUF, in-proc)   │
└─────────────┘               │  Query Exp (GGUF, in-proc)   │
                              │  SQLite + FTS5 + sqlite-vec  │
                              │  File watcher + job queue    │
                              └──────────────────────────────┘
```

## Search Pipeline

1. **Query expansion** — LLM generates alternative phrasings (qmd-query-expansion-1.7B)
2. **BM25 keyword search** — SQLite FTS5 for exact token matching
3. **Vector similarity** — Cosine similarity on embeddings (embeddinggemma-300M)
4. **Weighted merge** — Configurable BM25/vector ratio (default 0.3/0.7)
5. **Neural reranking** — Cross-encoder rescores query-doc pairs (qwen3-reranker-0.6b)
6. **MMR diversity** — Removes near-duplicate results
7. **Temporal decay** — Boosts recent memories, fades old ones
8. **Top-K** — Returns results with snippets + citations

## Components

### Server (`/server`)
- Bun HTTP server, persistent daemon on localhost:7420
- Models loaded once at startup (embedding + reranker + query expansion)
- SQLite storage with FTS5 + sqlite-vec
- File watcher with debounced re-indexing
- Query queue with priority over indexing work

### OpenClaw Plugin (`/plugin`)
- `kind: "memory"` — replaces memory-core via `plugins.slots.memory`
- `memory_search` → HTTP POST to server
- `memory_get` → reads files directly
- Config: `{ serverUrl, enabled }`

## Models

| Role | Model | Size | Source |
|------|-------|------|--------|
| Embedding | embeddinggemma-300M-Q8_0 | 328MB | GGUF (node-llama-cpp) |
| Reranker | qwen3-reranker-0.6b-q8_0 | 639MB | GGUF (node-llama-cpp) |
| Query Expansion | qmd-query-expansion-1.7B-q4_k_m | 1.2GB | GGUF (node-llama-cpp) |

Upgrade path: swap embedding model for nomic-embed-text via Ollama for better quality.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/search` | POST | Search memories `{query, maxResults?, minScore?}` |
| `/index` | POST | Trigger re-index `{paths?}` |
| `/health` | GET | Server + model status |
| `/status` | GET | Detailed index stats |
| `/collections` | POST | Add/remove watched directories |

## Setup

```bash
# Install deps
bun install

# Start server (models auto-load)
bun run server/index.ts

# Or as a daemon
bun run server/index.ts &

# Configure OpenClaw
# plugins.slots.memory = "lobs-memory"
# plugins.entries.lobs-memory.config.serverUrl = "http://localhost:7420"
```

## Config

Server config via `config.json` or environment:

```json
{
  "port": 7420,
  "models": {
    "embedding": "~/.cache/qmd/models/hf_ggml-org_embeddinggemma-300M-Q8_0.gguf",
    "reranker": "~/.cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf",
    "queryExpansion": "~/.cache/qmd/models/hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf"
  },
  "collections": [
    { "name": "memory", "path": "~/.openclaw/workspace", "pattern": ["MEMORY.md", "memory/**/*.md"] },
    { "name": "shared", "path": "~/lobs-shared-memory", "pattern": "**/*.md" }
  ],
  "search": {
    "vectorWeight": 0.7,
    "textWeight": 0.3,
    "mmr": { "enabled": true, "lambda": 0.7 },
    "temporalDecay": { "enabled": true, "halfLifeDays": 30 },
    "reranking": { "enabled": true, "topK": 20 },
    "queryExpansion": { "enabled": true }
  },
  "chunking": {
    "targetTokens": 400,
    "overlapTokens": 80
  }
}
```
