/**
 * lobs-memory server — persistent memory search with reranking + query expansion
 *
 * Keeps embedding, reranker, and query expansion models loaded in memory.
 * Serves search requests via HTTP API on localhost.
 */

import type { SearchRequest, SearchResponse, HealthResponse, Config } from "./types.js";

// TODO: implement these modules
// import { loadConfig } from "./config.js";
// import { initDb } from "./db.js";
// import { initEmbedder } from "./embedder.js";
// import { initReranker } from "./reranker.js";
// import { initExpander } from "./expander.js";
// import { createSearchPipeline } from "./search.js";
// import { startIndexer } from "./indexer.js";

const startTime = Date.now();

// Placeholder until modules are implemented
const PORT = Number(process.env.PORT) || 7420;

const server = Bun.serve({
  port: PORT,
  hostname: "localhost",

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS headers for local use
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "http://localhost:*",
    };

    try {
      // Health check
      if (path === "/health" && req.method === "GET") {
        const health: HealthResponse = {
          status: "ok",
          uptime: Math.floor((Date.now() - startTime) / 1000),
          models: {
            embedding: { loaded: false, path: "" },  // TODO
            reranker: { loaded: false, path: "" },    // TODO
            queryExpansion: { loaded: false, path: "" }, // TODO
          },
          index: {
            documents: 0,  // TODO
            chunks: 0,     // TODO
            collections: [],
            lastUpdate: null,
          },
        };
        return new Response(JSON.stringify(health), { headers });
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

        // TODO: implement actual search pipeline
        const response: SearchResponse = {
          results: [],
          query: body.query,
          timings: {
            totalMs: 0,
            bm25Ms: 0,
            vectorMs: 0,
          },
        };

        return new Response(JSON.stringify(response), { headers });
      }

      // Index trigger
      if (path === "/index" && req.method === "POST") {
        // TODO: trigger re-index
        return new Response(JSON.stringify({ ok: true, message: "indexing triggered" }), { headers });
      }

      // Status
      if (path === "/status" && req.method === "GET") {
        // TODO: detailed status
        return new Response(JSON.stringify({ status: "ok" }), { headers });
      }

      // Collections management
      if (path === "/collections" && req.method === "POST") {
        // TODO: add/remove collections
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("Request error:", err);
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers,
      });
    }
  },
});

console.log(`lobs-memory server listening on http://localhost:${server.port}`);
console.log("Models: loading... (TODO)");
