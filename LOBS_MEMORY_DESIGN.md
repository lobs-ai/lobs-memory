# Lobs Memory — Design Document

> Persistent, multi-agent memory system for the Lobs AI agent platform.

## 1. Problem Statement

Lobs agents need to **remember things** across sessions — decisions made, lessons learned, user preferences, project context, prior conversation insights. Today's system works but has structural issues:

1. **Dual backend confusion.** lobs-core has two memory search paths: a fast-but-dumb grep fallback and a rich in-process engine (BM25 + vectors + reranking + query expansion). The grep fallback exists because the in-process engine isn't always initialized at startup.

2. **Memory is flat files.** Daily memory files (`~/.lobs/agents/main/context/memory/YYYY-MM-DD.md`) accumulate entries. The condenser promotes learnings/decisions to `~/lobs-shared-memory/learnings.md` after 7 days, but there's no structured query, no conflict resolution, no evidence tracking.

3. **No multi-agent memory scoping.** All agents share the same flat memory files. A programmer subagent's findings mix with the main agent's decisions. There's no way to scope "what did the architect agent conclude about X?" vs "what did I decide about X?"

4. **No ground truth / derived separation.** Events (what happened) and conclusions (what we learned) live in the same format. There's no way to trace a learning back to the events that produced it, or to detect when a learning contradicts newer evidence.

## 2. Current Architecture

### 2.1 Storage

```
~/.lobs/agents/main/context/memory/
├── 2026-03-26.md          # Today's daily file
├── 2026-03-25.md          # Yesterday
├── ...older files...      # Condensed after 7 days
~/lobs-shared-memory/
├── learnings.md           # Permanent learnings/decisions (promoted from daily files)
```

**Daily file format:**
```markdown
# 2026-03-26 — Daily Memory

## Events

- **[14:30]** [event] — Rafe asked about memory system design
- **[14:35]** [learning] — lobs-memory server already implements the full search pipeline
- **[15:00]** [decision] — Will create persistent server to eliminate cold-start penalty
```

**Permanent file format:**
```markdown
- **[2026-03-20] [learning]** — Always lint code before considering a task done
- **[2026-03-21] [decision]** — Use standard tier for subagents by default
```

### 2.2 Search Pipeline (In-Process)

The full search pipeline lives in `lobs-core/src/services/memory/` (ported from `lobs-memory/server/`):

```
Query
  │
  ├─ Stage 1: Parallel BM25 (FTS5) + Vector search (sqlite-vec)
  │            Weighted merge (configurable text/vector weights)
  │
  ├─ Stage 2: Query expansion (optional, via LLM)
  │            Generates alternate queries → additional BM25/vector searches
  │
  ├─ Stage 3: Merge expansion results into candidate pool
  │
  ├─ Stage 4: Reranking (optional, via cross-encoder model)
  │            Re-scores candidates for relevance
  │
  └─ Stage 5: MMR (maximal marginal relevance) + temporal decay
              Diversifies results, penalizes stale content
```

**Key files:**
- `search.ts` — Full pipeline orchestration (616 lines in standalone, 504 in-process)
- `db.ts` — SQLite with FTS5 + sqlite-vec (vector embeddings stored alongside text)
- `embedder.ts` — LMStudio-backed embedding generation
- `reranker.ts` — Cross-encoder reranking (sidecar Python process or LMStudio)
- `expander.ts` — Query expansion via local LLM
- `indexer.ts` — File watching, chunking, and index maintenance
- `chunker.ts` — Markdown-aware document chunking
- `entities.ts` — Named entity extraction from chunks
- `graph.ts` — Entity relationship graph queries
- `parsers.ts` — File format parsers (markdown, code, etc.)

### 2.3 Context Engine

`lobs-core/src/runner/context-engine.ts` is the consumer. It:

1. **Classifies the task** (coding, debugging, architecture, research, etc.) using regex patterns + optional LLM fallback
2. **Allocates token budget** per category (memory, project, code, session, instructions) based on task type
3. **Searches lobs-memory** via batch queries scoped to different collections
4. **Categorizes results** (memory vs project vs code vs session) based on file paths
5. **Fills layers** up to budget, sorted by relevance score
6. **Formats** into a structured context block injected into the agent's prompt

