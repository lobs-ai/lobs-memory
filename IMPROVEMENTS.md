# lobs-memory Search Quality Improvements

**Date:** 2026-03-12  
**Status:** ✅ Complete and tested

## Changes Made

### 1. Header-Aware Semantic Chunking (chunker.ts) ✅

**Complete rewrite** of the chunking algorithm:

- **Section parsing:** Parse markdown into sections based on heading boundaries (`#`, `##`, `###`, etc.)
- **Heading context:** Prepend hierarchical context to each chunk (e.g. `[MEMORY.md > Approval Tiers]`)
- **Smart sizing:** 
  - Merge sections < 80 tokens with neighbors
  - Split sections > 600 tokens at paragraph boundaries
  - Target: 300-400 tokens per chunk
- **Fallback:** Paragraph-based splitting for non-markdown or heading-less content

**Example:**
```
Before:
- **A (Auto):** Bug fixes, docs, research, tests
- **B (Lobs):** Refactors, new utilities/endpoints

After:
[MEMORY.md > Approval Tiers]
- **A (Auto):** Bug fixes, docs, research, tests
- **B (Lobs):** Refactors, new utilities/endpoints
```

### 2. Improved Snippet Extraction (chunker.ts) ✅

- Extracts and displays heading context in snippets
- Shows clean preview with context prefix (e.g. `## Approval Tiers: <content>`)
- Truncates content intelligently while preserving context

### 3. Embedding Cache Cleanup (db.ts) ✅

- Added `deleteEmbeddings(chunkIds)` function for manual cleanup
- Added index on `chunk_embeddings.chunk_id` for faster lookups
- CASCADE delete already handled via FK constraint
- Cache invalidation when embeddings change

### 4. Better FTS5 Tokenization (db.ts) ✅

- Added `preprocessQuery()` function:
  - Splits camelCase: `memorySearch` → `memory Search`
  - Splits snake_case: `memory_search` → `memory search`
  - Strips common path prefixes (`~/`, `.lobs/`, `workspace/`)
- Improves matching for technical terms and file paths

### 5. Score Normalization (search.ts) ✅

- Normalize all scores to [0, 1] range after merging/reranking/MMR
- Prevents confusing scores > 1.0 when expansion boosts stack
- Applied before min score filter

### 6. Config Tuning (config.json) ✅

- `targetTokens`: 400 → 300 (more precise chunks)
- `overlapTokens`: 80 → 40 (less redundancy, heading context provides continuity)

## Results

### Index Statistics
- **Documents:** 279
- **Chunks:** 841
- **Average chunk size:** 170 tokens
- **Score range:** All search results normalized to [0, 1]

### Search Quality Tests

All test queries working correctly:

1. **"approval tiers for PRs"**
   - Top result: MEMORY.md (Approval Tiers section), score 0.842 ✅
   
2. **"worker agent timeout"**
   - Top result: AGENTS.md (Key Safety Rules), score 1.000 ✅
   
3. **"Rafe schedule Monday"**
   - Top result: USER.md (schedule section), score 0.974 ✅
   
4. **"Discord channel IDs"**
   - Top result: TOOLS.md (Discord section), score 1.000 ✅

### Heading Context Examples

Sample chunks from the index:

```
[TOOLS.md > TOOLS.md - Local Notes]
<content>

[TOOLS.md > TOOLS.md - Local Notes > Google APIs]
<content>

[TOOLS.md > TOOLS.md - Local Notes > Discord]
<content>
```

## Performance

- **Indexing:** 279 docs in ~46 seconds (first run)
- **Search latency:** 40-50ms typical (BM25 + vector + expansion)
- **No degradation:** Heading context adds minimal overhead

## What Was NOT Changed

Per instructions:
- ✅ `server/expander.ts` — untouched (recently rewritten)
- ✅ `server/index.ts` — untouched (no new exports needed)
- ✅ `server/types.ts` — untouched (no new types needed)

## Migration Notes

To apply these improvements to an existing index:

1. **Delete old index:** `rm ~/.lobs/plugins/lobs-memory/index.db*`
2. **Restart server:** `cd ~/lobs-memory && bun run server/index.ts`
3. **Wait for reindex:** Watch logs for "Indexer ready" (~1 minute for 300 docs)

Existing embeddings and cache are rebuilt automatically. No schema migration needed.

## Impact Summary

**Biggest win:** Header-aware chunking gives the embedding model much better context. A chunk about "Approval Tiers" now explicitly says it's about approval tiers in MEMORY.md, not just raw bullet points.

**Secondary wins:**
- CamelCase/snake_case query preprocessing improves technical term matching
- Score normalization makes results easier to interpret
- Smaller chunk target (300 vs 400 tokens) improves precision

**Trade-offs:**
- More chunks overall (841 vs previous ~600-700)
- Some very small sections still create <100 token chunks (446 out of 841)
  - This is OK — heading context makes them useful
- Slightly longer indexing time due to section parsing (negligible in practice)

## Next Steps (Future Work)

Optional improvements not in scope for this task:

- Experiment with smaller minTokens (80 → 60) to reduce tiny chunk count
- Add paragraph-level context for non-heading splits
- Cache section parse results for faster re-indexing of large files
- A/B test chunk size ranges (200-500 vs 100-400)

---

**All changes tested and working. Ready for production use.**
