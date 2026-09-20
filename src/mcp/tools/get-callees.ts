import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../server";
import { textResult } from "../util";

const getCalleesSchema: Record<string, any> = {
  symbol: z.string().describe("Name of the calling function/method to expand."),
  file: z
    .string()
    .optional()
    .describe("Disambiguate when the name is common (substring match on path)."),
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
    .describe("Max callees (default 30)."),
};

export function registerGetCallees(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "get_callees",
    {
      title: "Find what a symbol calls",
      description:
        "List the functions/methods that the given symbol CALLS — its outbound dependencies. " +
        "Use this to answer 'what does X depend on?' or 'what library/internal calls happen inside X?'. " +
        "depth=1 returns direct callees; higher depths walk transitively. " +
        "Callees may include `:Unresolved` placeholder nodes — these are calls to symbols not " +
        "found in the indexed code (typically library or builtin methods).",
      inputSchema: getCalleesSchema,
    },
    async ({ symbol, file, depth, limit }) => {
      const d = depth ?? 1;
      const lim = limit ?? 30;
      const rows = await ctx.store.callees(symbol, {
        pathContains: file,
        depth: d,
        limit: lim,
      });

      if (rows.length === 0) {
        return textResult(
          `No callees found for "${symbol}"${file ? ` in ${file}` : ""}.`,
        );
      }

      const lines = rows.map((r) => {
        const loc = r.target.path
          ? `${r.target.path}:${(r.target.startRow ?? 0) + 1}`
          : "(external)";
        return `- [d=${r.distance}] ${r.target.kind} ${r.target.name}\n    ${loc}`;
      });

      return textResult(
        `${rows.length} callee(s) of "${symbol}" (depth ≤ ${d}):\n\n` +
          lines.join("\n"),
      );
    },
  );
}
