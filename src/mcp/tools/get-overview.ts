import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server";
import { readQuery, asNumber, textResult } from "../util";

/**
 * Compact wall-clock age for an ISO timestamp ("3h ago", "2d ago", "5w ago").
 * Returns null on missing/unparseable input. Used to surface index drift —
 * agents shouldn't trust a stale graph for current-state questions.
 */
function describeAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const ms = Date.now() - ts;
  if (ms < 0) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 8) return `${wk}w ago`;
  const mo = Math.floor(day / 30);
  return `${mo}mo ago`;
}

/**
 * Build a freshness annotation for an agent-written community description.
 * Combines wall-clock age (from `descriptionWrittenAt`) with spine-file
 * drift (snapshot taken at write-time vs. current spine). Returns null when
 * there's nothing to flag — keeps the overview output uncluttered for fresh,
 * stable summaries.
 */
function describeDescriptionFreshness(
  writtenAt: string | null,
  snapshot: string[],
  currentSpine: string[],
): string | null {
  const parts: string[] = [];

  if (writtenAt) {
    const ts = Date.parse(writtenAt);
    if (!Number.isNaN(ts)) {
      const ageDays = Math.floor((Date.now() - ts) / 86_400_000);
      if (ageDays >= 7) parts.push(`written ${ageDays}d ago`);
    }
  }

  if (snapshot.length > 0 && currentSpine.length > 0) {
    const snap = new Set(snapshot);
    const cur = new Set(currentSpine);
    let added = 0;
    let dropped = 0;
    for (const p of cur) if (!snap.has(p)) added++;
    for (const p of snap) if (!cur.has(p)) dropped++;
    const drift = added + dropped;
    if (drift > 0) {
      parts.push(`spine has shifted (${dropped} dropped, ${added} added since)`);
    }
  }

  if (parts.length === 0) return null;
  return parts.join("; ") + " — verify before relying";
}

