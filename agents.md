# lobs-memory — Agent Guide

## What It Is

lobs-memory is a **persistent semantic search service** for the Lobs agent system. It provides hybrid search (BM25 keyword + vector embeddings) over memory files and project docs, with neural reranking for result quality.

It runs as a separate service (typically on port 7420) and is called by lobs-core via the **Librarian service** for cross-session memory search.

## Architecture

```
lobs-core (Librarian service)  ──search──>  lobs-memory (port 7420)
                                              │
                                              ├── BM25 (SQLite FTS5)
                                              ├── Vector search (sqlite-vec)
                                              ├── Neural reranker (node-llama-cpp)
                                              └── File watcher (chokidar)
```

**Key server modules** (`server/`):
- `index.ts` — HTTP server, routes `/search`, `/health`, `/status`, `/index`
- `db.ts` — SQLite with FTS5 + sqlite-vec for full-text and vector search
- `embedder.ts` — LM Studio embedding client
- `reranker.ts` — Cross-encoder reranking via node-llama-cpp
- `search.ts` — Full search pipeline (BM25 → vector → rerank → MMR → decay)
- `indexer.ts` — File indexing and watching
- `chunker.ts` — Markdown chunking

## Build & Run

```bash
cd ~/lobs/lobs-memory

# Install (Bun)
bun install

# Start server
bun run start

# Development (auto-reload)
bun run dev

# Run tests
bun test
```

**External dependencies:**
- **LM Studio** on `localhost:1234` with `text-embedding-qwen3-embedding-4b` loaded
- **Reranker GGUF** (optional, degrades gracefully if missing): `~/.cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf`

## Configuration

Edit `config.json` or set environment variables:

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | 7420 | Server port |
| `LMSTUDIO_URL` | `http://localhost:1234/v1` | LM Studio base URL |
| `EMBEDDING_MODEL` | `text-embedding-qwen3-embedding-4b` | Embedding model |
| `RERANKER_MODEL` | path to GGUF | Reranker model path |

## Key Conventions

- **Tech stack**: Bun runtime, TypeScript, SQLite (FTS5 + sqlite-vec), node-llama-cpp
- **File collections** are defined in `config.json` under `collections[]`. Each collection has a `name`, `path`, and `pattern` globs
- **Chunking**: Markdown files are split into chunks (with citation line ranges) before embedding
- **Caching**: Embeddings are cached in SQLite — unchanged files skip re-embedding on restart
- **Graceful degradation**: Server works without reranker (just skips that step)
- **Background indexing**: On startup, indexing runs in background — server is responsive immediately
- **File watching**: `chokidar` watches collection paths and re-indexes changed files automatically

## Data It Manages

- **`index.db`** (SQLite) — FTS5 full-text index + sqlite-vec vector store + embedding cache
- **`memory.db`** — secondary database (per README)
- **Indexed files** — Markdown files matching collection patterns (e.g., `MEMORY.md`, `memory/**/*.md`)

Data lives in `~/.lobs/plugins/lobs-memory/` by default.

## Search API

```bash
curl -X POST http://localhost:7420/search \
  -H "Content-Type: application/json" \
  -d '{"query": "github issues", "maxResults": 5}'
```

Response includes `results[]` with `path`, `startLine`, `endLine`, `score`, `snippet`, `source`, and `citation`.

Other endpoints:
- `GET /health` — health check
- `GET /status` — index status, document counts
- `POST /index` — trigger manual re-index