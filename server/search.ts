/**
 * Full search pipeline: BM25 + vector + query expansion + reranking + MMR + temporal decay
 * 
 * Pipeline:
 * 1. BM25 + vector search (original query) → weighted merge
 * 2. If expansion enabled: expand query → additional BM25/vector searches
 * 3. Merge expansion results into candidate pool (boost, don't replace)
 * 4. Collection filter → reranking → temporal decay → MMR → results
 */

import { bm25Search, vectorSearch, getDb } from "./db.js";
import { embed } from "./embedder.js";
import { scoreRelevanceBatch, isRerankerAvailable } from "./reranker.js";
import { extractSnippet, createCitation } from "./chunker.js";
import { expandQuery, initExpander } from "./expander.js";
import { readFileSync } from "fs";
import type { Config, SearchRequest, SearchResponse, SearchResult, ScoredChunk } from "./types.js";

let config: Config | null = null;

export function initSearch(cfg: Config): void {
  config = cfg;
  initExpander(cfg);
}

/**
 * Main search function
 */
export async function search(request: SearchRequest): Promise<SearchResponse> {
  if (!config) throw new Error("Search not initialized");

  const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
  const startTime = Date.now();
  const timings: SearchResponse["timings"] = {
    totalMs: 0,
    bm25Ms: 0,
    vectorMs: 0,
  };

  const maxResults = request.maxResults || config.search.maxResults;
  const candidateCount = maxResults * config.search.candidateMultiplier;

  // Step 1: Core search — BM25 + vector on original query
  const bm25Start = Date.now();
  const bm25Results = bm25Search(request.query, candidateCount);
  timings.bm25Ms = Date.now() - bm25Start;

  const vectorStart = Date.now();
  const queryEmbedding = await embed(request.query);
  const vectorResults = vectorSearch(queryEmbedding, candidateCount);
  timings.vectorMs = Date.now() - vectorStart;

  // Weighted merge of BM25 + vector (this produces good 0.4-0.7 range scores)
  let candidates = mergeCandidates(bm25Results, vectorResults);

  // Step 2: Query expansion — add more candidates from expanded queries
  let expandedQueries: string[] | undefined;
  if (config.search.queryExpansion.enabled) {
    const expansionStart = Date.now();
    const expansions = await expandQuery(request.query);
    timings.expansionMs = Date.now() - expansionStart;

    if (expansions.length > 0) {
      expandedQueries = expansions.map(e => `${e.type}:${e.text}`);
      expansions.forEach(exp => {
        console.log(`  ${exp.type}: "${exp.text}"`);
      });

      // Run additional searches for each expansion
      for (const expansion of expansions) {
        if (expansion.type === 'lex') {
          // BM25 search with expanded keywords
          const lexResults = bm25Search(expansion.text, candidateCount);
          mergeAdditionalBM25(candidates, lexResults, 0.5); // 50% weight for expansions
        } else {
          // vec/hyde → embed and vector search
          const vecStart = Date.now();
          const expEmbedding = await embed(expansion.text);
          const expResults = vectorSearch(expEmbedding, candidateCount);
          mergeAdditionalVector(candidates, expResults, 0.5); // 50% weight for expansions
          timings.vectorMs += Date.now() - vecStart;
        }
      }

      // Re-sort after merging expansion results
      candidates.sort((a, b) => b.score - a.score);
    }
  }

  // Step 3: Collection filter
  if (request.collections && request.collections.length > 0) {
    candidates = candidates.filter(c => request.collections!.includes(c.collection));
  }

  // Step 4: Reranking (if available)
  if (config.search.reranking.enabled && isRerankerAvailable()) {
    const rerankStart = Date.now();
    const topCandidates = candidates.slice(0, config.search.reranking.candidateCount);
    candidates = await rerankCandidates(request.query, topCandidates);
    timings.rerankMs = Date.now() - rerankStart;
  }

  // Step 5: Temporal decay
  if (config.search.temporalDecay.enabled) {
    candidates = applyTemporalDecay(candidates);
  }

  // Step 6: MMR diversity
  let results: ScoredChunk[];
  if (config.search.mmr.enabled) {
    results = applyMMR(candidates, maxResults);
  } else {
    results = candidates.slice(0, maxResults);
  }

  // Step 7: Min score filter
  if (request.minScore !== undefined) {
    results = results.filter(r => r.score >= request.minScore!);
  }

  // Step 8: Build response
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

  // Logging
  const parts = [`bm25:${timings.bm25Ms}ms`, `vec:${timings.vectorMs}ms`];
  if (timings.expansionMs !== undefined) parts.push(`expand:${timings.expansionMs}ms`);
  if (timings.rerankMs !== undefined) parts.push(`rerank:${timings.rerankMs}ms`);
  console.log(`[${timestamp}] SEARCH "${request.query}" → ${searchResults.length} results in ${timings.totalMs}ms (${parts.join(' ')})`);
  searchResults.slice(0, 5).forEach((r, i) => {
    console.log(`  #${i + 1} [${r.score.toFixed(3)}] ${r.citation}`);
  });

  return {
    results: searchResults,
    query: request.query,
    expandedQueries,
    timings,
  };
}

// ============================================================================
// Candidate merging
// ============================================================================

