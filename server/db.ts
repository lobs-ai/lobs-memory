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
  // Documents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      collection TEXT NOT NULL,
      mtime REAL NOT NULL,
      hash TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection);
  `);

  // Chunks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      token_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
  `);

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

  // sqlite-vec for vector search (optional, graceful fallback)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding FLOAT[768]
      );
    `);
  } catch (err) {
    console.warn("sqlite-vec not available, will use in-memory cosine similarity fallback");
  }

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
  db!.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId);
}

export function getAllChunks(docId: number): Chunk[] {
  const stmt = db!.prepare("SELECT * FROM chunks WHERE doc_id = ?");
  return stmt.all(docId) as Chunk[];
}

// Vector operations
export function insertEmbeddings(chunkId: number, embedding: Float32Array): void {
  try {
    const stmt = db!.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)");
    stmt.run(chunkId, Buffer.from(embedding.buffer));
  } catch (err) {
    // sqlite-vec not available, skip
  }
}

export function vectorSearch(embedding: Float32Array, limit: number): Array<{ chunkId: number; distance: number }> {
  try {
    const stmt = db!.prepare(`
      SELECT chunk_id as chunkId, distance
      FROM chunks_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `);
    return stmt.all(Buffer.from(embedding.buffer), limit) as Array<{ chunkId: number; distance: number }>;
  } catch (err) {
    console.warn("Vector search unavailable:", err);
    return [];
  }
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
