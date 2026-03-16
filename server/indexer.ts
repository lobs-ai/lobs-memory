/**
 * File indexing with watching and embedding cache
 */

import { watch } from "chokidar";
import { readFileSync, statSync, existsSync } from "fs";
import { createHash } from "crypto";
import { join, relative } from "path";
import { glob } from "glob";
import {
  upsertDocument,
  getDocument,
  deleteDocument,
  insertChunks,
  deleteChunks,
  insertEmbeddings,
  getCachedEmbedding,
  setCachedEmbedding,
  getDb,
  insertEntities,
  insertRelationships,
  deleteEntities,
  deleteRelationships,
} from "./db.js";
import { chunkMarkdown } from "./chunker.js";
import { embedBatch } from "./embedder.js";
import { clearFileCache } from "./search.js";
import { parseFile } from "./parsers.js";
import { patternExtract } from "./entities.js";
import { extractRelationships } from "./graph.js";
import { checkEmbedderHealth } from "./embedder.js";
import type { Config, Collection } from "./types.js";

interface IndexerState {
  config: Config | null;
  watchers: Map<string, any>;
  isIndexing: boolean;
  isPaused: boolean;
  pendingFiles: Map<string, string>;
  pendingCollections: Set<string>;
  syncIntervalHandle: Timer | null;
  embedderDownLogged: boolean;
  lastEmbedderHealthCheckAt: number;
  embedderAvailable: boolean;
  embedderError?: string;
  lastEmbedderWarningAt: number;
}

const state: IndexerState = {
  config: null,
  watchers: new Map(),
  isIndexing: false,
  isPaused: false,
  pendingFiles: new Map(),
  pendingCollections: new Set(),
  embedderDownLogged: false,
  syncIntervalHandle: null,
  lastEmbedderHealthCheckAt: 0,
  embedderAvailable: true,
  embedderError: undefined,
  lastEmbedderWarningAt: 0,
};

interface CollectionSyncPlan {
  collection: Collection;
  diskFiles: number;
  unchanged: number;
  toIndex: string[];
  toDelete: string[];
}

interface FileIndexTask {
  path: string;
  collectionName: string;
}

const DEFAULT_EXCLUDE_SEGMENTS = [
  "/node_modules/",
  "/.git/",
  "/dist/",
  "/build/",
  "/Pods/",
  "/.build/",
];

function shouldIgnorePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return DEFAULT_EXCLUDE_SEGMENTS.some((segment) => normalized.includes(segment));
}

async function ensureEmbedderAvailable(): Promise<boolean> {
  const now = Date.now();
  if (now - state.lastEmbedderHealthCheckAt < 30_000) {
    if (!state.embedderAvailable && now - state.lastEmbedderWarningAt > 30_000) {
      console.warn(`Embedder unavailable — skipping indexing until LM Studio recovers (${state.embedderError ?? "unknown error"})`);
      state.lastEmbedderWarningAt = now;
    }
    return state.embedderAvailable;
  }

  state.lastEmbedderHealthCheckAt = now;
  const health = await checkEmbedderHealth();
  state.embedderAvailable = health.available;
  state.embedderError = health.error;
  if (health.available) {
    state.embedderDownLogged = false;
  }

  if (!health.available) {
    console.warn(`Embedder unavailable — skipping indexing until LM Studio recovers (${health.error ?? "unknown error"})`);
    state.lastEmbedderWarningAt = now;
  }

  return health.available;
}

/**
 * Initialize indexer and start file watchers
 */
export async function startIndexer(config: Config): Promise<void> {
  state.config = config;

  console.log("Starting batched index sync...");
  await runBatchSync("startup", true);

  if (config.indexing.watchEnabled) {
    console.log("Starting file watchers...");
    startWatchers();
  }

  // Start background periodic sweep
  const syncIntervalMs = (config.indexing as any).syncIntervalMs || 15 * 60 * 1000;
  console.log(`Starting background batch sweep (interval: ${syncIntervalMs}ms)`);
  state.syncIntervalHandle = setInterval(async () => {
    if (!state.isPaused && !state.isIndexing) {
      await runBatchSync("scheduled", true);
    }
  }, syncIntervalMs);

  console.log("Indexer ready");
}

/**
 * Queue a file/collection for the next batch sweep instead of indexing immediately.
 */
