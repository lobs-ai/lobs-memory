/**
 * lobs-memory server — persistent memory search with reranking + query expansion
 *
 * Keeps embedding and reranker models loaded in memory.
 * Serves search requests via HTTP API on localhost.
 */

import { loadConfig } from "./config.js";
import { initDb, getIndexStats, getDetailedStats, closeDb, queryGraph, getDb } from "./db.js";
import { initEmbedder, checkEmbedderHealth } from "./embedder.js";
import { initReranker, isRerankerAvailable, shutdownReranker } from "./reranker.js";
import { initSearch, search } from "./search.js";
import { startIndexer, stopIndexer, getIndexerStatus, reindexAll } from "./indexer.js";
import { extractSnippet } from "./chunker.js";
import { readFileSync } from "fs";
import type { SearchRequest, SearchResponse, HealthResponse, GraphRequest, GraphResponse, BatchSearchRequest, BatchSearchResponse } from "./types.js";

const startTime = Date.now();

// Startup sequence
async function startup() {
  console.log("=== lobs-memory server starting ===");

  // 1. Load configuration
  const config = loadConfig();
  console.log(`Loaded config: port=${config.port}`);

  // 2. Initialize database
  initDb();
  console.log("Database initialized");

  // 3. Initialize embedder (LM Studio)
  initEmbedder(config);
  const embedderHealth = await checkEmbedderHealth();
  if (!embedderHealth.available) {
    console.warn(`⚠️  Embedder unavailable: ${embedderHealth.error}`);
    console.warn("Running in degraded mode — BM25 text search only, no vector search. Start LM Studio for full search.");
  } else {
    console.log("✓ Embedder ready");
  }

  // 4. Initialize reranker (ONNX sidecar)
  await initReranker(config);

  // 5. Initialize search pipeline
  initSearch(config);
  console.log("Search pipeline initialized");

  // 6. Start HTTP server first (so it's responsive immediately)
  const server = Bun.serve({
    port: config.port,
    hostname: "localhost",

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      const headers = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      };

      try {
        // Health check
        if (path === "/health" && req.method === "GET") {
          const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
          console.log(`[${timestamp}] HEALTH check`);
          
          const stats = getIndexStats();
          const embedderHealth = await checkEmbedderHealth();
          const rerankerAvailable = isRerankerAvailable();

          const health: HealthResponse = {
            status: embedderHealth.available ? "ok" : "degraded",
            uptime: Math.floor((Date.now() - startTime) / 1000),
            models: {
              embedding: {
                loaded: embedderHealth.available,
                model: config.lmstudio.embeddingModel,
              },
              reranker: {
                loaded: rerankerAvailable,
                mode: config.reranker?.mode || "none",
              },
              queryExpansion: {
                loaded: false,
                path: "not implemented",
              },
            },
            index: stats,
          };

          return new Response(JSON.stringify(health, null, 2), { headers });
        }

        // Lightweight health check
        if (path === "/healthz" && req.method === "GET") {
          const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
          console.log(`[${timestamp}] HEALTHZ check`);
          
          const stats = getIndexStats();

          const healthz = {
            status: "ok",
            uptime: Math.floor((Date.now() - startTime) / 1000),
            documents: stats.documents,
            chunks: stats.chunks,
          };

          return new Response(JSON.stringify(healthz), { headers });
        }

        // Search
        if (path === "/search" && req.method === "POST") {
          const body = (await req.json()) as SearchRequest;
          if (!body.query) {
            return new Response(JSON.stringify({ error: "query required" }), {
              status: 400,
              headers,
            });
          }

          const response = await search(body);
          return new Response(JSON.stringify(response, null, 2), { headers });
        }

        // Batch search — multiple queries in one request
        if (path === "/search/batch" && req.method === "POST") {
          const batchStart = performance.now();
          const body = (await req.json()) as BatchSearchRequest;
          
          if (!body.searches?.length) {
            return new Response(JSON.stringify({ error: "searches array required" }), {
              status: 400,
              headers,
            });
          }

          // Run all searches concurrently
          const entries = await Promise.all(
            body.searches.map(async (item) => {
              const searchReq: SearchRequest = {
                query: item.query,
                maxResults: item.maxResults,
                minScore: item.minScore,
                collections: item.collections,
                conversationContext: item.conversationContext,
              };
              const result = await search(searchReq);
              return [item.id, result] as const;
            })
          );

          const response: BatchSearchResponse = {
            results: Object.fromEntries(entries),
            timings: { totalMs: Math.round(performance.now() - batchStart) },
          };

          return new Response(JSON.stringify(response, null, 2), { headers });
        }

        // Manual re-index trigger
        if (path === "/index" && req.method === "POST") {
          reindexAll(); // Don't await, run in background
          return new Response(
            JSON.stringify({ ok: true, message: "Re-indexing started in background" }),
            { headers }
          );
        }

        // Status
        if (path === "/status" && req.method === "GET") {
          const stats = getIndexStats();
          const indexerStatus = getIndexerStatus();
          const embedderHealth = await checkEmbedderHealth();

          const status = {
            uptime: Math.floor((Date.now() - startTime) / 1000),
            embedder: embedderHealth,
            reranker: { available: isRerankerAvailable(), mode: config.reranker?.mode || "none" },
            indexer: indexerStatus,
            index: stats,
            config: {
              port: config.port,
              collections: config.collections.map(c => c.name),
              search: {
                reranking: config.search.reranking.enabled,
                mmr: config.search.mmr.enabled,
                temporalDecay: config.search.temporalDecay.enabled,
              },
            },
          };

          return new Response(JSON.stringify(status, null, 2), { headers });
        }

        // Collections list
        if (path === "/collections" && req.method === "GET") {
          const collections = {
            collections: config.collections.map(c => ({
              name: c.name,
              path: c.path,
              pattern: c.pattern,
            })),
          };
          return new Response(JSON.stringify(collections, null, 2), { headers });
        }

        // Detailed stats
        if (path === "/stats" && req.method === "GET") {
          const stats = getDetailedStats();
          const indexStats = getIndexStats();
          return new Response(JSON.stringify({
            ...indexStats,
            ...stats,
            reranker: { available: isRerankerAvailable(), mode: config.reranker?.mode || "none" },
          }, null, 2), { headers });
        }

        // Graph query (Feature 4)
        if (path === "/graph" && req.method === "POST") {
          const body = (await req.json()) as GraphRequest;
          if (!body.entity) {
            return new Response(JSON.stringify({ error: "entity required" }), {
              status: 400,
              headers,
            });
          }

          const depth = body.depth || 2;
          const edges = queryGraph(body.entity, depth);

          // Build node and edge lists
          const nodeMap = new Map<string, { name: string; type: string }>();
          const graphEdges: Array<{ from: string; relation: string; to: string }> = [];
          const sourceChunkIds = new Set<number>();

          for (const edge of edges) {
            // Add nodes
            nodeMap.set(edge.entity1.toLowerCase(), {
              name: edge.entity1,
              type: edge.entity1_type,
            });
            nodeMap.set(edge.entity2.toLowerCase(), {
              name: edge.entity2,
              type: edge.entity2_type,
            });

            // Add edge
            graphEdges.push({
              from: edge.entity1,
              relation: edge.relation,
              to: edge.entity2,
            });

            // Track source chunks
            sourceChunkIds.add(edge.source_chunk_id);
          }

          // Get source chunks
          const db = getDb();
          const sourceChunks: GraphResponse["sourceChunks"] = [];

          for (const chunkId of sourceChunkIds) {
            const chunk = db.prepare(`
              SELECT c.text, c.start_line, c.end_line, d.path
              FROM chunks c
              JOIN documents d ON c.doc_id = d.id
              WHERE c.id = ?
            `).get(chunkId) as { text: string; start_line: number; end_line: number; path: string } | undefined;

            if (chunk) {
              const fileContent = readFileSync(chunk.path, "utf-8");
              const snippet = extractSnippet(fileContent, chunk.start_line, chunk.end_line);

              sourceChunks.push({
                path: chunk.path,
                startLine: chunk.start_line,
                endLine: chunk.end_line,
                snippet,
              });
            }
          }

          const response: GraphResponse = {
            nodes: Array.from(nodeMap.values()),
            edges: graphEdges,
            sourceChunks,
          };

          return new Response(JSON.stringify(response, null, 2), { headers });
        }

        return new Response("Not Found", { status: 404 });
      } catch (err) {
        const timestamp = new Date().toISOString().replace("T", " ").split(".")[0];
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[${timestamp}] ERROR ${url.pathname}: ${errorMsg}`);
        if (err instanceof Error && err.stack) {
          console.error(err.stack);
        }
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
          {
            status: 500,
            headers,
          }
        );
      }
    },
  });

  console.log(`\n✓ Server ready at http://localhost:${server.port}`);
  
  // Log model configuration
  console.log(`\nModels:`);
  console.log(`  Embedding: ${config.lmstudio.embeddingModel} via LM Studio (${config.lmstudio.baseUrl})`);
  const rerankerMode = config.reranker?.mode || "none";
  console.log(`  Reranker: ${rerankerMode} ${rerankerMode !== "none" ? "(auto-managed)" : ""}`);
  
  console.log(`\nSearch config:`);
  console.log(`  Vector weight: ${config.search.vectorWeight}, Text weight: ${config.search.textWeight}`);
  console.log(`  Reranking: ${config.search.reranking.enabled ? `enabled (top ${config.search.reranking.candidateCount} candidates)` : "disabled"}`);
  console.log(`  MMR: ${config.search.mmr.enabled ? `enabled (λ=${config.search.mmr.lambda})` : "disabled"}`);
  console.log(`  Temporal decay: ${config.search.temporalDecay.enabled ? `enabled (half-life=${config.search.temporalDecay.halfLifeDays}d)` : "disabled"}`);

  // 7. Start indexer in background (non-blocking)
  const stats = getIndexStats();
  console.log(`\nIndex (before initial scan):`);
  console.log(`  Documents: ${stats.documents}, Chunks: ${stats.chunks}`);
  console.log(`  Collections: ${config.collections.map(c => c.name).join(", ")}`);
  
  // Run initial indexing in background
  startIndexer(config).then(() => {
    const updatedStats = getIndexStats();
    console.log(`\n✓ Initial indexing complete: ${updatedStats.documents} docs, ${updatedStats.chunks} chunks`);
  }).catch(err => {
    console.error("Initial indexing failed:", err);
  });
}

// Graceful shutdown
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function shutdown() {
  console.log("\nShutting down...");
  await stopIndexer();
  shutdownReranker();
  closeDb();
  console.log("Goodbye!");
  process.exit(0);
}

// Start the server
startup().catch(err => {
  console.error("Startup failed:", err);
  process.exit(1);
});
