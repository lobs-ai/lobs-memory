#!/bin/bash
# Verification script for lobs-memory improvements

set -e

echo "=== lobs-memory Improvements Verification ==="
echo

echo "1. Checking health..."
curl -s http://localhost:7420/health | python3 -m json.tool | grep -E '"status"|"documents"|"chunks"|"collections"'
echo

echo "2. Testing regular search..."
curl -s -X POST http://localhost:7420/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"approval tiers","maxResults":3}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"Results: {len(d['results'])}, Timings: bm25={d['timings']['bm25Ms']}ms vector={d['timings']['vectorMs']}ms rerank={d['timings'].get('rerankMs', 0)}ms\")"
echo

echo "3. Testing session search..."
curl -s -X POST http://localhost:7420/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"subagent task","maxResults":3,"collections":["sessions"]}' | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"Session results: {len(d['results'])}, Source: {d['results'][0]['source'] if d['results'] else 'none'}\")"
echo

echo "4. Verifying incremental sync..."
BEFORE=$(curl -s http://localhost:7420/status | python3 -c "import json,sys; print(json.load(sys.stdin)['index']['lastUpdate'])")
echo "Last update before: $BEFORE"
echo "Waiting 65 seconds for background sync..."
sleep 65
AFTER=$(curl -s http://localhost:7420/status | python3 -c "import json,sys; print(json.load(sys.stdin)['index']['lastUpdate'])")
echo "Last update after: $AFTER"

if [ "$BEFORE" != "$AFTER" ]; then
    echo "✅ Background sync is working!"
else
    echo "⚠️  Background sync may not have run (timestamps identical)"
fi
echo

echo "5. Database stats..."
sqlite3 ~/.openclaw/plugins/lobs-memory/index.db "SELECT collection, COUNT(*) as docs FROM documents GROUP BY collection;"
echo

echo "=== All tests complete ==="
echo
echo "Summary:"
echo "- Session transcript indexing: $(sqlite3 ~/.openclaw/plugins/lobs-memory/index.db "SELECT COUNT(*) FROM documents WHERE collection='sessions'") session files indexed"
echo "- Incremental indexing: Check logs for 'Incremental sync: X new/changed, Y deleted (skipped Z unchanged)'"
echo "- Reranker: Check search timings for 'rerankMs' values (should be 1000-1500ms)"
echo
echo "See ~/lobs-memory/IMPLEMENTATION_SUMMARY.md for full details."
