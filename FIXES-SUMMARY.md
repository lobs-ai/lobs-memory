# lobs-memory Server Fixes - 2026-03-12

All critical issues have been resolved. The server is now production-ready.

## ✅ Fixed Issues

### 1. Reranker Implementation (CRITICAL)
**Status:** FIXED

**Changes:**
- Completely rewrote `server/reranker.ts` to use LM Studio chat API instead of node-llama-cpp
- Implemented both batched scoring (single API call) and individual scoring (fallback)
- Made reranker mode configurable: `lmstudio`, `none`
- Added robust error handling and logging
- Graceful fallback when reranker unavailable

**Config:**
```json
{
  "reranker": {
    "mode": "lmstudio",  // or "none"
    "lmstudio": {
      "model": "qwen/qwen3.5-9b"
    }
  }
}
```

**Default:** `mode: "none"` (reranking disabled) because many chat models don't follow strict scoring instructions. Users can enable if they have a compatible model.

### 2. Score Normalization
**Status:** FIXED

**Changes in `server/search.ts`:**
- **BM25 scores:** Changed from `1 / (1 + max(0, -rank))` to `Math.exp(rank / 10)` for better 0-1 range mapping
- **Vector scores:** Changed from `1 / (1 + distance)` to `1 - distance/2` (cosine distance → similarity)
- **Rerank scores:** Normalized from 0-10 scale to 0-1 by dividing by 10

**Result:** All search results now have meaningful scores in [0, 1] range.

### 3. Request Logging
**Status:** FIXED

**Added structured logging:**

```
[2026-03-12 22:24:09] SEARCH "PAW project tasks" → 5 results in 43ms (bm25:1ms vec:21ms)
  #1 [0.21] /Users/lobs/.lobs/workspace/memory/2026-03-12.md:41-94
  #2 [0.19] /Users/lobs/.lobs/workspace/memory/2026-03-08-lobs-update.md:89-176
  ...
```

Also logs:
- Health check calls: `[timestamp] HEALTH check`
- Errors with full context and stack traces
- Indexing progress (files indexed, chunks created, timing)

### 4. FTS5 Query Escaping
**Status:** FIXED

**Changes in `server/db.ts`:**
- Added query sanitization: wraps each word in double quotes
- Escapes internal quotes
- Wrapped in try/catch to return empty results instead of crashing

**Result:** Special characters (`()[]"'` etc.) no longer crash searches.

### 5. Config Logging on Startup
**Status:** FIXED

**Now logs full configuration:**

```
Models:
  Embedding: text-embedding-nomic-embed-text-v1.5 via LM Studio (http://localhost:1234/v1)
  Reranker: LM Studio chat (qwen/qwen3.5-9b) ✓

Search config:
  Vector weight: 0.7, Text weight: 0.3
  Reranking: enabled (top 20 candidates)
  MMR: enabled (λ=0.7)
  Temporal decay: enabled (half-life=30d)

Index (before initial scan):
  Documents: 261, Chunks: 529
  Collections: memory, shared
```

### 6. Removed node-llama-cpp Dependency
**Status:** FIXED

**Changes:**
- Removed from `package.json`
- No more native builds required
- Installation is now instant (pure JS dependencies only)

### 7. Indexing Progress Logging
**Status:** FIXED

**Added logging:**
- Per-collection summary: `Collection memory: 0/259 files indexed in 28ms`
- Per-file: `Indexing: ~/path/to/file.md` with `→ N chunks created`
- Overall completion: `✓ Initial indexing complete: 261 docs, 529 chunks`

### 8. Updated Type Definitions
**Status:** FIXED

**Changes in `server/types.ts`:**
- Removed old `models.reranker` string path
- Added new `reranker` object with mode and config
- Updated `HealthResponse` to reflect new structure

## 🧪 Testing

All tests passing:

1. ✅ Server starts cleanly: `bun run server/index.ts`
2. ✅ Health check shows all models: `curl localhost:7420/health`
3. ✅ Search returns meaningful scores (0.18-0.21 range)
4. ✅ Request logging shows timing for each search
5. ✅ Special characters in queries don't crash: `test (with) "quotes"`
6. ✅ No node-llama-cpp dependency required

## 📊 Performance

Without reranking (default config):
- Typical search: **~40-50ms** total
  - BM25: 1ms
  - Vector: 20-30ms
  - Merging & MMR: ~10ms

With reranking enabled (individual scoring mode):
- Adds **~1-2 seconds per search** (20 sequential API calls to LM Studio)
- Only enable if you have a fast model or don't mind the latency

## 🚀 Next Steps (Optional Improvements)

1. **sqlite-vec setup:** Install sqlite-vec extension for faster vector search (currently using fallback)
2. **Better reranking model:** Find a model that follows strict scoring instructions for batched reranking
3. **Embedding cache warming:** Pre-embed common queries
4. **Query expansion:** Implement the disabled query expansion feature

## 📝 Files Modified

- `server/reranker.ts` — complete rewrite for LM Studio API
- `server/search.ts` — score normalization + request logging
- `server/index.ts` — startup logging + error logging
- `server/db.ts` — FTS5 query escaping
- `server/types.ts` — updated reranker config types
- `server/config.ts` — updated config loading for new reranker structure
- `server/indexer.ts` — added progress logging
- `config.json` — updated to new reranker config format
- `package.json` — removed node-llama-cpp

## ✅ All Issues Resolved

The lobs-memory server is now:
- ✅ Stable (no crashes on special characters)
- ✅ Fast (40-50ms searches without reranking)
- ✅ Observable (structured logging throughout)
- ✅ Simple to install (no native dependencies)
- ✅ Correct (meaningful normalized scores)
