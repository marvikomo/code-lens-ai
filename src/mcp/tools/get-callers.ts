import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../server";
import { textResult } from "../util";

const getCallersSchema: Record<string, any> = {
  symbol: z
    .string()
    .describe("Name of the called function/method to look up callers for."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("Hops to traverse (default 1)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max callers (default 20)."),
};

export function registerGetCallers(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "get_callers",
    {
      title: "Find who calls a symbol",
      description:
        "List the Function/Method nodes that CALL the given symbol — its inbound dependencies. " +
        "Use this to answer 'who uses X?' or 'what would break if I changed X?'. " +
        "depth=1 returns direct callers; higher depths walk the call graph transitively. " +
        "If the symbol name is ambiguous, use get_definition first to identify the right id.",
      inputSchema: getCallersSchema,
    },
    async ({ symbol, depth, limit }) => {
      const d = depth ?? 1;
      const lim = limit ?? 20;

      // Resolve the symbol to actual node ids first (handles unresolved targets too).
      // `r` from `[r:CALLS*1..N]` is a List<Relationship>; use `size(r)` not
      // `length(r)` (length() is for Path values, hence the Neo4j type-mismatch
      // error this tool used to throw on depth=1).
      const rows = await ctx.store.callers(symbol, d, lim);

      if (rows.length === 0) {
        return textResult(`No callers found for "${symbol}" within depth ${d}.`);
      }

      const lines = rows.map(
        (r) =>
          `- [d=${r.distance}] ${r.caller.kind} ${r.caller.name}\n` +
          `    ${r.caller.path}:${(r.caller.startRow ?? 0) + 1}`,
      );

      return textResult(
        `${rows.length} caller(s) of "${symbol}" (depth ≤ ${d}):\n\n` +
          lines.join("\n"),
      );
    },
  );
}