/**
 * Primary merge: BM25 + vector with configurable weights.
 * Produces scores in ~0.3-0.8 range.
 */
function mergeCandidates(
  bm25Results: Array<{ id: number; rank: number }>,
  vectorResults: Array<{ chunkId: number; distance: number }>
): ScoredChunk[] {
  if (!config) throw new Error("Search not initialized");

  const db = getDb();
  const candidateMap = new Map<number, ScoredChunk>();

  for (const result of bm25Results) {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.id) as any;
    if (!chunk) continue;
    const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
    if (!doc) continue;

    const bm25Score = Math.exp(result.rank / 10);

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

  for (const result of vectorResults) {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.chunkId) as any;
    if (!chunk) continue;
    const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
    if (!doc) continue;

    const vectorScore = 1 - result.distance / 2;

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

  const candidates = Array.from(candidateMap.values());
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/**
 * Merge additional BM25 results from expansion into existing candidates.
 * Boosts existing candidates or adds new ones at reduced weight.
 */
function mergeAdditionalBM25(
  candidates: ScoredChunk[],
  bm25Results: Array<{ id: number; rank: number }>,
  weight: number
): void {
  if (!config) return;
  const db = getDb();
  const existingMap = new Map(candidates.map(c => [c.id, c]));

  for (const result of bm25Results) {
    const bm25Score = Math.exp(result.rank / 10);
    const addScore = config.search.textWeight * bm25Score * weight;

    const existing = existingMap.get(result.id);
    if (existing) {
      existing.score += addScore; // Boost existing candidate
    } else {
      const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.id) as any;
      if (!chunk) continue;
      const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
      if (!doc) continue;

      const newChunk: ScoredChunk = {
        id: result.id,
        docId: chunk.doc_id,
        text: chunk.text,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        tokenCount: chunk.token_count,
        path: doc.path,
        collection: doc.collection,
        score: addScore,
        bm25Score,
      };
      candidates.push(newChunk);
      existingMap.set(result.id, newChunk);
    }
  }
}

/**
 * Merge additional vector results from expansion into existing candidates.
 */
function mergeAdditionalVector(
  candidates: ScoredChunk[],
  vectorResults: Array<{ chunkId: number; distance: number }>,
  weight: number
): void {
  if (!config) return;
  const db = getDb();
  const existingMap = new Map(candidates.map(c => [c.id, c]));

  for (const result of vectorResults) {
    const vectorScore = 1 - result.distance / 2;
    const addScore = config.search.vectorWeight * vectorScore * weight;

    const existing = existingMap.get(result.chunkId);
    if (existing) {
      existing.score += addScore; // Boost existing candidate
    } else {
      const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.chunkId) as any;
      if (!chunk) continue;
      const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
      if (!doc) continue;

      const newChunk: ScoredChunk = {
        id: result.chunkId,
        docId: chunk.doc_id,
        text: chunk.text,
        startLine: chunk.start_line,
        endLine: chunk.end_line,
        tokenCount: chunk.token_count,
        path: doc.path,
        collection: doc.collection,
        score: addScore,
        vectorScore,
      };
      candidates.push(newChunk);
      existingMap.set(result.chunkId, newChunk);
    }
  }
}

// ============================================================================
// Post-processing
// ============================================================================

async function rerankCandidates(query: string, candidates: ScoredChunk[]): Promise<ScoredChunk[]> {
  const documents = candidates.map(c => c.text);
  const rerankScores = await scoreRelevanceBatch(query, documents);
  const normalizedScores = rerankScores.map(s => s / 10);

  const reranked = candidates.map((chunk, i) => ({
    ...chunk,
    rerankScore: normalizedScores[i],
    score: normalizedScores[i],
  }));

  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}

function applyTemporalDecay(candidates: ScoredChunk[]): ScoredChunk[] {
  if (!config) throw new Error("Search not initialized");

  const halfLifeDays = config.search.temporalDecay.halfLifeDays;
  const lambda = Math.log(2) / halfLifeDays;
  const now = Date.now();

  return candidates.map(chunk => {
    const dateMatch = chunk.path.match(/(\d{4}-\d{2}-\d{2})/);
    if (!dateMatch) return chunk; // Evergreen, no decay

    const fileDate = new Date(dateMatch[1]);
    const ageInDays = (now - fileDate.getTime()) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.exp(-lambda * ageInDays);

    return { ...chunk, score: chunk.score * decayFactor };
  });
}

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

      let maxSimilarity = 0;
      for (const sel of selected) {
        const similarity = jaccardSimilarity(candidate.text, sel.text);
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }

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

function jaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(text1.toLowerCase().split(/\s+/));
  const tokens2 = new Set(text2.toLowerCase().split(/\s+/));
  const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
  const union = new Set([...tokens1, ...tokens2]);
  return intersection.size / union.size;
}

// ============================================================================
// File cache
// ============================================================================

const fileCache = new Map<string, string>();

function readFileContent(path: string): string {
  if (fileCache.has(path)) return fileCache.get(path)!;
  try {
    const content = readFileSync(path, "utf-8");
    fileCache.set(path, content);
    return content;
  } catch {
    return "";
  }
}

export function clearFileCache(path?: string): void {
  if (path) fileCache.delete(path);
  else fileCache.clear();
}
