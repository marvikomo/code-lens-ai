import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../server";
import type { SearchMode } from "../../search";
import { textResult } from "../util";

// Cast as Record<string, any> to short-circuit TS's deep schema inference.
// The runtime validation still works — the SDK only uses the shape at call time.
const searchCodeSchema: Record<string, any> = {
  query: z
    .string()
    .describe(
      "Natural language or keywords. Lucene syntax supported in fts mode " +
        "(e.g. '+auth +middleware', 'parse*', '\"exact phrase\"').",
    ),
  mode: z
    .enum(["fts", "vector", "hybrid"])
    .optional()
    .describe("Override search method. Omit for auto (hybrid if embeddings exist)."),
  kind: z
    .enum([
      "Function",
      "Method",
      "Class",
      "Interface",
      "TypeAlias",
      "Enum",
      "Property",
      "File",
    ])
    .optional()
    .describe("Restrict to one node kind."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max results (default 10)."),
};

export function registerSearchCode(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Find code by keyword OR semantic meaning across the indexed graph. " +
        "Returns ranked results with name, kind, file, line range, and a body snippet. " +
        "Use this as the FIRST tool when the user asks 'where is X?' or 'find code that does Y' " +
        "or whenever you don't know the exact symbol name. " +
        "Search modes: 'fts' (keyword/BM25), 'vector' (semantic, requires embeddings), " +
        "'hybrid' (RRF fusion of both — best when embeddings are available). " +
        "Defaults to hybrid when embeddings exist, fts otherwise.",
      inputSchema: searchCodeSchema,
    },
    async ({ query, mode, kind, limit }) => {
      const hits = await ctx.store.search(query, {
        mode: mode as SearchMode | undefined,
        kind,
        limit: limit ?? 10,
      });
      if (hits.length === 0) {
        return textResult(`No hits for "${query}".`);
      }
      const lines = hits.map((h, i) => {
        const matched = h.matchedBy.join("+");
        const score = h.score.toFixed(4);
        const loc = h.path
          ? `${h.path}:${(h.startRow ?? 0) + 1}-${(h.endRow ?? 0) + 1}`
          : "(no path)";
        const sig = h.signature
          ? "\n    " + h.signature.split("\n")[0].trim()
          : "";
        return (
          `${i + 1}. [${matched} ${score}] ${h.kind} ${h.name}\n` +
          `    ${loc}${sig}`
        );
      });
      return textResult(
        `Found ${hits.length} hit(s) for "${query}":\n\n` + lines.join("\n\n"),
      );
    },
  );
}
