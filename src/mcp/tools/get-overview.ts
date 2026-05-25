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
 * Result of the staleness check for an agent-written community description.
 *
 * Tiers, in increasing drift severity:
 *   - "verified":   no path or content drift detected; render label cleanly
 *   - "no-baseline": legacy community — has path snapshot but no content
 *                    hashes; can't authoritatively detect content drift, so
 *                    we annotate but don't invalidate
 *   - "drifted":    0% < drift ≤ 30%; label still rendered, annotation shown
 *   - "verify":     30% < drift ≤ 50%; same as drifted but stronger wording
 *   - "stale":      drift > 50%; render layer auto-invalidates the label,
 *                   falls back to heuristic, surfaces the community in a
 *                   dedicated "Stale labels" ACTION subsection
 *
 * Drift fraction uses the union of (snapshot paths ∪ current spine paths)
 * as the denominator — NOT max(snapshot.length, current.length), which
 * could exceed 100% when content-change overlaps with adds/drops.
 */
interface FreshnessResult {
  tier: "verified" | "no-baseline" | "drifted" | "verify" | "stale";
  /** Inline annotation to render under the summary, or null when nothing to flag. */
  annotation: string | null;
  /** Render-layer signal: when true, suppress the label/description and use heuristic fallback. */
  invalidated: boolean;
  driftFraction: number;
  stats: {
    dropped: number;
    added: number;
    contentChanged: number;
    unionSize: number;
  };
}

