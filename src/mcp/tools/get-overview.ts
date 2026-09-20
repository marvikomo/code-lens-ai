import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../server";
import { textResult } from "../util";

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
        "top architectural communities (subsystems detected via Leiden), the spine files " +
        "in each community (most central, by PageRank+boundary), and — when the index was " +
        "built with --layers — a per-layer file count (api_surface, data_access, tests, ...). " +
        "Use this as the FIRST tool when starting work on an unfamiliar codebase to orient yourself. " +
        "If communities are unlabeled, the response ends with an ACTION REQUIRED block — " +
        "follow it by calling label_community for each unlabeled community to give them " +
        "human-readable names that will persist for future sessions.",
      inputSchema: {},
    },
    async () => {
      const store = ctx.store;
      const [counts, languages, communities, repoMeta, topBlast, layers] = await Promise.all([
        store.countsByKind(),
        store.languageCounts(),
        store.communities({ limit: 12 }),
        store.repositoryMeta(),
        // Top-10 by blast — files whose change ripples widest. Distinct from
        // spine (which is centrality WITHIN a community); high-blast files
        // are damage potential ACROSS the whole graph. Often overlapping but
        // the non-overlaps are interesting: a high-blast non-spine file is
        // "boring utility everyone imports."
        store.topBlastFiles(10),
        // Semantic layers written by `codelens index --layers`. Empty when
        // the repo was indexed without it; the section is then omitted.
        store.layerCounts(),
      ]);

      // Repo prefix used to render relative paths. Falls back to "" so
      // absolute paths render as-is on cold/missing Repository nodes.
      const repoPath: string = repoMeta?.path ?? "";
      const rel = (p: string): string =>
        repoPath && p.startsWith(repoPath)
          ? p.slice(repoPath.length).replace(/^\/+/, "")
          : p;

      const lastIndexedIso = repoMeta?.lastIndexed ?? null;
      const lastCommit = repoMeta?.lastCommit ?? null;
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
        out.push(`- ${r.kind}: ${r.count}`);
      }
      out.push("");
      out.push("## Language distribution (files)");
      for (const r of languages) {
        out.push(`- ${r.language}: ${r.count}`);
      }
      out.push("");
      if (layers.length > 0) {
        out.push("## Semantic layers (files)");
        out.push("");
        out.push(
          "> Each file was assigned one architectural layer by a System One model " +
            "at index time (`--layers`). Orthogonal to communities: a community says " +
            "which files change together, a layer says what a file is for. Query with " +
            "`MATCH (f:File {layer: 'data_access'}) RETURN f.path`. Low-confidence " +
            "picks (< 0.6) are counted separately — treat those as hints.",
        );
        out.push("");
        for (const r of layers) {
          out.push(
            `- ${r.layer}: ${r.count}` +
              (r.lowConfidence > 0 ? ` (${r.lowConfidence} low-confidence)` : ""),
          );
        }
        out.push("");
      }
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
          const spineMark = b.isSpine ? " ★ spine" : "";
          out.push(
            `- ${rel(b.path)}  blast=${Math.round(b.blast)}  ` +
              `(${b.direct} direct, ${b.transitive} transitive) · ${b.community}${spineMark}`,
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

        for (const c of communities) {
          const id = c.id;
          const size = c.size;
          const labelRaw = c.label;
          const heuristicLabel = c.heuristicLabel;
          const descriptionRaw = c.description;
          const descriptionWrittenAt = c.descriptionWrittenAt;

          const snapshotPaths = c.descriptionSpineSnapshot;
          const snapshotHashes = c.descriptionSpineHashes;
          const currentSpinePathsAll = c.spine.map((s) => s.path);
          const currentSpineHashesAll = c.spine.map((s) => s.hash);

          // Zip spine paths with blast for inline rendering. Skip blast on
          // files where it's missing or zero — keeps the line uncluttered for
          // isolated files where the score adds no signal. Six is enough to
          // orient; the full list feeds the freshness check above.
          const spinePaths = c.spine.slice(0, 6).map((s) => {
            const p = rel(s.path);
            const b = s.blast ?? 0;
            return b > 0 ? `${p} (blast=${Math.round(b)})` : p;
          });
          const samplePaths = c.samplePaths.map(rel);

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