function queueFileForBatch(path: string, collectionName: string, reason: "add" | "change" | "delete"): void {
  if (shouldIgnorePath(path)) return;
  state.pendingFiles.set(path, collectionName);
  state.pendingCollections.add(collectionName);
  const relPath = path.replace(process.env.HOME || "", "~");
  console.log(`[indexer.queue] ${reason} queued for batch: ${relPath} (${collectionName})`);
}

/**
 * Discover changed/new/deleted files for a single collection.
 */
async function buildCollectionSyncPlan(collection: Collection): Promise<CollectionSyncPlan> {
  // Find all matching files on disk
  const patterns = Array.isArray(collection.pattern) ? collection.pattern : [collection.pattern];
  const diskFiles = new Set<string>();

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: collection.path,
      absolute: true,
      nodir: true,
      ignore: collection.exclude || [
        "node_modules/**", ".git/**", "dist/**", "build/**",
        "**/venv/**", "**/site-packages/**", "**/.venv/**",
        "**/tools-venv/**", "**/__pycache__/**",
      ],
    });
    matches.forEach(f => diskFiles.add(f));
  }

  // Get existing documents from DB for this collection AND path
  // Multiple collections can share the same name (e.g. "projects") but have different paths.
  // Scope to files under this collection's resolved path to avoid cross-collection deletion.
  const db = getDb();
  const collectionPath = collection.path.endsWith("/") ? collection.path : collection.path + "/";
  const existingDocs = db.prepare("SELECT path, hash, mtime FROM documents WHERE collection = ? AND path LIKE ?")
    .all(collection.name, collectionPath + "%") as Array<{ path: string; hash: string; mtime: number }>;
  
  const existingPaths = new Set(existingDocs.map(d => d.path));
  const existingByPath = new Map(existingDocs.map(d => [d.path, d]));

  // Calculate what needs to be done
  const toIndex: string[] = [];
  const toDelete: string[] = [];

  // Check files on disk
  for (const path of diskFiles) {
    const existing = existingByPath.get(path);
    if (!existing) {
      // New file
      toIndex.push(path);
    } else {
      // Check if changed — use mtime first (cheap), only hash if mtime differs
      try {
        const stats = statSync(path);
        if (stats.mtimeMs !== existing.mtime) {
          // mtime changed — verify with hash to avoid re-indexing on touch
          const content = readFileSync(path, "utf-8");
          const hash = createHash("sha256").update(content).digest("hex");
          if (hash !== existing.hash) {
            toIndex.push(path);
          } else {
            // Content unchanged despite mtime change — update mtime in DB
            db.prepare("UPDATE documents SET mtime = ? WHERE path = ?").run(stats.mtimeMs, path);
          }
        }
        // If mtime matches, skip entirely — no disk read needed
      } catch (err) {
        console.error(`Error checking ${path}:`, err);
      }
    }
  }

  // Check for deleted files
  for (const path of existingPaths) {
    if (!diskFiles.has(path)) {
      toDelete.push(path);
    }
  }

  return {
    collection,
    diskFiles: diskFiles.size,
    unchanged: diskFiles.size - toIndex.length,
    toIndex,
    toDelete,
  };
}

/**
 * Run one batched sweep across collections/projects.
 */
