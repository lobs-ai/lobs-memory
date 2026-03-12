/**
 * Full search pipeline: BM25 + vector + reranking + MMR + temporal decay
 */

import { bm25Search, vectorSearch, getDb, getAllChunks, getDocument } from "./db.js";
import { embed } from "./embedder.js";
import { scoreRelevanceBatch, isRerankerAvailable } from "./reranker.js";
import { extractSnippet, createCitation } from "./chunker.js";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import type { Config, SearchRequest, SearchResponse, SearchResult, ScoredChunk } from "./types.js";

let config: Config | null = null;

export function initSearch(cfg: Config): void {
  config = cfg;
}

/**
 * Main search function
 */
export async function search(request: SearchRequest): Promise<SearchResponse> {
  if (!config) {
    throw new Error("Search not initialized");
  }

  const startTime = Date.now();
  const timings: SearchResponse["timings"] = {
    totalMs: 0,
    bm25Ms: 0,
    vectorMs: 0,
  };

  const maxResults = request.maxResults || config.search.maxResults;
  const candidateCount = maxResults * config.search.candidateMultiplier;

  // 1. BM25 search
  const bm25Start = Date.now();
  const bm25Results = bm25Search(request.query, candidateCount);
  timings.bm25Ms = Date.now() - bm25Start;

  // 2. Vector search
  const vectorStart = Date.now();
  const queryEmbedding = await embed(request.query);
  const vectorResults = vectorSearch(queryEmbedding, candidateCount);
  timings.vectorMs = Date.now() - vectorStart;

  // 3. Merge and score candidates
  const candidates = mergeCandidates(bm25Results, vectorResults);

  // 4. Rerank if available
  let reranked = candidates;
  if (config.search.reranking.enabled && isRerankerAvailable()) {
    const rerankStart = Date.now();
    const topCandidates = candidates.slice(0, config.search.reranking.candidateCount);
    reranked = await rerankCandidates(request.query, topCandidates);
    timings.rerankMs = Date.now() - rerankStart;
  }

  // 5. Apply temporal decay
  if (config.search.temporalDecay.enabled) {
    reranked = applyTemporalDecay(reranked);
  }

  // 6. MMR diversity filtering
  let results = reranked;
  if (config.search.mmr.enabled) {
    results = applyMMR(reranked, maxResults);
  } else {
    results = reranked.slice(0, maxResults);
  }

  // 7. Apply min score filter if specified
  if (request.minScore !== undefined) {
    results = results.filter(r => r.score >= request.minScore!);
  }

  // 8. Convert to search results
  const searchResults: SearchResult[] = results.map(chunk => {
    const fileContent = readFileContent(chunk.path);
    const snippet = extractSnippet(fileContent, chunk.startLine, chunk.endLine);
    const citation = createCitation(chunk.path, chunk.startLine, chunk.endLine);

    return {
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      score: chunk.score,
      snippet,
      source: chunk.collection,
      citation,
    };
  });

  timings.totalMs = Date.now() - startTime;

  return {
    results: searchResults,
    query: request.query,
    timings,
  };
}

/**
 * Merge BM25 and vector search results with weighted scoring
 */
function mergeCandidates(
  bm25Results: Array<{ id: number; rank: number }>,
  vectorResults: Array<{ chunkId: number; distance: number }>
): ScoredChunk[] {
  if (!config) throw new Error("Search not initialized");

  const db = getDb();
  const candidateMap = new Map<number, ScoredChunk>();

  // Add BM25 results
  for (const result of bm25Results) {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.id) as any;
    if (!chunk) continue;

    const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
    if (!doc) continue;

    const bm25Score = 1 / (1 + Math.max(0, -result.rank)); // FTS5 rank is negative

    candidateMap.set(result.id, {
      id: result.id,
      docId: chunk.doc_id,
      text: chunk.text,
      startLine: chunk.start_line,
      endLine: chunk.end_line,
      tokenCount: chunk.token_count,
      path: doc.path,
      collection: doc.collection,
      score: config.search.textWeight * bm25Score,
      bm25Score,
    });
  }

  // Add vector results
  for (const result of vectorResults) {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.chunkId) as any;
    if (!chunk) continue;

    const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
    if (!doc) continue;

    const vectorScore = 1 / (1 + result.distance); // Convert distance to similarity

    const existing = candidateMap.get(result.chunkId);
    if (existing) {
      existing.score += config.search.vectorWeight * vectorScore;
      existing.vectorScore = vectorScore;
    } else {
      candidateMap.set(result.chunkId, {
        id: result.chunkId,
        docId: chunk.doc_id,
        text: chunk.text,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        tokenCount: chunk.token_count,
        path: doc.path,
        collection: doc.collection,
        score: config.search.vectorWeight * vectorScore,
        vectorScore,
      });
    }
  }

  // Sort by merged score
  const candidates = Array.from(candidateMap.values());
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

/**
 * Rerank candidates using cross-encoder
 */
async function rerankCandidates(query: string, candidates: ScoredChunk[]): Promise<ScoredChunk[]> {
  const documents = candidates.map(c => c.text);
  const rerankScores = await scoreRelevanceBatch(query, documents);

  // Update scores and re-sort
  const reranked = candidates.map((chunk, i) => ({
    ...chunk,
    rerankScore: rerankScores[i],
    score: rerankScores[i], // Replace score with rerank score
  }));

  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}

/**
 * Apply temporal decay to scores based on file date
 */
function applyTemporalDecay(candidates: ScoredChunk[]): ScoredChunk[] {
  if (!config) throw new Error("Search not initialized");

  const halfLifeDays = config.search.temporalDecay.halfLifeDays;
  const lambda = Math.log(2) / halfLifeDays;
  const now = Date.now();

  return candidates.map(chunk => {
    // Extract date from filename (YYYY-MM-DD.md)
    const dateMatch = chunk.path.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) {
      // Evergreen file, no decay
      return chunk;
    }

    const fileDate = new Date(dateMatch[1]);
    const ageInDays = (now - fileDate.getTime()) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.exp(-lambda * ageInDays);

    return {
      ...chunk,
      score: chunk.score * decayFactor,
    };
  });
}

/**
 * Maximal Marginal Relevance (MMR) for diversity
 */
function applyMMR(candidates: ScoredChunk[], k: number): ScoredChunk[] {
  if (!config) throw new Error("Search not initialized");

  const lambda = config.search.mmr.lambda;
  const selected: ScoredChunk[] = [];
  const remaining = [...candidates];

  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = candidate.score;

      // Calculate max similarity to already-selected results
      let maxSimilarity = 0;
      for (const sel of selected) {
        const similarity = jaccardSimilarity(candidate.text, sel.text);
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }

      // MMR score: λ * relevance - (1-λ) * maxSimilarity
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

/**
 * Jaccard similarity between two text strings (for MMR diversity)
 */
function jaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(text1.toLowerCase().split(/\s+/));
  const tokens2 = new Set(text2.toLowerCase().split(/\s+/));

  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);

  return intersection.size / union.size;
}

/**
 * Read file content (cached in memory for performance)
 */
const fileCache = new Map<string, string>();

function readFileContent(path: string): string {
  if (fileCache.has(path)) {
    return fileCache.get(path)!;
  }

  try {
    const content = readFileSync(path, "utf-8");
    fileCache.set(path, content);
    return content;
  } catch (err) {
    console.error(`Error reading file ${path}:`, err);
    return "";
  }
}

/**
 * Clear file cache (call when files change)
 */
export function clearFileCache(path?: string): void {
  if (path) {
    fileCache.delete(path);
  } else {
    fileCache.clear();
  }
}
