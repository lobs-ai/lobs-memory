/**
 * lobs-memory — OpenClaw memory plugin
 *
 * Routes memory_search to the lobs-memory HTTP server.
 * Falls back to builtin search if server is unreachable.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";

interface PluginConfig {
  serverUrl?: string;
  enabled?: boolean;
  timeoutMs?: number;
  fallbackToBuiltin?: boolean;
}

interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
  citation: string;
}

interface SearchResponse {
  results: SearchResult[];
  query: string;
  expandedQueries?: string[];
  timings: {
    totalMs: number;
    expansionMs?: number;
    bm25Ms: number;
    vectorMs: number;
    rerankMs?: number;
  };
}

const DEFAULT_SERVER_URL = "http://localhost:7420";
const DEFAULT_TIMEOUT_MS = 5000;

async function searchMemory(
  query: string,
  maxResults: number,
  minScore: number,
  config: PluginConfig,
): Promise<{ results: SearchResult[]; provider: string; model: string }> {
  const serverUrl = config.serverUrl || DEFAULT_SERVER_URL;
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${serverUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, maxResults, minScore }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }

    const data = (await res.json()) as SearchResponse;

    return {
      results: data.results,
      provider: "lobs-memory",
      model: "lobs-memory",
    };
  } finally {
    clearTimeout(timeout);
  }
}

const lobsMemoryPlugin = {
  id: "lobs-memory",
  name: "Lobs Memory",
  description: "HTTP-backed memory search with neural reranking and query expansion",
  kind: "memory" as const,

  register(api: OpenClawPluginApi) {
    api.registerTool(
      (ctx) => {
        const pluginConfig = (ctx.config as any)?.plugins?.entries?.["lobs-memory"]?.config as PluginConfig | undefined;

        if (pluginConfig?.enabled === false) {
          // Disabled — fall back to builtin
          const builtinSearch = api.runtime.tools.createMemorySearchTool({
            config: ctx.config,
            agentSessionKey: ctx.sessionKey,
          });
          const builtinGet = api.runtime.tools.createMemoryGetTool({
            config: ctx.config,
            agentSessionKey: ctx.sessionKey,
          });
          if (!builtinSearch || !builtinGet) return null;
          return [builtinSearch, builtinGet];
        }

        // memory_search — routes to HTTP server
        const memorySearchTool = {
          name: "memory_search",
          description:
            "Mandatory recall step: semantically search MEMORY.md + memory/*.md before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
          parameters: {
            type: "object" as const,
            properties: {
              query: { type: "string" as const, description: "Search query" },
              maxResults: { type: "number" as const, description: "Max results" },
              minScore: { type: "number" as const, description: "Minimum score" },
            },
            required: ["query"] as const,
          },
          handler: async (params: { query: string; maxResults?: number; minScore?: number }) => {
            try {
              return await searchMemory(
                params.query,
                params.maxResults ?? 8,
                params.minScore ?? 0,
                pluginConfig ?? {},
              );
            } catch (err) {
              // Fallback to builtin if configured
              if (pluginConfig?.fallbackToBuiltin !== false) {
                console.warn(`[lobs-memory] Server unreachable, falling back to builtin: ${err}`);
                const builtinSearch = api.runtime.tools.createMemorySearchTool({
                  config: ctx.config,
                  agentSessionKey: ctx.sessionKey,
                });
                if (builtinSearch && "handler" in builtinSearch) {
                  return (builtinSearch as any).handler(params);
                }
              }
              return {
                results: [],
                provider: "lobs-memory",
                model: "lobs-memory",
                error: `Server unreachable: ${err}`,
              };
            }
          },
        };

        // memory_get — reads files directly (no server needed)
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });

        if (!memoryGetTool) return null;
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    // Register CLI commands
    api.registerCli(
      ({ program }) => {
        const cmd = program.command("lobs-memory").description("Lobs memory server status");

        cmd.command("status").action(async () => {
          try {
            const res = await fetch("http://localhost:7420/health");
            const data = await res.json();
            console.log(JSON.stringify(data, null, 2));
          } catch {
            console.error("Server not reachable at http://localhost:7420");
          }
        });

        cmd.command("index").action(async () => {
          try {
            const res = await fetch("http://localhost:7420/index", { method: "POST" });
            const data = await res.json();
            console.log(JSON.stringify(data, null, 2));
          } catch {
            console.error("Server not reachable");
          }
        });
      },
      { commands: ["lobs-memory"] },
    );
  },
};

export default lobsMemoryPlugin;
