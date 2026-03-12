/**
 * Full search pipeline: BM25 + vector + reranking + MMR + temporal decay + query expansion
 */

import { bm25Search, vectorSearch, getDb, getAllChunks, getDocument } from "./db.js";
import { embed } from "./embedder.js";
import { scoreRelevanceBatch, isRerankerAvailable } from "./reranker.js";
import { extractSnippet, createCitation } from "./chunker.js";
import { expandQuery, initExpander } from "./expander.js";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import type { Config, SearchRequest, SearchResponse, SearchResult, ScoredChunk } from "./types.js";

let config: Config | null = null;

export function initSearch(cfg: Config): void {
  config = cfg;
  initExpander(cfg);
}

/**
 * Reciprocal Rank Fusion (RRF) for combining multiple ranked lists
 */
function reciprocalRankFusion(
  rankedLists: ScoredChunk[][],
  k: number = 60
): ScoredChunk[] {
  const scores = new Map<number, { chunk: ScoredChunk; score: number }>();
  
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const chunk = list[i];
      const existing = scores.get(chunk.id!);
      const rrfScore = 1 / (k + i + 1);
      
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(chunk.id!, { chunk, score: rrfScore });
      }
    }
  }
  
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ chunk, score }) => ({ ...chunk, score }));
}

/**
 * Main search function
 */
