# lobs-memory

Persistent memory search server with neural reranking and hybrid search (BM25 + vector).

## Features

- **Hybrid search**: BM25 keyword search + vector semantic search
- **Neural reranking**: Cross-encoder reranking for higher quality results
- **Persistent models**: Keeps embedding and reranker models loaded in memory
- **File watching**: Automatically re-indexes changed files
- **Embedding cache**: Avoids re-embedding unchanged text
- **MMR diversity**: Ensures result variety
- **Temporal decay**: Prioritizes recent files (configurable)

## Requirements

- **Bun** runtime
- **LM Studio** running on localhost:1234 with `text-embedding-nomic-embed-text-v1.5` loaded
- **Reranker GGUF** (optional): `~/.cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf`

## Installation

```bash
bun install
```

## Configuration

Edit `config.json` or set environment variables:

```json
{
  "port": 7420,
  "lmstudio": {
    "baseUrl": "http://localhost:1234/v1",
    "embeddingModel": "text-embedding-nomic-embed-text-v1.5"
  },
  "models": {
    "reranker": "~/.cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf"
  },
  "collections": [
    {
      "name": "memory",
      "path": "~/.lobs/workspace",
      "pattern": ["MEMORY.md", "memory/**/*.md"]
    }
  ]
}
```

Environment variables:
- `PORT` - Server port (default: 7420)
- `LMSTUDIO_URL` - LM Studio base URL
- `EMBEDDING_MODEL` - Embedding model name
- `RERANKER_MODEL` - Path to reranker GGUF

## Usage

### Start server

```bash
bun run start
# or with auto-reload during development:
bun run dev
```

### Search API

```bash
curl -X POST http://localhost:7420/search \
  -H "Content-Type: application/json" \
  -d '{"query": "github issues", "maxResults": 5}'
```

Response:
```json
{
  "results": [
    {
      "path": "/path/to/file.md",
      "startLine": 10,
      "endLine": 50,
      "score": 0.85,
      "snippet": "...",
      "source": "memory",
      "citation": "/path/to/file.md:10-50"
    }
  ],
  "query": "github issues",
  "timings": {
    "totalMs": 150,
    "bm25Ms": 2,
    "vectorMs": 45,
    "rerankMs": 98
  }
}
```

### Health check

```bash
curl http://localhost:7420/health
```

### Status

```bash
curl http://localhost:7420/status
```

### Manual re-index

```bash
curl -X POST http://localhost:7420/index
```

## Architecture

- **server/config.ts** - Configuration loading
- **server/db.ts** - SQLite database with FTS5 and sqlite-vec
- **server/chunker.ts** - Markdown chunking
- **server/embedder.ts** - LM Studio embedding client
- **server/reranker.ts** - node-llama-cpp reranker
- **server/search.ts** - Full search pipeline
- **server/indexer.ts** - File indexing and watching
- **server/index.ts** - HTTP server

## Search Pipeline

1. **BM25 search** - Keyword search via SQLite FTS5
2. **Vector search** - Semantic search via sqlite-vec
3. **Weighted merge** - Combine scores (default: 70% vector, 30% text)
4. **Neural reranking** - Cross-encoder scoring (if available)
5. **Temporal decay** - Exponential decay based on file date
6. **MMR diversity** - Maximal marginal relevance filtering
7. **Return top-K** - Default 8 results

## Performance

- Cold start: ~3-5s (loads reranker GGUF)
- Search latency: 100-200ms (with reranking)
- Embedding: ~25ms per chunk (LM Studio)
- Reranking: ~50-100ms for 20 candidates

## Development

```bash
# Install dependencies
bun install

# Run with auto-reload
bun run dev

# Check database
sqlite3 ~/.lobs/plugins/lobs-memory/index.db "SELECT COUNT(*) FROM documents;"
```

## Troubleshotics

**LM Studio connection errors:**
- Make sure LM Studio is running on localhost:1234
- Check that `text-embedding-nomic-embed-text-v1.5` is loaded in LM Studio

**Reranker not loading:**
- Check that the GGUF file exists at the configured path
- The server will work without reranking if the model is missing (degrades gracefully)

**Slow initial startup:**
- First run indexes all files (can take a few minutes for large collections)
- Subsequent starts are fast (~3s) because files are cached
- The server is responsive immediately; indexing runs in background

## License

Private - Part of the lobs-ai project.
