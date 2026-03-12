/**
 * SQLite database with FTS5 and sqlite-vec support
 * Uses Bun's built-in bun:sqlite
 */

import { Database } from "bun:sqlite";
import { join, dirname } from "path";
import { mkdirSync, existsSync } from "fs";
import type { Chunk } from "./types.js";

export interface Document {
  id?: number;
  path: string;
  collection: string;
  mtime: number;
  hash: string;
  updatedAt?: string;
}

let db: Database | null = null;

export function initDb(dbPath?: string): Database {
  const path = dbPath || join(process.env.HOME || "~", ".openclaw", "plugins", "lobs-memory", "index.db");
  
  // Ensure directory exists
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  db = new Database(path, { create: true });

  // Enable WAL mode for better concurrency
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");



  createTables(db);
  return db;
}

export function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

function createTables(db: Database): void {
  // Enable foreign keys
  db.exec("PRAGMA foreign_keys = ON;");

  // Documents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      collection TEXT NOT NULL,
      mtime REAL NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection)`);

  // Chunks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      token_count INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id)`);

  // FTS5 for BM25 search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text,
      content=chunks,
      content_rowid=id,
      tokenize='porter unicode61'
    );
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
    END;
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
      INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  // Embeddings stored in regular table, cosine similarity computed in JS
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
  `);

  // Embedding cache
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  console.log("Database tables initialized");
}

// Document operations
export function upsertDocument(doc: Document): number {
  const stmt = db!.prepare(`
    INSERT INTO documents (path, collection, mtime, hash)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      collection = excluded.collection,
      mtime = excluded.mtime,
      hash = excluded.hash,
      updated_at = datetime('now')
    RETURNING id
  `);

  const result = stmt.get(doc.path, doc.collection, doc.mtime, doc.hash) as { id: number };
  return result.id;
}

export function getDocument(path: string): Document | null {
  const stmt = db!.prepare("SELECT * FROM documents WHERE path = ?");
  return stmt.get(path) as Document | null;
}

export function deleteDocument(path: string): void {
  db!.prepare("DELETE FROM documents WHERE path = ?").run(path);
}

// Chunk operations
export function insertChunks(chunks: Chunk[]): void {
  const stmt = db!.prepare(`
    INSERT INTO chunks (doc_id, text, start_line, end_line, token_count)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Bun's SQLite doesn't have transactions the same way, use a loop
  for (const chunk of chunks) {
    stmt.run(chunk.docId, chunk.text, chunk.startLine, chunk.endLine, chunk.tokenCount);
  }
}

export function deleteChunks(docId: number): void {
  // Delete embeddings for these chunks first
  db!.prepare("DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM chunks WHERE doc_id = ?)").run(docId);
  db!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId);
  embeddingCache = null; // Invalidate cache
}

export function getAllChunks(docId: number): Chunk[] {
  const stmt = db!.prepare("SELECT * FROM chunks WHERE doc_id = ?");
  return stmt.all(docId) as Chunk[];
}

// Vector operations — in-memory cosine similarity (fast for <10k chunks)
export function insertEmbeddings(chunkId: number, embedding: Float32Array): void {
  const stmt = db!.prepare("INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)");
  stmt.run(chunkId, Buffer.from(embedding.buffer));
  // Invalidate cache
  embeddingCache = null;
}

// Cache all embeddings in memory for fast search
let embeddingCache: Array<{ chunkId: number; embedding: Float32Array }> | null = null;

function loadEmbeddingCache(): Array<{ chunkId: number; embedding: Float32Array }> {
  if (embeddingCache) return embeddingCache;
  const rows = db!.prepare("SELECT chunk_id, embedding FROM chunk_embeddings").all() as Array<{ chunk_id: number; embedding: Buffer }>;
  embeddingCache = rows.map(r => ({
    chunkId: r.chunk_id,
    embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
  }));
  console.log(`Loaded ${embeddingCache.length} embeddings into memory cache`);
  return embeddingCache;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export function vectorSearch(queryEmbedding: Float32Array, limit: number): Array<{ chunkId: number; distance: number }> {
  const cache = loadEmbeddingCache();
  if (cache.length === 0) return [];

  // Compute cosine similarity for all chunks, return top-k
  const scored = cache.map(entry => ({
    chunkId: entry.chunkId,
    similarity: cosineSimilarity(queryEmbedding, entry.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  // Convert similarity to distance (cosine distance = 1 - similarity, range [0, 2])
  return scored.slice(0, limit).map(s => ({
    chunkId: s.chunkId,
    distance: 1 - s.similarity,
  }));
}

export function invalidateEmbeddingCache(): void {
  embeddingCache = null;
}

// BM25 search with FTS5 query escaping
export function bm25Search(query: string, limit: number): Array<{ id: number; rank: number }> {
  // Escape FTS5 special characters by wrapping each word in double quotes
  const escapedQuery = query
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => `"${w.replace(/"/g, '""')}"`)  // Escape any quotes in the word
    .join(" ");

  try {
    const stmt = db!.prepare(`
      SELECT rowid as id, rank as rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(escapedQuery, limit) as Array<{ id: number; rank: number }>;
  } catch (err) {
    console.error("BM25 search error (returning empty results):", err);
    return [];
  }
}

// Embedding cache
export function getCachedEmbedding(textHash: string, model: string): Float32Array | null {
  const stmt = db!.prepare("SELECT embedding FROM embedding_cache WHERE text_hash = ? AND model = ?");
  const row = stmt.get(textHash, model) as { embedding: Buffer } | undefined;
  if (row) {
    return new Float32Array(row.embedding.buffer);
  }
  return null;
}

export function setCachedEmbedding(textHash: string, model: string, embedding: Float32Array): void {
  const stmt = db!.prepare(`
    INSERT OR REPLACE INTO embedding_cache (text_hash, model, embedding)
    VALUES (?, ?, ?)
  `);
  stmt.run(textHash, model, Buffer.from(embedding.buffer));
}

// Stats
export function getIndexStats() {
  const docCount = db!.prepare("SELECT COUNT(*) as count FROM documents").get() as { count: number };
  const chunkCount = db!.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
  const collections = db!.prepare("SELECT DISTINCT collection FROM documents").all() as Array<{ collection: string }>;
  const lastUpdate = db!.prepare("SELECT MAX(updated_at) as lastUpdate FROM documents").get() as { lastUpdate: string | null };

  return {
    documents: docCount.count,
    chunks: chunkCount.count,
    collections: collections.map(c => c.collection),
    lastUpdate: lastUpdate.lastUpdate,
  };
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