export async function search(request: SearchRequest): Promise<SearchResponse> {
  if (!config) {
    throw new Error("Search not initialized");
  }

  const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
  const startTime = Date.now();
  const timings: SearchResponse["timings"] = {
    totalMs: 0,
    bm25Ms: 0,
    vectorMs: 0,
  };

  const maxResults = request.maxResults || config.search.maxResults;
  const candidateCount = maxResults * config.search.candidateMultiplier;

  // 1. BM25 probe (original query)
  const bm25Start = Date.now();
  const bm25Results = bm25Search(request.query, candidateCount);
  timings.bm25Ms = Date.now() - bm25Start;

  // 2. Check for strong signal (fast path)
  let shouldExpand = config.search.queryExpansion.enabled;
  if (config.search.queryExpansion.enabled && bm25Results.length >= 2) {
    const threshold = config.search.queryExpansion.strongSignalThreshold || 0.8;
    const topScore = Math.exp(bm25Results[0].rank / 10);
    const secondScore = Math.exp(bm25Results[1].rank / 10);
    
    // If top result has strong signal AND is significantly better than #2, skip expansion (fast path)
    if (topScore >= threshold && topScore / secondScore >= 1.5) {
      shouldExpand = false;
    }
  }

  let expandedQueries: string[] | undefined;
  let candidates: ScoredChunk[] = [];

  // 3. Query expansion path
  if (shouldExpand) {
    const expansionStart = Date.now();
    
    console.log(`[${timestamp}] SEARCH "${request.query}" → expanding...`);
    const expansions = await expandQuery(request.query);
    timings.expansionMs = Date.now() - expansionStart;
    
    if (expansions.length > 0) {
      // Log expanded queries
      expansions.forEach(exp => {
        console.log(`  ${exp.type}: "${exp.text}"`);
      });
      
      expandedQueries = expansions.map(e => `${e.type}:${e.text}`);
      
      // Collect all ranked lists for RRF
      const rankedLists: ScoredChunk[][] = [];
      
      // Original BM25 results (already have them)
      const bm25Candidates = bm25Results.map(r => {
        const db = getDb();
        const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(r.id) as any;
        const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
        const bm25Score = Math.exp(r.rank / 10);
        
        return {
          id: r.id,
          docId: chunk.doc_id,
          text: chunk.text,
          startLine: chunk.start_line,
          endLine: chunk.end_line,
          tokenCount: chunk.token_count,
          path: doc.path,
          collection: doc.collection,
          score: bm25Score,
          bm25Score,
        };
      });
      rankedLists.push(bm25Candidates);
      
      // Original vector search
      const vectorStart = Date.now();
      const queryEmbedding = await embed(request.query);
      const vectorResults = vectorSearch(queryEmbedding, candidateCount);
      const vectorCandidates = vectorResults.map(r => {
        const db = getDb();
        const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(r.chunkId) as any;
        const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
        const vectorScore = 1 - r.distance / 2;
        
        return {
          id: r.chunkId,
          docId: chunk.doc_id,
          text: chunk.text,
          startLine: chunk.start_line,
          endLine: chunk.end_line,
          tokenCount: chunk.token_count,
          path: doc.path,
          collection: doc.collection,
          score: vectorScore,
          vectorScore,
        };
      });
      rankedLists.push(vectorCandidates);
      timings.vectorMs += Date.now() - vectorStart;
      
      // Search with each expansion
      for (const expansion of expansions) {
        if (expansion.type === 'lex') {
          // Keyword expansion → BM25
          const lexResults = bm25Search(expansion.text, candidateCount);
          const lexCandidates = lexResults.map(r => {
            const db = getDb();
            const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(r.id) as any;
            const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
            const bm25Score = Math.exp(r.rank / 10);
            
            return {
              id: r.id,
              docId: chunk.doc_id,
              text: chunk.text,
              startLine: chunk.start_line,
              endLine: chunk.end_line,
              tokenCount: chunk.token_count,
              path: doc.path,
              collection: doc.collection,
              score: bm25Score,
              bm25Score,
            };
          });
          rankedLists.push(lexCandidates);
        } else {
          // vec or hyde → embed + vector search
          const expEmbedding = await embed(expansion.text);
          const expResults = vectorSearch(expEmbedding, candidateCount);
          const expCandidates = expResults.map(r => {
            const db = getDb();
            const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(r.chunkId) as any;
            const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
            const vectorScore = 1 - r.distance / 2;
            
            return {
              id: r.chunkId,
              docId: chunk.doc_id,
              text: chunk.text,
              startLine: chunk.start_line,
              endLine: chunk.end_line,
              tokenCount: chunk.token_count,
              path: doc.path,
              collection: doc.collection,
              score: vectorScore,
              vectorScore,
            };
          });
          rankedLists.push(expCandidates);
        }
      }
      
      // Fuse all results with RRF
      candidates = reciprocalRankFusion(rankedLists);
    } else {
      // Expansion failed, fall back to standard merge
      const vectorStart = Date.now();
      const queryEmbedding = await embed(request.query);
      const vectorResults = vectorSearch(queryEmbedding, candidateCount);
      timings.vectorMs = Date.now() - vectorStart;
      
      candidates = mergeCandidates(bm25Results, vectorResults);
    }
  } else {
    // 4. Fast path: no expansion, use standard merge
    const vectorStart = Date.now();
    const queryEmbedding = await embed(request.query);
    const vectorResults = vectorSearch(queryEmbedding, candidateCount);
    timings.vectorMs = Date.now() - vectorStart;
    
    candidates = mergeCandidates(bm25Results, vectorResults);
  }

  // 5. Filter by collections if specified
  if (request.collections && request.collections.length > 0) {
    candidates = candidates.filter(c => request.collections!.includes(c.collection));
  }

  // 6. Rerank if available
  let reranked = candidates;
  if (config.search.reranking.enabled && isRerankerAvailable()) {
    const rerankStart = Date.now();
    const topCandidates = candidates.slice(0, config.search.reranking.candidateCount);
    reranked = await rerankCandidates(request.query, topCandidates);
    timings.rerankMs = Date.now() - rerankStart;
  }

  // 7. Apply temporal decay
  if (config.search.temporalDecay.enabled) {
    reranked = applyTemporalDecay(reranked);
  }

  // 8. MMR diversity filtering
  let results = reranked;
  if (config.search.mmr.enabled) {
    results = applyMMR(reranked, maxResults);
  } else {
    results = reranked.slice(0, maxResults);
  }

  // 9. Apply min score filter if specified
  if (request.minScore !== undefined) {
    results = results.filter(r => r.score >= request.minScore!);
  }

  // 10. Convert to search results
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

  // Log search request
  const timingStr = `bm25:${timings.bm25Ms}ms vec:${timings.vectorMs}ms${timings.expansionMs !== undefined ? ` expand:${timings.expansionMs}ms` : ""}${timings.rerankMs !== undefined ? ` rerank:${timings.rerankMs}ms` : ""}`;
  console.log(`[${timestamp}] SEARCH "${request.query}" → ${searchResults.length} results in ${timings.totalMs}ms (${timingStr})`);
  searchResults.slice(0, 5).forEach((r, i) => {
    console.log(`  #${i + 1} [${r.score.toFixed(2)}] ${r.citation}`);
  });

  return {
    results: searchResults,
    query: request.query,
    expandedQueries,
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

    // FTS5 rank is negative (lower = better). Convert to 0-1 similarity.
    // Typical range: -1 to -50. Use exponential decay to map to [0,1].
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

  // Add vector results
  for (const result of vectorResults) {
    const chunk = db.prepare("SELECT * FROM chunks WHERE id = ?").get(result.chunkId) as any;
    if (!chunk) continue;

    const doc = db.prepare("SELECT path, collection FROM documents WHERE id = ?").get(chunk.doc_id) as any;
    if (!doc) continue;

    // Cosine distance is in range [0, 2]. Convert to similarity in [0, 1].
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

  // Normalize rerank scores from 0-10 to 0-1
  const normalizedScores = rerankScores.map(s => s / 10);

  // Update scores and re-sort
  const reranked = candidates.map((chunk, i) => ({
    ...chunk,
    rerankScore: normalizedScores[i],
    score: normalizedScores[i], // Replace score with normalized rerank score
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
