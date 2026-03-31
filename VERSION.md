# lobs-memory

## Version 0.1.0
**Release Date:** 2026-03-13

### Overview
Semantic memory server for AI agents with hybrid search and neural reranking.

### Key Features
- **Hybrid Search** — BM25 keyword search combined with dense vector embeddings (Qwen3 4B)
- **Neural Reranking** — ONNX-based reranker sidecar for result refinement
- **Query Expansion** — HyDE (Hypothetical Document Embeddings) with qwen2.5-1.5B-instruct-MLX
- **Temporal Decay** — Recency boost for dated files (daily notes, session logs)

### Architecture
- FastAPI backend with persistent ChromaDB
- Multi-collection support (workspace, paw-hub, shared memory)
- Configurable chunking strategies (semantic, fixed, markdown)
- TTL-optimized inference pipeline (50 tok/s HyDE generation)

### Performance
- First search: ~3.5-4.5s (includes HyDE expansion)
- Subsequent searches: <1s (with caching)
- Current corpus: 1335 documents, 4637 chunks
