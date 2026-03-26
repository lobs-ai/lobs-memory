/**
 * Type stubs for the lobs plugin SDK.
 * Mirrors the types from lobs-core/src/types/lobs-plugin.ts.
 *
 * Declared as a module ambient so that plugin/index.ts can import from
 * "lobs/plugin-sdk/memory-core" without lobs-core being installed.
 * The runtime module is injected by the lobs plugin loader.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

declare module "lobs/plugin-sdk/memory-core" {
  export interface PluginLogger {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
    debug?(msg: string): void;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface AnyAgentTool {
    name: string;
    label?: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
    execute(
      toolCallId: string,
      params: Record<string, unknown>
    ): Promise<{ text: string }>;
  }

  export interface ToolFactoryContext {
    workspaceDir?: string;
    agentId?: string;
    sessionId?: string;
    [key: string]: unknown;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export interface lobsPluginApi {
    logger: PluginLogger;
    pluginConfig: Record<string, unknown> | null;
    config: Record<string, unknown>;
    resolvePath(path: string): string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on(
      event: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: (event: any, ctx: any) => Promise<Record<string, unknown> | void>
    ): void;
    registerHttpRoute(params: {
      path: string;
      handler: (
        req: IncomingMessage,
        res: ServerResponse
      ) => Promise<boolean | void> | boolean | void;
      auth: "gateway" | "plugin";
      match?: "exact" | "prefix";
      replaceExisting?: boolean;
    }): void;
    registerService(opts: {
      id: string;
      start: () => void;
      stop: () => void;
    }): void;
    registerCommand?(opts: {
      name: string;
      description: string;
      handler: (ctx?: unknown) => Promise<{ text: string }>;
    }): void;
    registerCli?(
      fn: (opts: { program: unknown }) => void,
      opts?: { commands: string[] }
    ): void;
    registerGatewayMethod?(
      name: string,
      handler: (params: unknown) => Promise<unknown>
    ): void;
    registerTool?(
      factory: (ctx: ToolFactoryContext) => AnyAgentTool[],
      opts?: { names?: string[] }
    ): void;
  }

  export function emptyPluginConfigSchema(): {
    type: "object";
    additionalProperties: false;
    properties: Record<string, never>;
  };
}