async function runBatchSync(reason: string, forceFullSweep = false): Promise<void> {
  if (!state.config || state.isIndexing) return;

  state.isIndexing = true;
  const startedAt = Date.now();
  const pendingFilesSnapshot = new Map(state.pendingFiles);
  const pendingCollectionsSnapshot = new Set(state.pendingCollections);
  state.pendingFiles.clear();
  state.pendingCollections.clear();

  try {
    const collections = state.config.collections;
    const collectionScope = forceFullSweep ? collections : collections.filter(c => pendingCollectionsSnapshot.has(c.name));
    const targetCollections = collectionScope.length > 0 ? collectionScope : collections;

    console.log(
      `[indexer.batch] start reason=${reason} collections=${targetCollections.length}/${collections.length} ` +
      `queued_files=${pendingFilesSnapshot.size} queued_collections=${pendingCollectionsSnapshot.size}`,
    );

    const plans = await Promise.all(targetCollections.map((collection) => buildCollectionSyncPlan(collection)));
    const toDelete = plans.flatMap((plan) => plan.toDelete);
    const toIndex: FileIndexTask[] = plans.flatMap((plan) =>
      plan.toIndex.map((path) => ({ path, collectionName: plan.collection.name })),
    );

    for (const path of toDelete) {
      deleteDocument(path);
      clearFileCache(path);
    }

    let indexed = 0;
    for (const task of toIndex) {
      const changed = await indexFile(task.path, task.collectionName);
      if (changed) indexed++;
    }

    const totalDiskFiles = plans.reduce((sum, plan) => sum + plan.diskFiles, 0);
    const totalUnchanged = plans.reduce((sum, plan) => sum + plan.unchanged, 0);
    console.log(
      `[indexer.batch] done reason=${reason} indexed=${indexed}/${toIndex.length} deleted=${toDelete.length} ` +
      `unchanged=${totalUnchanged} scanned_files=${totalDiskFiles} elapsed_ms=${Date.now() - startedAt}`,
    );
  } catch (err) {
    console.error(`[indexer.batch] failed reason=${reason}:`, err);
  } finally {
    state.isIndexing = false;
  }
}

/**
 * Index a single file
 * @returns true if file was indexed, false if skipped (unchanged)
 */
async function indexFile(path: string, collectionName: string): Promise<boolean> {
  if (!state.config) return false;
  if (shouldIgnorePath(path)) return false;

  try {
    // Check if file has changed
    const stats = statSync(path);
    const rawContent = readFileSync(path, "utf-8");
    const hash = createHash("sha256").update(rawContent).digest("hex");

    const existing = getDocument(path);
    if (existing && existing.hash === hash && existing.mtime === stats.mtimeMs) {
      // File unchanged, skip
      return false;
    }

    if (!(await ensureEmbedderAvailable())) {
      return false;
    }

    const relPath = path.replace(process.env.HOME || "", "~");
    console.log(`Indexing: ${relPath}`);

    // Parse file content (handles .jsonl and other formats)
    const parsed = parseFile(rawContent, path);
    const content = parsed.text;

    // Upsert document
    const docId = upsertDocument({
      path,
      collection: collectionName,
      mtime: stats.mtimeMs,
      hash,
    });

    // Delete old chunks and entities/relationships if re-indexing
    if (existing) {
      const oldChunks = await getInsertedChunks(docId);
      for (const chunk of oldChunks) {
        deleteEntities(chunk.id);
        deleteRelationships(chunk.id);
      }
      deleteChunks(docId);
    }

    // Chunk the file (pass filename for heading context)
    const chunkResults = chunkMarkdown(content, state.config.chunking, path);
    console.log(`  → ${chunkResults.length} chunks created`);

    // Prepare chunks for insertion
    const chunks = chunkResults.map(chunk => ({
      docId,
      text: chunk.text,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      tokenCount: chunk.tokenCount,
    }));

    // Insert chunks
    insertChunks(chunks);

    // Get chunk IDs (query back from DB)
    const insertedChunks = await getInsertedChunks(docId);

    // Extract entities and relationships for each chunk (Feature 3 + 4)
    for (const chunk of insertedChunks) {
      // Entity extraction
      const entities = patternExtract(chunk.text);
      if (entities.length > 0) {
        insertEntities(chunk.id, entities);
      }

      // Relationship extraction
      const relationships = extractRelationships(chunk.text, chunk.id);
      if (relationships.length > 0) {
        insertRelationships(relationships);
      }
    }

    // Embed chunks (with caching by text hash)
    const modelName = state.config.lmstudio.embeddingModel;
    const textsToEmbed: string[] = [];
    const chunkIndices: number[] = [];

    for (let i = 0; i < insertedChunks.length; i++) {
      const chunk = insertedChunks[i];
      const textHash = createHash("sha256").update(chunk.text).digest("hex");
      const cached = getCachedEmbedding(textHash, modelName);

      if (cached) {
        // Use cached embedding (reuses embeddings even across changed documents)
        insertEmbeddings(chunk.id!, cached);
      } else {
        // Need to embed
        textsToEmbed.push(chunk.text);
        chunkIndices.push(i);
      }
    }

    // Batch embed uncached chunks (gracefully skip if embedder is down)
    if (textsToEmbed.length > 0) {
      try {
        const embeddings = await embedBatch(textsToEmbed);

        for (let i = 0; i < embeddings.length; i++) {
          const embedding = embeddings[i];
          const chunkIdx = chunkIndices[i];
          const chunk = insertedChunks[chunkIdx];
          const textHash = createHash("sha256").update(chunk.text).digest("hex");

          // Store in vector index
          insertEmbeddings(chunk.id!, embedding);

          // Cache embedding
          setCachedEmbedding(textHash, modelName, embedding);
        }
      } catch (err) {
        // Embedder is down — log once and continue without embeddings
        // BM25 search + entity extraction still work fine
        if (!state.embedderDownLogged) {
          console.warn(`[indexer] Embedder unavailable — indexing without vector embeddings. BM25 search still works. (${err instanceof Error ? err.message : err})`);
          state.embedderDownLogged = true;
        }
      }
    }

    // Clear file from search cache
    clearFileCache(path);
    
    return true;
  } catch (err) {
    console.error(`Error indexing ${path}:`, err);
    return false;
  }
}