export function registerGetOverview(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "get_overview",
    {
      title: "High-level codebase overview",
      description:
        "Return a fast structural summary: total counts by node kind, language distribution, " +
        "top architectural communities (subsystems detected via Leiden), and the spine files " +
        "in each community (most central, by PageRank+boundary). " +
        "Use this as the FIRST tool when starting work on an unfamiliar codebase to orient yourself. " +
        "If communities are unlabeled, the response ends with an ACTION REQUIRED block — " +
        "follow it by calling label_community for each unlabeled community to give them " +
        "human-readable names that will persist for future sessions.",
      inputSchema: {},
    },
    async () => {
      const [counts, languages, communities, repoRows] = await Promise.all([
        readQuery(
          ctx,
          `MATCH (n:CodeNode)
           WITH labels(n) AS labels, n
           UNWIND labels AS l
           WITH l, count(*) AS c WHERE l <> 'CodeNode'
           RETURN l AS kind, c AS count ORDER BY count DESC`,
        ),
        readQuery(
          ctx,
          `MATCH (f:File) WHERE f.language IS NOT NULL
           RETURN f.language AS language, count(*) AS count ORDER BY count DESC`,
        ),
        readQuery(
          ctx,
          // Fetch heuristicLabel for fallback chain, plus full paths so we
          // can render relative-to-repo (basenames alone collide across
          // communities — e.g. langchainjs has many `base.ts` and `index.ts`).
          // Also fetch description timestamp + spine snapshot so we can flag
          // stale summaries to the agent.
          `MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)
           OPTIONAL MATCH (c)<-[:IN_COMMUNITY]-(spine:File {is_core: true})
           WITH c, count(DISTINCT f) AS size,
                collect(DISTINCT spine.path)[..6] AS spinePaths,
                collect(DISTINCT f.path)[..3] AS samplePaths
           RETURN c.communityId AS id,
                  c.label AS label,
                  c.heuristicLabel AS heuristicLabel,
                  c.description AS description,
                  c.descriptionWrittenAt AS descriptionWrittenAt,
                  c.descriptionSpineSnapshot AS descriptionSpineSnapshot,
                  size, spinePaths, samplePaths
           ORDER BY size DESC LIMIT 12`,
        ),
        readQuery(
          ctx,
          `MATCH (r:Repository)
           RETURN r.path AS path, r.lastIndexed AS lastIndexed,
                  r.lastCommit AS lastCommit
           LIMIT 1`,
        ),
      ]);

      // Repo prefix used to render relative paths. Falls back to "" so
      // absolute paths render as-is on cold/missing Repository nodes.
      const repoPath: string =
        (repoRows[0]?.path as string | undefined) ?? "";
      const rel = (p: string): string =>
        repoPath && p.startsWith(repoPath)
          ? p.slice(repoPath.length).replace(/^\/+/, "")
          : p;

      const lastIndexedIso =
        (repoRows[0]?.lastIndexed as string | undefined) ?? null;
      const lastCommit =
        (repoRows[0]?.lastCommit as string | undefined) ?? null;
      const indexAge = describeAge(lastIndexedIso);

      const out: string[] = [];
      out.push("# Codebase overview");
      // Index-freshness signal — agents shouldn't trust a stale graph for
      // current-state questions. Surfaces both wall-clock age and the
      // commit indexed (so agents can compare to current HEAD if needed).
      if (indexAge || lastCommit) {
        const parts: string[] = [];
        if (indexAge) parts.push(`indexed ${indexAge}`);
        if (lastCommit) parts.push(`commit ${lastCommit.slice(0, 12)}`);
        out.push(`> ${parts.join(" · ")}`);
      }
      out.push("");
      out.push("## Node counts");
      for (const r of counts) {
        out.push(`- ${r.kind}: ${asNumber(r.count)}`);
      }
      out.push("");
      out.push("## Language distribution (files)");
      for (const r of languages) {
        out.push(`- ${r.language}: ${asNumber(r.count)}`);
      }
      out.push("");
      if (communities.length === 0) {
        out.push(
          "## Communities\n(none — run `--cluster` to detect architectural subsystems)",
        );
      } else {
        out.push("## Top architectural communities (Leiden + spine)");
        out.push("");
        out.push(
          "> Subsystem `summary:` lines were written by an agent in a prior session " +
            "via `label_community`. They may have drifted from current code. For " +
            "claims you'll act on, verify by `read_code` on a spine file before relying.",
        );
        out.push("");
        // Track each community's labeling state separately:
        //   trulyUnlabeled = no agent label AND no heuristic could be derived
        //   heuristicOnly  = heuristic available, but no semantic label set yet
        // The ACTION REQUIRED block surfaces both cases distinctly so the
        // agent knows which need labeling vs. which could be upgraded.
        const trulyUnlabeled: Array<{
          id: number;
          spine: string[];
          sample: string[];
        }> = [];
        const heuristicOnly: Array<{
          id: number;
          heuristicLabel: string;
          spine: string[];
          sample: string[];
        }> = [];
        for (const r of communities) {
          const id = asNumber(r.id) ?? 0;
          const size = asNumber(r.size);
          const label = (r.label as string | null) ?? null;
          const heuristicLabel =
            (r.heuristicLabel as string | null) ?? null;
          const description = (r.description as string | null) ?? null;
          const descriptionWrittenAt =
            (r.descriptionWrittenAt as string | null) ?? null;
          const snapshotRaw = r.descriptionSpineSnapshot as
            | unknown[]
            | null
            | undefined;
          const descriptionSpineSnapshot: string[] = Array.isArray(snapshotRaw)
            ? (snapshotRaw as unknown[]).map(String)
            : [];
          const spinePaths = ((r.spinePaths as string[]) ?? []).map(rel);
          const samplePaths = ((r.samplePaths as string[]) ?? []).map(rel);

          let heading: string;
          if (label) {
            heading = `- **\`${label}\`** (community ${id}, ${size} files)`;
          } else if (heuristicLabel) {
            heading = `- **\`${heuristicLabel}\`** (community ${id}, ${size} files, heuristic)`;
          } else {
            heading = `- **community-${id}** (UNLABELED, ${size} files)`;
          }

          let summaryLine = "";
          if (description) {
            summaryLine = `\n    summary: ${description}`;
            const freshness = describeDescriptionFreshness(
              descriptionWrittenAt,
              descriptionSpineSnapshot,
              (r.spinePaths as string[]) ?? [],
            );
            if (freshness) summaryLine += `\n    ↳ ${freshness}`;
          }

          out.push(
            heading +
              (spinePaths.length
                ? `\n    spine: ${spinePaths.join(", ")}`
                : "") +
              (samplePaths.length && !label
                ? `\n    sample: ${samplePaths.join(", ")}`
                : "") +
              summaryLine,
          );

          if (!label) {
            if (heuristicLabel) {
              heuristicOnly.push({
                id,
                heuristicLabel,
                spine: spinePaths,
                sample: samplePaths,
              });
            } else {
              trulyUnlabeled.push({ id, spine: spinePaths, sample: samplePaths });
            }
          }
        }

        if (trulyUnlabeled.length > 0 || heuristicOnly.length > 0) {
          out.push("");
          const total = trulyUnlabeled.length + heuristicOnly.length;
          out.push(
            `## ⚠️ ACTION RECOMMENDED — ${total} ${
              total === 1 ? "community lacks" : "communities lack"
            } a semantic label`,
          );
          out.push("");
          out.push(
            "Call `label_community` for each. Suggested format: 2-4 word " +
              'kebab-case name based on what the spine files do ' +
              '(e.g. "auth-pipeline", "user-flow-handlers"). ' +
              "Optionally pass a one-sentence `description` too. " +
              "Heuristic labels are derived from folder names — semantic labels " +
              "from you will be much sharper.",
          );
          out.push("");
          if (heuristicOnly.length > 0) {
            out.push(
              `### Heuristic-labeled (${heuristicOnly.length}) — could be upgraded`,
            );
            for (const u of heuristicOnly) {
              out.push(
                `- communityId: ${u.id} (current heuristic: \`${u.heuristicLabel}\`)`,
              );
              out.push(`    spine: [${u.spine.join(", ")}]`);
              if (u.sample.length) {
                out.push(`    sample: [${u.sample.join(", ")}]`);
              }
            }
            out.push("");
          }
          if (trulyUnlabeled.length > 0) {
            out.push(
              `### Fully unlabeled (${trulyUnlabeled.length}) — no heuristic available`,
            );
            for (const u of trulyUnlabeled) {
              out.push(`- communityId: ${u.id}`);
              out.push(`    spine: [${u.spine.join(", ")}]`);
              if (u.sample.length) {
                out.push(`    sample: [${u.sample.join(", ")}]`);
              }
            }
          }
        }
      }
      return textResult(out.join("\n"));
    },
  );
}