function describeDescriptionFreshness(
  writtenAt: string | null,
  snapshotPaths: string[],
  snapshotHashes: string[],
  currentSpinePaths: string[],
  currentSpineHashes: string[],
): FreshnessResult {
  const emptyStats = { dropped: 0, added: 0, contentChanged: 0, unionSize: 0 };

  // Build path → hash maps. Empty-string hashes (legacy data) mean "unknown,
  // skip content comparison for this path."
  const snapMap = new Map<string, string>();
  for (let i = 0; i < snapshotPaths.length; i++) {
    snapMap.set(snapshotPaths[i], snapshotHashes[i] ?? "");
  }
  const curMap = new Map<string, string>();
  for (let i = 0; i < currentSpinePaths.length; i++) {
    curMap.set(currentSpinePaths[i], currentSpineHashes[i] ?? "");
  }

  // No snapshot at all → no signal to act on.
  if (snapMap.size === 0 || curMap.size === 0) {
    return {
      tier: "verified",
      annotation: null,
      invalidated: false,
      driftFraction: 0,
      stats: emptyStats,
    };
  }

  // Path drift (dropped + added).
  let dropped = 0;
  let added = 0;
  let contentChanged = 0;
  let hasAnyBaselineHash = false;
  const union = new Set([...snapMap.keys(), ...curMap.keys()]);
  for (const path of union) {
    const inSnap = snapMap.has(path);
    const inCur = curMap.has(path);
    if (inSnap && !inCur) dropped++;
    else if (!inSnap && inCur) added++;
    else {
      // In both — check content if both hashes are real.
      const snapHash = snapMap.get(path) ?? "";
      const curHash = curMap.get(path) ?? "";
      if (snapHash) hasAnyBaselineHash = true;
      if (snapHash && curHash && snapHash !== curHash) contentChanged++;
    }
  }

  const unionSize = union.size;
  const driftFraction =
    unionSize === 0 ? 0 : (dropped + added + contentChanged) / unionSize;

  // Wall-clock age annotation (only added when ≥7d old).
  const ageParts: string[] = [];
  if (writtenAt) {
    const ts = Date.parse(writtenAt);
    if (!Number.isNaN(ts)) {
      const ageDays = Math.floor((Date.now() - ts) / 86_400_000);
      if (ageDays >= 7) ageParts.push(`written ${ageDays}d ago`);
    }
  }

  // Spine drift summary (only added when any drift).
  const driftParts: string[] = [];
  if (dropped) driftParts.push(`${dropped} dropped`);
  if (added) driftParts.push(`${added} added`);
  if (contentChanged) driftParts.push(`${contentChanged} content-changed`);

  const totalDrift = dropped + added + contentChanged;
  const stats = { dropped, added, contentChanged, unionSize };

  // Legacy: snapshot has paths but no usable hashes anywhere.
  // We CAN do path drift (drop/add) but NOT content drift. Flag as
  // no-baseline so the agent knows verification is suggested if material.
  if (!hasAnyBaselineHash && totalDrift === 0) {
    return {
      tier: "no-baseline",
      annotation: "no content baseline — verify if material",
      invalidated: false,
      driftFraction: 0,
      stats,
    };
  }

  if (totalDrift === 0 && ageParts.length === 0) {
    return {
      tier: "verified",
      annotation: null,
      invalidated: false,
      driftFraction: 0,
      stats,
    };
  }

  // Tier by drift fraction.
  let tier: FreshnessResult["tier"];
  let invalidated = false;
  if (driftFraction === 0) {
    tier = "verified"; // age-only signal; not invalidating
  } else if (driftFraction <= 0.3) {
    tier = "drifted";
  } else if (driftFraction <= 0.5) {
    tier = "verify";
  } else {
    tier = "stale";
    invalidated = true;
  }

  // Assemble annotation. Stale tier's "label was X" banner is rendered by
  // the caller — this annotation is the per-summary inline hint.
  const allParts: string[] = [];
  if (driftParts.length > 0) allParts.push(`spine: ${driftParts.join(", ")}`);
  if (ageParts.length > 0) allParts.push(ageParts.join("; "));

  let annotation: string | null = null;
  if (allParts.length > 0) {
    const prefix =
      tier === "stale" || tier === "verify" ? "⚠️ " : "";
    annotation = `${prefix}${allParts.join("; ")} — verify before relying`;
  }

  return { tier, annotation, invalidated, driftFraction, stats };
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
      const [counts, languages, communities, repoRows, topBlast] = await Promise.all([
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
          // communities). Also fetch description timestamp + spine snapshot
          // + CURRENT spine paths AND content hashes — for the hash-based
          // staleness detector that distinguishes "spine drifted" (path
          // changes) from "spine content drifted" (file rewritten in place).
          // spineBlasts is a parallel array to spinePaths, indexed identically;
          // null for files that pre-date the blast-radius pass.
          `MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)
           OPTIONAL MATCH (c)<-[:IN_COMMUNITY]-(spine:File {is_core: true})
           WITH c, count(DISTINCT f) AS size,
                collect(DISTINCT { path: spine.path, hash: spine.contentHash, blast: spine.blastScore }) AS spineInfo,
                collect(DISTINCT f.path)[..3] AS samplePaths
           WITH c, size, samplePaths,
                [x IN spineInfo WHERE x.path IS NOT NULL | x.path][..6] AS spinePaths,
                [x IN spineInfo WHERE x.path IS NOT NULL | x.blast][..6] AS spineBlasts,
                [x IN spineInfo WHERE x.path IS NOT NULL | x.path] AS allCurrentSpinePaths,
                [x IN spineInfo WHERE x.path IS NOT NULL | coalesce(x.hash, '')] AS allCurrentSpineHashes
           RETURN c.communityId AS id,
                  c.label AS label,
                  c.heuristicLabel AS heuristicLabel,
                  c.description AS description,
                  c.descriptionWrittenAt AS descriptionWrittenAt,
                  c.descriptionSpineSnapshot AS descriptionSpineSnapshot,
                  c.descriptionSpineHashes AS descriptionSpineHashes,
                  size, spinePaths, spineBlasts, samplePaths,
                  allCurrentSpinePaths, allCurrentSpineHashes
           ORDER BY size DESC LIMIT 12`,
        ),
        readQuery(
          ctx,
          `MATCH (r:Repository)
           RETURN r.path AS path, r.lastIndexed AS lastIndexed,
                  r.lastCommit AS lastCommit
           LIMIT 1`,
        ),
        // Top-10 by blast — files whose change ripples widest. Distinct from
        // spine (which is centrality WITHIN a community); high-blast files
        // are damage potential ACROSS the whole graph. Often overlapping but
        // the non-overlaps are interesting: a high-blast non-spine file is
        // "boring utility everyone imports."
        readQuery(
          ctx,
          `MATCH (f:File)
           WHERE f.blastScore IS NOT NULL AND f.blastScore > 0
           OPTIONAL MATCH (f)-[:IN_COMMUNITY]->(c:Community)
           RETURN f.path AS path,
                  f.blastScore AS blast,
                  f.blastDirect AS direct,
                  f.blastTransitive AS transitive,
                  f.is_core AS isSpine,
                  coalesce(c.label, c.heuristicLabel,
                           CASE WHEN c.communityId IS NOT NULL
                                THEN 'community-' + toString(c.communityId)
                                ELSE '(no community)' END) AS community
           ORDER BY f.blastScore DESC
           LIMIT 10`,
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
      if (topBlast.length > 0) {
        out.push("## High-blast files (top 10 — changes ripple widely)");
        out.push("");
        out.push(
          "> Files whose modification breaks the most other files. Score = " +
            "direct importers + 0.5 × transitive importers (up to 8 hops). When " +
            "refactoring these, plan extra testing — `impact_analysis` gives the " +
            "precise caller set.",
        );
        out.push("");
        for (const b of topBlast) {
          const path = rel((b.path as string) ?? "");
          const blast = asNumber(b.blast) ?? 0;
          const direct = asNumber(b.direct) ?? 0;
          const transitive = asNumber(b.transitive) ?? 0;
          const community = (b.community as string | null) ?? "(no community)";
          const isSpine = Boolean(b.isSpine);
          const spineMark = isSpine ? " ★ spine" : "";
          out.push(
            `- ${path}  blast=${Math.round(blast)}  ` +
              `(${direct} direct, ${transitive} transitive) · ${community}${spineMark}`,
          );
        }
        out.push("");
      }
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
        const staleAutoInvalidated: Array<{
          id: number;
          formerLabel: string;
          heuristicLabel: string | null;
          driftPct: number;
          writtenAt: string | null;
          spine: string[];
          sample: string[];
        }> = [];

        const stringArr = (v: unknown): string[] =>
          Array.isArray(v) ? (v as unknown[]).map(String) : [];

        for (const r of communities) {
          const id = asNumber(r.id) ?? 0;
          const size = asNumber(r.size);
          const labelRaw = (r.label as string | null) ?? null;
          const heuristicLabel =
            (r.heuristicLabel as string | null) ?? null;
          const descriptionRaw = (r.description as string | null) ?? null;
          const descriptionWrittenAt =
            (r.descriptionWrittenAt as string | null) ?? null;

          const snapshotPaths = stringArr(r.descriptionSpineSnapshot);
          const snapshotHashes = stringArr(r.descriptionSpineHashes);
          const currentSpinePathsAll = stringArr(r.allCurrentSpinePaths);
          const currentSpineHashesAll = stringArr(r.allCurrentSpineHashes);

          const spinePathsRaw = ((r.spinePaths as string[]) ?? []).map(rel);
          const spineBlastsRaw = (r.spineBlasts as unknown[]) ?? [];
          // Zip spine paths with blast for inline rendering. Skip blast on
          // files where it's missing or zero — keeps the line uncluttered for
          // isolated files where the score adds no signal.
          const spinePaths = spinePathsRaw.map((p, i) => {
            const b = asNumber(spineBlastsRaw[i]) ?? 0;
            return b > 0 ? `${p} (blast=${Math.round(b)})` : p;
          });
          const samplePaths = ((r.samplePaths as string[]) ?? []).map(rel);

          // Compute freshness first — if invalidated, we suppress the label
          // for rendering and route the community to the staleAutoInvalidated
          // bucket. Lazy auto-invalidation happens here, not at write time.
          const freshness = descriptionRaw
            ? describeDescriptionFreshness(
                descriptionWrittenAt,
                snapshotPaths,
                snapshotHashes,
                currentSpinePathsAll,
                currentSpineHashesAll,
              )
            : null;

          const labelInvalidated = !!(freshness && freshness.invalidated);
          const label = labelInvalidated ? null : labelRaw;
          const description = labelInvalidated ? null : descriptionRaw;

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
            if (freshness && freshness.annotation) {
              summaryLine += `\n    ↳ ${freshness.annotation}`;
            }
          } else if (labelInvalidated && labelRaw) {
            // Stale-auto-invalidated: show what we suppressed and why,
            // inline. The ACTION block will list it again for visibility.
            const pct = Math.round((freshness?.driftFraction ?? 0) * 100);
            summaryLine =
              `\n    ⚠️ auto-invalidated: was \`${labelRaw}\` ` +
              `(${pct}% spine drift since labeling) — run label_community to refresh`;
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

          // Bucket for the ACTION block. Stale-invalidated has its own
          // subsection so the agent's re-labeling pass can target it
          // specifically (different from never-labeled or heuristic-only).
          if (labelInvalidated && labelRaw) {
            staleAutoInvalidated.push({
              id,
              formerLabel: labelRaw,
              heuristicLabel,
              driftPct: Math.round((freshness?.driftFraction ?? 0) * 100),
              writtenAt: descriptionWrittenAt,
              spine: spinePaths,
              sample: samplePaths,
            });
          } else if (!label) {
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

        const actionTotal =
          trulyUnlabeled.length +
          heuristicOnly.length +
          staleAutoInvalidated.length;
        if (actionTotal > 0) {
          out.push("");
          out.push(
            `## ⚠️ ACTION RECOMMENDED — ${actionTotal} ${
              actionTotal === 1 ? "community needs" : "communities need"
            } attention`,
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
          // Stale-auto-invalidated first — these were previously labeled and
          // the previous label is still informative as a starting point, so
          // re-labeling them is highest leverage.
          if (staleAutoInvalidated.length > 0) {
            out.push(
              `### Stale labels (${staleAutoInvalidated.length}) — auto-invalidated, need refresh`,
            );
            for (const u of staleAutoInvalidated) {
              const heur = u.heuristicLabel
                ? ` (currently rendering as heuristic: \`${u.heuristicLabel}\`)`
                : "";
              out.push(
                `- communityId: ${u.id} — was \`${u.formerLabel}\`, ${u.driftPct}% spine drift${heur}`,
              );
              out.push(`    spine: [${u.spine.join(", ")}]`);
              if (u.sample.length) {
                out.push(`    sample: [${u.sample.join(", ")}]`);
              }
            }
            out.push("");
          }
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