/**
 * Get chunks that were just inserted for a document
 */
async function getInsertedChunks(docId: number): Promise<Array<{ id: number; text: string }>> {
  const { getDb } = await import("./db.js");
  const db = getDb();
  const stmt = db.prepare("SELECT id, text FROM chunks WHERE doc_id = ?");
  return stmt.all(docId) as Array<{ id: number; text: string }>;
}

/**
 * Start file watchers for all collections
 */
function startWatchers(): void {
  if (!state.config) return;

  for (const collection of state.config.collections) {
    const patterns = Array.isArray(collection.pattern) ? collection.pattern : [collection.pattern];

    const watcher = watch(patterns, {
      cwd: collection.path,
      ignoreInitial: true,
      ignored: collection.exclude || [
        "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**",
        "**/venv/**", "**/site-packages/**", "**/.venv/**",
        "**/tools-venv/**", "**/__pycache__/**",
      ],
      awaitWriteFinish: {
        stabilityThreshold: state.config.indexing.debounceMs,
        pollInterval: 100,
      },
    });

    watcher
      .on("add", (path) => handleFileChange(join(collection.path, path), collection.name))
      .on("change", (path) => handleFileChange(join(collection.path, path), collection.name))
      .on("unlink", (path) => handleFileDelete(join(collection.path, path), collection.name));

    state.watchers.set(collection.name, watcher);
    console.log(`Watching: ${collection.name} (${collection.path})`);
  }
}

/**
 * Handle file change (add or update)
 */
async function handleFileChange(path: string, collectionName: string): Promise<void> {
  queueFileForBatch(path, collectionName, "change");
}

/**
 * Handle file deletion
 */
function handleFileDelete(path: string, collectionName: string): void {
  queueFileForBatch(path, collectionName, "delete");
}

/**
 * Pause indexing (to prioritize search requests)
 */
export function pauseIndexing(): void {
  state.isPaused = true;
}

/**
 * Resume indexing and process pending files
 */
export async function resumeIndexing(): Promise<void> {
  state.isPaused = false;

  if (state.pendingFiles.size > 0 || state.pendingCollections.size > 0) {
    console.log(
      `[indexer.batch] resume requested with queued_files=${state.pendingFiles.size} queued_collections=${state.pendingCollections.size}`,
    );
    await runBatchSync("resume", true);
  }
}

/**
 * Manually trigger re-sync of all collections
 */
export async function reindexAll(): Promise<void> {
  console.log("Manual batched re-sync triggered");
  await runBatchSync("manual", true);
}

/**
 * Stop all watchers and background sync
 */
export async function stopIndexer(): Promise<void> {
  console.log("Stopping indexer...");

  // Stop background sync
  if (state.syncIntervalHandle) {
    clearInterval(state.syncIntervalHandle);
    state.syncIntervalHandle = null;
  }

  // Stop file watchers
  for (const [name, watcher] of state.watchers) {
    await watcher.close();
    console.log(`Stopped watcher: ${name}`);
  }

  state.watchers.clear();
}

/**
 * Get indexer status
 */
export function getIndexerStatus() {
  return {
    isIndexing: state.isIndexing,
    isPaused: state.isPaused,
    pendingFiles: state.pendingFiles.size,
    pendingCollections: state.pendingCollections.size,
    watchersActive: state.watchers.size,
  };
}
