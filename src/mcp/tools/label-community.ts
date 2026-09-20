import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../server";
import { textResult } from "../util";

const labelCommunitySchema: Record<string, any> = {
  communityId: z
    .number()
    .int()
    .describe("The integer community id from get_overview."),
  label: z
    .string()
    .min(1)
    .max(60)
    .describe(
      "Short human-readable name (2-4 words, kebab or snake case, e.g. 'auth-pipeline', 'user-flow-handlers').",
    ),
  description: z
    .string()
    .max(500)
    .optional()
    .describe(
      "One-sentence description of what files in this community share.",
    ),
};

/**
 * Lets the agent attach a semantic label and optional description to a
 * Leiden community. Labels are wiped by any re-clustering run (both
 * `--cluster` and `--cluster-only` drop+rematerialize Community nodes in
 * step 8a) and by `--neo4j-clear`. They persist only between re-clusters.
 * Use `--incremental` for day-to-day updates to preserve labels.
 *
 * Designed to be called on first connect after `get_overview` shows the
 * "ACTION REQUIRED" hint listing unlabeled communities.
 */
export function registerLabelCommunity(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "label_community",
    {
      title: "Label a community with a human-readable name",
      description:
        "Attach a short semantic label (and optional description) to a community " +
        "detected by Leiden clustering. Use this on first connect when get_overview " +
        "shows unlabeled communities — pick a 2-4 word name describing what the " +
        "community does, based on its spine files and sample. Labels are wiped by " +
        "any re-clustering (--cluster, --cluster-only, --neo4j-clear); use " +
        "--incremental for day-to-day updates to preserve them. Subsequent " +
        "get_overview calls show your label instead of community-N.",
      inputSchema: labelCommunitySchema,
    },
    async ({ communityId, label, description }) => {
      // Stamp ISO timestamp + spine snapshot when description is set.
      // Lets future sessions surface "summary written N days ago, spine has
      // shifted M files since" so agents can decide whether to verify.
      const now = new Date().toISOString();
      const found = await ctx.store.setCommunityLabel(communityId, {
        label,
        description,
        writtenAt: now,
      });
      if (!found) {
        return textResult(
          `No community with id ${communityId} — was it materialized? ` +
            `(communities below --cluster-min-size aren't materialized as nodes)`,
        );
      }
      return textResult(`Labeled community ${communityId}: "${label}"`);
    },
  );
}