### 2.4 Memory Client

`lobs-core/src/services/memory-client.ts` provides the unified API:

- `memorySearch(query, options)` — single search, in-process with grep fallback
- `memorySearchBatch(searches)` — parallel batch search
- `getHealth()` — service health check
- `triggerReindex()` — force re-index

The client tries in-process search first (`isMemoryReady()`) and falls back to grep when the memory service isn't initialized yet (early startup race).

### 2.5 Memory Condenser

`lobs-core/src/services/memory-condenser.ts` runs daily:

- Files ≤ 7 days old: untouched
- Files > 7 days old with > 30 entries: condensed
  - Keep `[learning]` and `[decision]` entries
  - Keep `[finding]` entries (but don't promote)
  - Drop `[event]` and `[note]` entries
  - Promote learnings/decisions to permanent file

### 2.6 Memory Write Tool

Agents write memory via `memory_write` tool:
- **Categories:** learning, decision, finding, event, note
- **Daily file:** Default target (events/notes always here)
- **Permanent file:** `permanent=true` for learning/decision/finding
- **Custom file:** `file` parameter override

## 3. Design Goals

### 3.1 Immutable Event Log + Derived Memories

**Ground truth:** Raw events are immutable. What happened, when, who was involved, what was said. These never change.

**Derived memories:** Learnings, decisions, and patterns are derived from events through reflection. They have:
- **Evidence links** — which events support this memory
- **Confidence scores** — how well-supported is this conclusion
- **Timestamps** — when derived, when last validated
- **Supersession** — newer memories can supersede older ones (with explicit links)

### 3.2 Agent-Scoped Memory

Memories are scoped at three levels:

| Scope | Visibility | Examples |
|-------|-----------|----------|
| **System** | All agents | User preferences, global config, project structure |
| **Agent** | Single agent type | "Programmer agents should always lint" |
| **Session** | Single run | Working memory for a specific task |

The main agent's decisions are system-level by default. Subagent findings are agent-scoped unless promoted.

### 3.3 Reflection with Evidence Thresholds

Reflection is the process of deriving structured memories from raw events. It must be:

- **Bounded** — reflection runs on a schedule, not on every event
- **Evidence-based** — a minimum number of supporting events required before a pattern becomes a memory
- **Conflict-aware** — when new evidence contradicts an existing memory, flag the conflict rather than silently overwriting
- **Auditable** — every derived memory traces back to its evidence

### 3.4 Search Quality Preservation

The existing search pipeline is good. The design preserves it entirely:
- BM25 + vector hybrid search
- Query expansion for recall
- Cross-encoder reranking for precision
- MMR for diversity
- Temporal decay for freshness

The only change is where it runs (always in-process, already done) and what it indexes (structured memories in addition to raw files).

## 4. Data Model

### 4.1 Events (Ground Truth)

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,           -- ISO 8601
  agent_id TEXT NOT NULL,            -- 'main', 'programmer-abc123', etc.
  agent_type TEXT NOT NULL,          -- 'main', 'programmer', 'reviewer', etc.
  session_id TEXT,                   -- links events within a single agent run
  event_type TEXT NOT NULL,          -- 'observation', 'action', 'decision', 'error', 'user_input', 'tool_result'
  content TEXT NOT NULL,             -- what happened (human-readable)
  metadata TEXT,                     -- JSON: tool name, file paths, error codes, etc.
  scope TEXT NOT NULL DEFAULT 'session',  -- 'system', 'agent', 'session'
  project_id TEXT,                   -- optional project association
  
  -- Indexing
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_agent ON events(agent_id, timestamp);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_project ON events(project_id);
```

### 4.2 Memories (Derived)

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_type TEXT NOT NULL,         -- 'learning', 'decision', 'pattern', 'preference', 'fact'
  content TEXT NOT NULL,             -- the memory itself
  confidence REAL NOT NULL DEFAULT 0.5,  -- 0.0-1.0, based on evidence strength
  scope TEXT NOT NULL DEFAULT 'system',  -- 'system', 'agent', 'session'
  agent_type TEXT,                   -- which agent type this applies to (null = all)
  project_id TEXT,                   -- optional project scope
  
  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'active',  -- 'active', 'superseded', 'contested', 'archived'
  superseded_by INTEGER,             -- FK to newer memory that replaces this one
  
  -- Timestamps
  derived_at TEXT NOT NULL,          -- when this memory was created
  last_validated TEXT,               -- when last confirmed by new evidence
  expires_at TEXT,                   -- optional TTL (e.g., session-scoped memories)
  
  -- Search
  embedding BLOB,                   -- vector embedding for semantic search
  
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_memories_type ON memories(memory_type, status);
CREATE INDEX idx_memories_scope ON memories(scope, agent_type);
CREATE INDEX idx_memories_project ON memories(project_id);
CREATE INDEX idx_memories_status ON memories(status);
```

### 4.3 Evidence Links

```sql
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  event_id INTEGER NOT NULL REFERENCES events(id),
  relationship TEXT NOT NULL,        -- 'supports', 'contradicts', 'context'
  strength REAL NOT NULL DEFAULT 1.0, -- how strongly this event supports/contradicts
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_evidence_memory ON evidence(memory_id);
CREATE INDEX idx_evidence_event ON evidence(event_id);
```

### 4.4 Memory Conflicts

```sql
CREATE TABLE conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_a INTEGER NOT NULL REFERENCES memories(id),
  memory_b INTEGER NOT NULL REFERENCES memories(id),
  description TEXT NOT NULL,         -- what the conflict is
  resolution TEXT,                   -- how it was resolved (null = unresolved)
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 5. Reflection Pipeline

Reflection transforms raw events into structured memories. It runs on a schedule (not real-time) and follows strict rules.

### 5.1 Trigger Conditions

| Trigger | Frequency | Scope |
|---------|-----------|-------|
| Session end | After each agent run completes | Session events |
| Daily condensation | Once per day (existing condenser schedule) | All events from past day |
| Manual | On-demand via tool or CLI | Specified event range |

### 5.2 Reflection Process

```
1. Gather unreflected events (events not yet linked to any memory)
2. Cluster related events (by session, project, topic)
3. For each cluster:
   a. Extract candidate memories (pattern detection)
   b. Check against existing memories:
      - If reinforcing: bump confidence, add evidence link
      - If contradicting: create conflict record, flag for review
      - If novel: create new memory if evidence threshold met
4. Update memory confidence scores
5. Mark events as reflected
```

### 5.3 Evidence Thresholds

| Memory Type | Min Events | Min Confidence | Notes |
|------------|-----------|----------------|-------|
| Learning | 2 | 0.6 | Need at least 2 corroborating events |
| Decision | 1 | 0.8 | Explicit decisions have high confidence immediately |
| Pattern | 3 | 0.5 | Patterns need more evidence to establish |
| Preference | 2 | 0.7 | User preferences escalate quickly |
| Fact | 1 | 0.9 | Facts are high-confidence, low-evidence |

### 5.4 Confidence Decay

Memories that aren't reinforced by new evidence decay slowly:

```
confidence(t) = base_confidence * (0.5 ^ (days_since_last_validation / half_life))
```

- **Decisions:** half_life = 365 days (slow decay — decisions are sticky)
- **Learnings:** half_life = 180 days
- **Patterns:** half_life = 90 days (need regular reinforcement)
- **Preferences:** half_life = 365 days (preferences are sticky)
- **Facts:** no decay (facts don't expire)

## 6. Search Integration

### 6.1 Unified Search

Memory search should query both the existing document index (files, markdown, code) AND the structured memories table. Results are merged and ranked together.

```
Query
  │
  ├─ Document search (existing pipeline) → file-based results
  │
  ├─ Memory search (new) → structured memory results
  │    ├─ FTS5 on memories.content
  │    └─ Vector search on memories.embedding
  │
  └─ Merge + re-rank all candidates together
```

### 6.2 Memory-Aware Scoring

Structured memories get scoring bonuses:
- **Active memories:** +0.1 score boost (they're curated knowledge)
- **High confidence:** scaled boost up to +0.15 for confidence > 0.8
- **Scope match:** +0.1 if memory scope matches the querying agent's scope
- **Recency:** existing temporal decay applies

Contested or superseded memories are demoted but not hidden (they provide context).

### 6.3 Context Engine Integration

The context engine (`context-engine.ts`) needs minimal changes:

1. Memory search results already flow through `categorizeResult()` — add a `"structured-memory"` category that maps to the `memory` budget allocation
2. Structured memories get formatted differently in context blocks (include confidence, evidence count)
3. Add a `memories` collection to the batch search queries

## 7. Write Path

### 7.1 Event Recording

Events are recorded automatically by the agent runner:
- **Tool calls:** Each tool invocation + result becomes an event
- **User messages:** Incoming messages become `user_input` events
- **Agent decisions:** Explicit decisions logged as `decision` events
- **Errors:** Failures become `error` events

This replaces the current `memory_write` tool for event-level data. The tool remains for explicit memory creation (agent deliberately writes a learning).

### 7.2 Memory Write Tool (Updated)

The `memory_write` tool gets a new mode:

```typescript
// Existing: write to daily file (backward compatible)
memory_write({ content: "...", category: "event" })

// New: create structured memory directly
memory_write({ 
  content: "Always check git status before starting work",
  category: "learning",
  permanent: true,
  evidence: ["session-abc123"]  // optional: link to events
})
```

When `permanent=true`, the tool creates a row in the `memories` table instead of (or in addition to) appending to the flat file.

### 7.3 Migration Path

Phase 1 (backward compatible):
- Keep flat file writes working exactly as today
- Add event recording alongside flat file writes
- New structured memories are written to both DB and flat file

Phase 2 (structured primary):
- Flat files become a read-only archive
- All new memories go to structured DB
- Search queries both sources

Phase 3 (flat files deprecated):
- Flat files are generated from DB for human readability
- DB is the source of truth
- Condenser operates on DB instead of flat files

## 8. Multi-Agent Coordination

### 8.1 Agent Identity

Each agent run gets a unique `agent_id` (e.g., `programmer-abc123`) and a known `agent_type` (e.g., `programmer`). The main agent is always `main`.

### 8.2 Memory Promotion

Subagent memories start at `session` scope. They can be promoted:

```
session → agent → system
```

**Automatic promotion:**
- If the main agent explicitly references a subagent finding, it's promoted to system scope
- If a subagent creates a `decision` with confidence > 0.8, it's promoted to agent scope

**Manual promotion:**
- Main agent can promote any memory: `memory_write({ promote: "memory-123", scope: "system" })`

### 8.3 Conflict Resolution

When agents produce conflicting memories:

1. Both memories are kept with `status: 'contested'`
2. A conflict record is created
3. On the next main agent run, the conflict surfaces in context
4. Main agent resolves by:
   - Choosing one (supersedes the other)
   - Merging into a new memory
   - Dismissing both

Rafe can also resolve conflicts through explicit instruction.

## 9. Implementation Plan

### Phase 1: Event Recording (Foundation)

**Goal:** Start capturing structured events without changing any existing behavior.

1. Add `events` table to memory.db schema
2. Create `EventRecorder` service in lobs-core
3. Hook into agent runner to record events automatically
4. Add event recording alongside existing `memory_write` flat file writes
5. Index events in the existing search pipeline (new collection: `events`)

**Backward compatibility:** 100%. Flat files still work. Grep fallback still works. This is purely additive.

### Phase 2: Structured Memories + Reflection

**Goal:** Derive structured memories from events.

1. Add `memories`, `evidence`, `conflicts` tables
2. Implement reflection pipeline (runs after session end + daily)
3. Update `memory_write` tool to support structured memory creation
4. Add memory search to the search pipeline (query memories table alongside documents)
5. Update context engine to include structured memories

### Phase 3: Agent Scoping + Promotion

**Goal:** Proper multi-agent memory isolation and promotion.

1. Add scope filtering to memory search
2. Implement promotion logic in the agent runner
3. Surface conflicts in agent context
4. Add CLI commands for memory management (`lobs memory list`, `lobs memory promote`, `lobs memory conflicts`)

### Phase 4: Flat File Deprecation

**Goal:** DB becomes source of truth.

1. Generate flat files from DB (for human readability / git tracking)
2. Migrate condenser to operate on DB
3. Remove flat file write path from `memory_write`
4. Keep flat file generation as a view layer

## 10. Configuration

Extends the existing memory config (`~/.lobs/config/memory.json`):

```json
{
  "lmstudio": {
    "baseUrl": "http://127.0.0.1:1234",
    "embeddingModel": "text-embedding-nomic-embed-text-v1.5",
    "chatModel": "qwen2.5-1.5b-instruct-mlx"
  },
  "reranker": {
    "mode": "sidecar"
  },
  "search": {
    "vectorWeight": 0.4,
    "textWeight": 0.6,
    "candidateMultiplier": 3,
    "maxResults": 10,
    "mmr": { "enabled": true, "lambda": 0.7 },
    "temporalDecay": { "enabled": true, "halfLifeDays": 90 },
    "reranking": { "enabled": true, "candidateCount": 20 },
    "queryExpansion": { "enabled": true, "strongSignalThreshold": 5.0 }
  },
  "reflection": {
    "enabled": true,
    "onSessionEnd": true,
    "dailyCondensation": true,
    "evidenceThresholds": {
      "learning": { "minEvents": 2, "minConfidence": 0.6 },
      "decision": { "minEvents": 1, "minConfidence": 0.8 },
      "pattern": { "minEvents": 3, "minConfidence": 0.5 }
    },
    "confidenceDecay": {
      "learning": 180,
      "decision": 365,
      "pattern": 90,
      "preference": 365
    }
  },
  "collections": [
    { "name": "workspace", "path": "~/.lobs/agents", "pattern": "**/*.md" },
    { "name": "knowledge", "path": "~/lobs-shared-memory", "pattern": "**/*.md" },
    { "name": "projects", "path": "~/lobs", "pattern": ["**/README.md", "**/DESIGN.md", "**/docs/**/*.md"] }
  ]
}
```

## 11. Open Questions

1. **Event volume.** Tool calls generate a lot of events. Do we record every tool call, or only "significant" ones? A single agent run might produce 50+ tool calls. Indexing all of them could bloat the DB and slow searches.

   *Proposed:* Record all events but mark them with granularity levels. Search defaults to coarse (decisions, errors, key findings) unless specifically asked for fine-grained.

2. **Reflection LLM cost.** The reflection pipeline needs an LLM to cluster events and extract memories. Running this after every session could be expensive.

   *Proposed:* Use the local qwen2.5-1.5b-instruct for reflection. It's free (LMStudio), fast, and good enough for pattern extraction. Only escalate to a larger model for conflict resolution.

3. **Embedding storage overhead.** Each memory gets a vector embedding (~1536 floats = ~6KB). With thousands of memories, this adds up.

   *Proposed:* Use the same embedding model already in use (nomic-embed-text-v1.5, 768 dimensions = ~3KB per memory). At 10K memories, that's ~30MB — negligible.

4. **Concurrent agent writes.** Multiple subagents might try to record events simultaneously.

   *Proposed:* SQLite's WAL mode handles concurrent reads well but serializes writes. For the expected concurrency (2-4 agents max), this is fine. If it becomes a bottleneck, batch writes through a queue.

## 12. Success Metrics

- **Search quality:** Memory search returns relevant results within top-3 for known queries (manual eval)
- **Cold start:** Zero. Memory service starts with lobs-core, no separate process needed.
- **Reflection accuracy:** >80% of auto-derived memories are useful when reviewed manually
- **Conflict detection:** Contradicting memories are flagged within 24 hours
- **Agent context quality:** Context engine assembles more relevant context (measured by agent task success rate)
