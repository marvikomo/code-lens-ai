import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../server";
import { readQuery, unwrap, textResult } from "../util";

// Reject anything that looks like mutation. Crude but adequate for a
// read-only escape hatch — allows MATCH/RETURN/WITH/CALL but rejects writes.
const FORBIDDEN = /\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|FOREACH|LOAD CSV|CALL\s+(?:db\.create|gds\.\w+\.write|apoc\.\w*write\w*))\b/i;

const cypherSchema: Record<string, any> = {
  query: z.string().describe("A read-only Cypher query."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Hard cap on records returned to keep the agent's context tight (default 50).",
    ),
};

export function registerCypher(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "cypher",
    {
      title: "Run a read-only Cypher query (escape hatch)",
      description:
        "Run an arbitrary read-only Cypher query against the Neo4j knowledge graph. " +
        "Use this only when the higher-level tools (search_code, get_definition, get_callers, " +
        "get_callees, impact_analysis, get_overview) cannot answer the question.\n\n" +
        "Schema reference — every node has the base label `:CodeNode` plus ONE kind label.\n" +
        "  Prefer `n.kind` (a string property) over `labels(n)[0]` — `labels(n)` returns\n" +
        "  both `:CodeNode` and the kind label in storage-order; `labels(n)[0]` is\n" +
        "  almost always `'CodeNode'` and useless. Use `n.kind` or filter the list.\n" +
        "Properties live on specific kinds; querying e.g. `f.startRow` on a :File returns null.\n" +
        "  :File           → name, path, language, isTest, testFramework, contentHash, lastIndexed, community, pagerank, boundary, is_core\n" +
        "  :Function       → name, path, signature, body, startRow, endRow, httpMethod, route, embedding\n" +
        "  :Method         → name, path, signature, body, startRow, endRow, embedding\n" +
        "  :Class          → name, path, signature, body, startRow, endRow, embedding\n" +
        "  :Interface, :TypeAlias, :Enum → name, path, signature, body, startRow, endRow\n" +
        "  :Property, :Variable → name, path, signature, body, startRow, endRow, builder\n" +
        "  :Repository     → name, path, lastCommit, lastIndexed, sourceUrl\n" +
        "  :Folder         → name, path\n" +
        "  :Community      → communityId, name, label, heuristicLabel, description, size\n" +
        "  :Unresolved     → id, symbol\n\n" +
        "Edge types: CALLS, IMPORTS, EXPORTS, REEXPORTS, REEXPORTS_ALL, DEFINES, CONTAINS, EXTENDS, IMPLEMENTS, HAS_METHOD, " +
        "HAS_PROPERTY, IN_COMMUNITY.\n" +
        "  CALLS/EXTENDS/IMPLEMENTS carry `source`: static, via_imports, via_reexport, name_only, or dynamic.\n" +
        "  EXPORTS(File → declaration) carries `meta_exportedName` — the externally-visible " +
        "name (may differ from the declaration's own name due to `export { x as y }`).\n" +
        "  REEXPORTS(File → File) carries `meta_localName` and `meta_exportedName`; REEXPORTS_ALL covers `export *`.\n\n" +
        "Mutations (CREATE/MERGE/DELETE/SET/REMOVE/DROP/etc.) are rejected.",
      inputSchema: cypherSchema,
    },
    async ({ query, limit }) => {
      if (FORBIDDEN.test(query)) {
        return textResult(
          "ERROR: rejected — query contains a write/mutation keyword. " +
            "This tool is read-only.",
        );
      }
      let records;
      try {
        records = await readQuery(ctx, query);
      } catch (err) {
        return textResult(`Cypher error: ${(err as Error).message}`);
      }
      const lim = limit ?? 50;
      const truncated = records.length > lim;
      const slice = truncated ? records.slice(0, lim) : records;
      const cleaned = slice.map(unwrap);
      const header = truncated
        ? `Returned ${slice.length} of ${records.length} records (truncated to ${lim}):\n\n`
        : `Returned ${slice.length} record(s):\n\n`;
      return textResult(
        header + "```json\n" + JSON.stringify(cleaned, null, 2) + "\n```",
      );
    },
  );
}
