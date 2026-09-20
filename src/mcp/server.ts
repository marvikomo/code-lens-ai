import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { GraphStore } from "../store/types";
import { registerSearchCode } from "./tools/search-code";
import { registerGetDefinition } from "./tools/get-definition";
import { registerReadCode } from "./tools/read-code";
import { registerGetCallers } from "./tools/get-callers";
import { registerGetCallees } from "./tools/get-callees";
import { registerImpactAnalysis } from "./tools/impact-analysis";
import { registerGetOverview } from "./tools/get-overview";
import { registerLabelCommunity } from "./tools/label-community";
import { registerGenerateWiki } from "./tools/generate-wiki";
import { registerCypher } from "./tools/cypher";

/** What every tool receives. Tools never see a database driver. */
export interface ToolContext {
  store: GraphStore;
}

/**
 * Register every tool on a server. Split out from `startMcpServer` so tests
 * can build a server over a `LocalStore` without a stdio transport.
 */
export function registerTools(server: McpServer, store: GraphStore): void {
  const ctx: ToolContext = { store };
  registerSearchCode(server, ctx);
  registerGetDefinition(server, ctx);
  registerReadCode(server, ctx);
  registerGetCallers(server, ctx);
  registerGetCallees(server, ctx);
  registerImpactAnalysis(server, ctx);
  registerGetOverview(server, ctx);
  registerLabelCommunity(server, ctx);
  registerGenerateWiki(server, ctx);
  // Free-form queries only make sense where there is a query language.
  if (store.supportsCypher) registerCypher(server, ctx);
}

/**
 * Boots a stdio MCP server over an already-opened store. Designed to be
 * wired into Claude Desktop / Cursor / Codex via their stdio MCP config.
 * Logs go to stderr (stdout is reserved for the protocol).
 */
export async function startMcpServer(store: GraphStore): Promise<void> {
  const server = new McpServer(
    { name: "code-lens-ai", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp] code-lens-ai MCP server ready (stdio, ${store.backend} backend)`);

  const shutdown = async () => {
    console.error("[mcp] shutting down");
    await server.close().catch(() => {});
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
