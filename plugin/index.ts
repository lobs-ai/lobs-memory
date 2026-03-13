/**
 * OpenClaw memory plugin — lobs-memory
 * 
 * Replaces memory-core. Starts the lobs-memory search server as a service
 * and proxies memory_search/memory_get tool calls to it.
 */
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk/memory-core";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/memory-core";
import { readFileSync } from "fs";
import { resolve, relative } from "path";
import { spawn, type ChildProcess } from "child_process";

const LOBS_MEMORY_PORT = 7420;
const LOBS_MEMORY_URL = `http://localhost:${LOBS_MEMORY_PORT}`;
const SERVER_DIR = resolve(import.meta.dirname || __dirname, "..");

let serverProcess: ChildProcess | null = null;

const memoryLobsPlugin = {
  id: "memory-lobs",
  name: "Memory (Lobs)",
  description: "Semantic memory search powered by lobs-memory server (BM25 + vector + HyDE)",
  kind: "memory" as const,
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const log = api.logger;

    // ── Feature 1: Auto-injection hook ──────────────────────────────
    // Cache for deduplication (query -> results, TTL 30s)
    const injectionCache = new Map<string, { results: any; timestamp: number }>();
    const CACHE_TTL_MS = 30000;

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      // Only inject for main agent sessions, not workers/subagents
      if (ctx.agentId && ctx.agentId !== "main") return {};

      // Only inject on direct user messages, not on heartbeats/cron/memory triggers
      if (ctx.trigger && ctx.trigger !== "user") return {};

      // Check last message is actually from the user (not a tool result mid-chain)
      const lastMsg = event.messages[event.messages.length - 1] as any;
      if (!lastMsg || lastMsg.role !== "user") return {};

      // Skip system/inter-session messages
      const content = typeof lastMsg.content === "string" ? lastMsg.content : "";
      if (content.startsWith("[Inter-session message]") || content.startsWith("[System")) return {};

      // Extract recent user messages (last 2-3)
      const recentUserMessages: string[] = [];
      for (let i = event.messages.length - 1; i >= 0 && recentUserMessages.length < 3; i--) {
        const msg = event.messages[i] as any;
        if (msg.role === "user") {
          const msgContent = typeof msg.content === "string" ? msg.content : "";
          if (msgContent) {
            recentUserMessages.unshift(msgContent);
          }
        }
      }

      if (recentUserMessages.length === 0) return {};

      // Build query from recent messages
      const query = recentUserMessages.join(" ").slice(0, 500);

      // Skip trivial messages
      if (isTrivial(query)) return {};

      // Check cache
      const cached = injectionCache.get(query);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        log.info(`memory-inject: cache hit for "${query.slice(0, 50)}..."`);
        return { prependContext: formatContextBlock(cached.results) };
      }

      // Search lobs-memory with conversation context
      try {
        const conversationContext = recentUserMessages.slice(-5).join("\n").slice(0, 1000);

        const response = await fetch(`${LOBS_MEMORY_URL}/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query,
            maxResults: 5,
            minScore: 0.5,
            conversationContext,
          }),
          signal: AbortSignal.timeout(3000),
        });

        if (!response.ok) {
          log.warn(`memory-inject: search failed (${response.status})`);
          return {};
        }

        const data = await response.json();
        if (!data.results || data.results.length === 0) return {};

        // Cache results
        injectionCache.set(query, { results: data.results, timestamp: Date.now() });

        // Clean old cache entries
        for (const [key, value] of injectionCache.entries()) {
          if (Date.now() - value.timestamp > CACHE_TTL_MS) {
            injectionCache.delete(key);
          }
        }

        log.info(`memory-inject: ${data.results.length} snippets for query: "${query.slice(0, 50)}..."`);

        return { prependContext: formatContextBlock(data.results) };
      } catch (err: any) {
        if (err?.name === "TimeoutError" || err?.code === "ECONNREFUSED") {
          log.warn("memory-inject: search timeout/unavailable, skipping");
        } else {
          log.warn(`memory-inject: error: ${err.message}`);
        }
        return {};
      }
    });

    // ── Service: start/stop the lobs-memory server ──────────────────
    api.registerService({
      id: "lobs-memory-server",
      start: () => {
        log.info("lobs-memory: starting server...");

        serverProcess = spawn("bun", ["run", "server/index.ts"], {
          cwd: SERVER_DIR,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        });

        serverProcess.stdout?.on("data", (data: Buffer) => {
          const lines = data.toString().trim().split("\n");
          for (const line of lines) {
            if (line.includes("error") || line.includes("Error")) {
              log.warn(`lobs-memory: ${line}`);
            } else if (line.includes("ready") || line.includes("complete") || line.includes("✓")) {
              log.info(`lobs-memory: ${line}`);
            }
          }
        });

        serverProcess.stderr?.on("data", (data: Buffer) => {
          const msg = data.toString().trim();
          if (msg) log.warn(`lobs-memory: ${msg}`);
        });

        serverProcess.on("exit", (code, signal) => {
          log.warn(`lobs-memory: server exited (code=${code}, signal=${signal})`);
          serverProcess = null;
        });

        serverProcess.on("error", (err) => {
          log.error(`lobs-memory: failed to start server: ${err.message}`);
          serverProcess = null;
        });
      },
      stop: () => {
        if (serverProcess) {
          log.info("lobs-memory: stopping server...");
          serverProcess.kill("SIGTERM");
          serverProcess = null;
        }
      },
    });

    // ── Tools: memory_search + memory_get ────────────────────────────
    api.registerTool(
      (ctx) => {
        const workspaceDir = ctx.workspaceDir || process.env.HOME + "/.openclaw/workspace";

        const memorySearchTool: AnyAgentTool = {
          name: "memory_search",
          label: "Memory Search",
          description:
            "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines. If response has disabled=true, memory retrieval is unavailable and should be surfaced to the user.",
          parameters: {
            type: "object" as const,
            properties: {
              query: { type: "string" as const, description: "Search query string." },
              maxResults: { type: "number" as const },
              minScore: { type: "number" as const },
            },
            required: ["query"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const query = params.query as string;
            const maxResults = (params.maxResults as number) || 8;
            const minScore = (params.minScore as number) || 0;

            try {
              const response = await fetch(`${LOBS_MEMORY_URL}/search`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query, maxResults, minScore }),
                signal: AbortSignal.timeout(15000),
              });

              if (!response.ok) {
                return {
                  text: JSON.stringify({ disabled: true, reason: `lobs-memory server error: ${response.status}` }),
                };
              }

              const data = (await response.json()) as {
                results: Array<{
                  path: string;
                  startLine: number;
                  endLine: number;
                  score: number;
                  snippet: string;
                  source: string;
                  citation: string;
                }>;
                timings: Record<string, number>;
              };

              const snippets = data.results.map((r) => {
                let displayPath = r.path;
                try {
                  if (r.path.startsWith(workspaceDir)) {
                    displayPath = relative(workspaceDir, r.path);
                  } else if (r.path.startsWith(process.env.HOME || "")) {
                    displayPath = "~/" + relative(process.env.HOME || "", r.path);
                  }
                } catch {}

                return {
                  path: displayPath,
                  lines: `${r.startLine}-${r.endLine}`,
                  score: r.score,
                  snippet: r.snippet,
                  source: r.source,
                };
              });

              return {
                text: JSON.stringify({
                  results: snippets,
                  query,
                  provider: "lobs-memory",
                  model: "nomic-embed-text-v1.5",
                  timings: data.timings,
                }),
              };
            } catch (err: any) {
              if (err?.code === "ECONNREFUSED" || err?.name === "TimeoutError" || err?.cause?.code === "ECONNREFUSED") {
                return {
                  text: JSON.stringify({
                    disabled: true,
                    reason: "lobs-memory server not running (localhost:7420)",
                  }),
                };
              }
              return {
                text: JSON.stringify({ disabled: true, reason: String(err) }),
              };
            }
          },
        };

        const memoryGetTool: AnyAgentTool = {
          name: "memory_get",
          label: "Memory Get",
          description:
            "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
          parameters: {
            type: "object" as const,
            properties: {
              path: { type: "string" as const, description: "Path to the file to read (relative or absolute)" },
              from: { type: "number" as const },
              lines: { type: "number" as const },
            },
            required: ["path"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const filePath = params.path as string;
            const from = (params.from as number) || 1;
            const maxLines = (params.lines as number) || 50;

            let resolvedPath: string;
            if (filePath.startsWith("~/")) {
              resolvedPath = resolve((process.env.HOME || "") + filePath.slice(1));
            } else if (filePath.startsWith("/")) {
              resolvedPath = filePath;
            } else {
              resolvedPath = resolve(workspaceDir, filePath);
            }

            try {
              const content = readFileSync(resolvedPath, "utf-8");
              const allLines = content.split("\n");
              const startIdx = Math.max(0, from - 1);
              const endIdx = Math.min(allLines.length, startIdx + maxLines);
              const selectedLines = allLines.slice(startIdx, endIdx);

              return {
                text: JSON.stringify({
                  path: filePath,
                  from: startIdx + 1,
                  to: endIdx,
                  totalLines: allLines.length,
                  text: selectedLines.join("\n"),
                }),
              };
            } catch (err: any) {
              if (err?.code === "ENOENT") {
                return { text: JSON.stringify({ path: filePath, text: "" }) };
              }
              return { text: JSON.stringify({ error: String(err), path: filePath }) };
            }
          },
        };

        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );
  },
};

// ── Helper functions for auto-injection ────────────────────────────

/**
 * Check if a message is too trivial to warrant memory search
 */
function isTrivial(query: string): boolean {
  // Too short
  if (query.length < 10) return true;

  // Common acknowledgments (case-insensitive)
  const lower = query.toLowerCase().trim();
  const trivialPhrases = [
    "yes", "no", "ok", "sure", "thanks", "thank you", "got it", "nice",
    "cool", "lol", "haha", "yep", "nope", "k", "kk", "okay", "alright",
    "good", "great", "awesome", "sounds good", "makes sense",
  ];

  if (trivialPhrases.includes(lower)) return true;

  // Only emoji
  if (/^[\p{Emoji}\s]+$/u.test(query)) return true;

  // Only punctuation
  if (/^[^\w]+$/.test(query)) return true;

  return false;
}

/**
 * Format search results into a context block for injection
 */
function formatContextBlock(results: any[]): string {
  const snippets = results.map((r: any) => {
    const location = `[${r.source}/${r.path}:${r.startLine}-${r.endLine}]`;
    return `${location} ${r.snippet}`;
  });

  return `<recalled-memory>\n${snippets.join("\n\n")}\n</recalled-memory>`;
}

export default memoryLobsPlugin;
