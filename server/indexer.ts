/**
 * File indexing with watching and embedding cache
 */

import { watch } from "chokidar";
import { readFileSync, statSync } from "fs";
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
} from "./db.js";
import { chunkMarkdown } from "./chunker.js";
import { embedBatch } from "./embedder.js";
import { clearFileCache } from "./search.js";
import type { Config, Collection } from "./types.js";

interface IndexerState {
  config: Config | null;
  watchers: Map<string, any>;
  isIndexing: boolean;
  isPaused: boolean;
  pendingFiles: Set<string>;
}

const state: IndexerState = {
  config: null,
  watchers: new Map(),
  isIndexing: false,
  isPaused: false,
  pendingFiles: new Set(),
};

/**
 * Initialize indexer and start file watchers
 */
export async function startIndexer(config: Config): Promise<void> {
  state.config = config;

  console.log("Starting initial index scan...");
  await indexAllCollections();

  if (config.indexing.watchEnabled) {
    console.log("Starting file watchers...");
    startWatchers();
  }

  console.log("Indexer ready");
}

/**
 * Index all configured collections
 */
async function indexAllCollections(): Promise<void> {
  if (!state.config) return;

  for (const collection of state.config.collections) {
    await indexCollection(collection);
  }
}

/**
 * Index a single collection
 */
async function indexCollection(collection: Collection): Promise<void> {
  if (!state.config) return;

  const startTime = Date.now();
  console.log(`Indexing collection: ${collection.name} (${collection.path})`);

  // Find all matching files
  const patterns = Array.isArray(collection.pattern) ? collection.pattern : [collection.pattern];
  const files: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: collection.path,
      absolute: true,
      nodir: true,
    });
    files.push(...matches);
  }

  console.log(`Found ${files.length} files in ${collection.name}`);

  // Index each file
  let indexed = 0;
  for (const file of files) {
    const changed = await indexFile(file, collection.name);
    if (changed) indexed++;
  }

  const elapsed = Date.now() - startTime;
  console.log(`Collection ${collection.name}: ${indexed}/${files.length} files indexed in ${elapsed}ms`);
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
    const content = readFileSync(path, "utf-8");
    const hash = createHash("sha256").update(content).digest("hex");

    const existing = getDocument(path);
    if (existing && existing.hash === hash && existing.mtime === stats.mtimeMs) {
      // File unchanged, skip
      return false;
    }

    const relPath = path.replace(process.env.HOME || "", "~");
    console.log(`Indexing: ${relPath}`);

    // Upsert document
    const docId = upsertDocument({
      path,
      collection: collectionName,
      mtime: stats.mtimeMs,
      hash,
    });

    // Delete old chunks if re-indexing
    if (existing) {
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

    // Embed chunks (with caching)
    const modelName = state.config.lmstudio.embeddingModel;
    const textsToEmbed: string[] = [];
    const chunkIndices: number[] = [];

    for (let i = 0; i < insertedChunks.length; i++) {
      const chunk = insertedChunks[i];
      const textHash = createHash("sha256").update(chunk.text).digest("hex");
      const cached = getCachedEmbedding(textHash, modelName);

      if (cached) {
        // Use cached embedding
        insertEmbeddings(chunk.id!, cached);
      } else {
        // Need to embed
        textsToEmbed.push(chunk.text);
        chunkIndices.push(i);
      }
    }

    // Batch embed uncached chunks
    if (textsToEmbed.length > 0) {
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
 * Manually trigger re-index of all collections
 */
export async function reindexAll(): Promise<void> {
  console.log("Manual re-index triggered");
  await indexAllCollections();
}

/**
 * Stop all watchers
 */
export async function stopIndexer(): Promise<void> {
  console.log("Stopping indexer...");

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
