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
import type { Config, Collection } from "./types.js";

interface IndexerState {
  config: Config | null;
  watchers: Map<string, any>;
  isIndexing: boolean;
  isPaused: boolean;
  pendingFiles: Set<string>;
  syncIntervalHandle: Timer | null;
  embedderDownLogged: boolean;
}

const state: IndexerState = {
  config: null,
  watchers: new Map(),
  isIndexing: false,
  isPaused: false,
  pendingFiles: new Set(),
  embedderDownLogged: false,
  syncIntervalHandle: null,
};

/**
 * Initialize indexer and start file watchers
 */
export async function startIndexer(config: Config): Promise<void> {
  state.config = config;

  console.log("Starting incremental index sync...");
  await incrementalSyncAllCollections();

  if (config.indexing.watchEnabled) {
    console.log("Starting file watchers...");
    startWatchers();
  }

  // Start background periodic sync
  const syncIntervalMs = (config.indexing as any).syncIntervalMs || 60000; // Default 60s
  console.log(`Starting background sync (interval: ${syncIntervalMs}ms)`);
  state.syncIntervalHandle = setInterval(async () => {
    if (!state.isPaused && !state.isIndexing) {
      await incrementalSyncAllCollections();
    }
  }, syncIntervalMs);

  console.log("Indexer ready");
}

/**
 * Incremental sync for all collections (only re-index changed/new files)
 */
async function incrementalSyncAllCollections(): Promise<void> {
  if (!state.config) return;

  for (const collection of state.config.collections) {
    await incrementalSyncCollection(collection);
  }
}

/**
 * Incremental sync for a single collection
 */
async function incrementalSyncCollection(collection: Collection): Promise<void> {
  if (!state.config) return;

  const startTime = Date.now();
  console.log(`Syncing collection: ${collection.name} (${collection.path})`);

  // Find all matching files on disk
  const patterns = Array.isArray(collection.pattern) ? collection.pattern : [collection.pattern];
  const diskFiles = new Set<string>();

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: collection.path,
      absolute: true,
      nodir: true,
      ignore: (collection as any).exclude || ["node_modules/**", ".git/**", "dist/**", "build/**"],
    });
    matches.forEach(f => diskFiles.add(f));
  }

  // Get existing documents from DB for this collection
  const db = getDb();
  const existingDocs = db.prepare("SELECT path, hash, mtime FROM documents WHERE collection = ?")
    .all(collection.name) as Array<{ path: string; hash: string; mtime: number }>;
  
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
      // Check if changed (compare hash/mtime)
      try {
        const stats = statSync(path);
        const content = readFileSync(path, "utf-8");
        const hash = createHash("sha256").update(content).digest("hex");
        
        if (hash !== existing.hash || stats.mtimeMs !== existing.mtime) {
          toIndex.push(path);
        }
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

  // Perform incremental updates
  let indexed = 0;
  for (const path of toIndex) {
    const changed = await indexFile(path, collection.name);
    if (changed) indexed++;
  }

  for (const path of toDelete) {
    deleteDocument(path);
    clearFileCache(path);
  }

  const skipped = diskFiles.size - toIndex.length;
  const elapsed = Date.now() - startTime;
  
  console.log(
    `Incremental sync (${collection.name}): ${toIndex.length} new/changed, ${toDelete.length} deleted (skipped ${skipped} unchanged) — ${elapsed}ms`
  );
}

/**
 * Index a single file
 * @returns true if file was indexed, false if skipped (unchanged)
 */
async function indexFile(path: string, collectionName: string): Promise<boolean> {
  if (!state.config) return false;

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
      awaitWriteFinish: {
        stabilityThreshold: state.config.indexing.debounceMs,
        pollInterval: 100,
      },
    });

    watcher
      .on("add", (path) => handleFileChange(join(collection.path, path), collection.name))
      .on("change", (path) => handleFileChange(join(collection.path, path), collection.name))
      .on("unlink", (path) => handleFileDelete(join(collection.path, path)));

    state.watchers.set(collection.name, watcher);
    console.log(`Watching: ${collection.name} (${collection.path})`);
  }
}

/**
 * Handle file change (add or update)
 */
async function handleFileChange(path: string, collectionName: string): Promise<void> {
  if (state.isPaused) {
    state.pendingFiles.add(path);
    return;
  }

  console.log(`File changed: ${path}`);
  await indexFile(path, collectionName);
}

/**
 * Handle file deletion
 */
function handleFileDelete(path: string): void {
  console.log(`File deleted: ${path}`);
  deleteDocument(path);
  clearFileCache(path);
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

  if (state.pendingFiles.size > 0) {
    console.log(`Processing ${state.pendingFiles.size} pending files...`);
    const pending = Array.from(state.pendingFiles);
    state.pendingFiles.clear();

    for (const path of pending) {
      // Find collection for this file
      const collection = state.config?.collections.find(c => path.startsWith(c.path));
      if (collection) {
        await indexFile(path, collection.name);
      }
    }
  }
}

/**
 * Manually trigger re-sync of all collections
 */
export async function reindexAll(): Promise<void> {
  console.log("Manual re-sync triggered");
  await incrementalSyncAllCollections();
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
    watchersActive: state.watchers.size,
  };
}
