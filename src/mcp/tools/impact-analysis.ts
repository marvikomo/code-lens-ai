import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../server";
import { readQuery, asNumber, textResult } from "../util";

const impactAnalysisSchema: Record<string, any> = {
  symbol: z.string().describe("Symbol name (function/method/class) to analyze."),
  file: z
    .string()
    .optional()
    .describe("Disambiguate by file substring when the name is common."),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("Max transitive caller depth (default 3)."),
};

interface CallerInfo {
  name: string;
  path: string;
  startRow: number;
  source: string;
  isTest: boolean;
  isSpineCaller: boolean;
  callerPagerank: number;
  callerCommunityId?: number;
  callerCommunityLabel?: string;
  /** Relation types along the shortest path from this dependent to the target. */
  rels: string[];
  /** True when the path is inheritance rather than calls. */
  isSubtype: boolean;
}

const HARD_TOTAL_CAP = 80;

/** How many same-named declarations to look at before declaring ambiguity. */
const AMBIGUITY_PROBE_LIMIT = 10;

/**
 * Relations traversed when computing blast radius.
 *
 * All three point dependent → dependency, so one reverse traversal finds
 * everything downstream of a change: `CALLS` finds callers, and
 * `EXTENDS`/`IMPLEMENTS` find subtypes, which a CALLS-only walk missed
 * entirely — changing a base class showed no subclasses at all.
 *
 * File-level relations (`IMPORTS`, `REEXPORTS`) are deliberately excluded:
 * they connect File nodes, and mixing them into a symbol-level path produces
 * chains that jump between the two graphs. File-level reach is covered
 * separately by the precomputed `blastScore`.
 */
const IMPACT_RELATIONS = ["CALLS", "EXTENDS", "IMPLEMENTS"] as const;

export function registerImpactAnalysis(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "impact_analysis",
    {
      title: "Decision-support impact analysis for a symbol change",
      description:
        "Tells you whether to proceed with changing a symbol. Returns: " +
        "(1) a verdict line — 'probably safe' / 'reviewer should focus' / 'risky cross-boundary'; " +
        "(2) whether the change is contained vs leaks across community boundaries; " +
        "(3) which callers are themselves spine files (their changes ripple); " +
        "(4) the test files you'll need to update, as a copy-paste-friendly path list; " +
        "(5) production callers grouped by architectural community. " +
        "Always includes a confidence breakdown: static/import/re-export/name-only/dynamic " +
        "so safe-looking results remain honest about uncertainty. " +
        "Use BEFORE non-trivial edits, before code review, or to decide if it's safe to delete code.",
      inputSchema: impactAnalysisSchema,
    },
    async ({ symbol, file, maxDepth }) => {
      const d = maxDepth ?? 3;
      return await runImpactAnalysis(ctx, symbol, file, d);
    },
  );
}

async function runImpactAnalysis(
  ctx: ToolContext,
  symbol: string,
  file: string | undefined,
  d: number,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  // 1. Locate the target + its home community + its is_core flag.
  const targetParams: Record<string, unknown> = { symbol };
  let targetWhere = "(target:Function OR target:Method OR target:Class OR target:Variable)";
  if (file) {
    targetWhere += " AND target.path CONTAINS $file";
    targetParams.file = file;
  }
  const targetRows = await readQuery(
    ctx,
    `MATCH (target:CodeNode { name: $symbol })
     WHERE ${targetWhere}
     OPTIONAL MATCH (target)<-[:DEFINES]-(targetFile:File)
     OPTIONAL MATCH (targetFile)-[:IN_COMMUNITY]->(targetComm:Community)
     RETURN target, targetFile, targetComm,
            target.path AS targetPath,
            target.startRow AS targetStartRow,
            targetFile.is_core AS targetIsCore,
            targetFile.pagerank AS targetPagerank,
            targetFile.boundary AS targetBoundary,
            targetComm.communityId AS targetCommId,
            targetComm.label AS targetCommLabel
     ORDER BY target.path, target.startRow
     LIMIT ${AMBIGUITY_PROBE_LIMIT}`,
    targetParams,
  );
  if (targetRows.length === 0) {
    return textResult(
      `No symbol named "${symbol}" found${file ? ` in files matching "${file}"` : ""}.`,
    );
  }
  // Several declarations share this name. Analysing an arbitrary one would be
  // a confidently wrong answer, so ask which — the same stance the graph
  // resolver takes for ambiguous type references.
  if (targetRows.length > 1) {
    const options = targetRows
      .map((r) => `  - ${String(r.targetPath ?? "?")}:${asNumber(r.targetStartRow) ?? 0}`)
      .join("\n");
    return textResult(
      `"${symbol}" is ambiguous — ${targetRows.length} declarations share that name:\n` +
        `${options}\n\n` +
        `Re-run with \`file\` set to a path substring that selects one, ` +
        `e.g. file: "${String(targetRows[0].targetPath ?? "")}".`,
    );
  }
  const tr = targetRows[0];
  const targetPath = String(tr.targetPath ?? "");
  const target = tr.target as { properties: Record<string, unknown> };
  const targetFile = tr.targetFile as { properties: Record<string, unknown> } | null;
  const targetComm = tr.targetComm as { properties: Record<string, unknown> } | null;
  const targetIsCore = !!tr.targetIsCore;
  const targetCommId = asNumber(tr.targetCommId);
  const targetCommLabel = tr.targetCommLabel as string | null;
  const targetBoundary = asNumber(tr.targetBoundary) ?? 0;

  // 2. Pull callers (direct + transitive) with caller-side context.
  targetParams.targetPath = targetPath;
  const callerRows = await readQuery(
    ctx,
    `MATCH (target:CodeNode { name: $symbol })
     WHERE (target:Function OR target:Method OR target:Class OR target:Variable)
       AND target.path = $targetPath
     WITH target LIMIT 1
     MATCH p=(caller)-[:${IMPACT_RELATIONS.join("|")}*1..${d}]->(target)
     WITH caller,
          collect({
            distance: length(p),
            sources: [rel IN relationships(p) | coalesce(rel.source, "name_only")],
            rels: [rel IN relationships(p) | type(rel)]
          }) AS paths
     WITH caller,
          reduce(minD = 999999, pathInfo IN paths |
            CASE WHEN pathInfo.distance < minD THEN pathInfo.distance ELSE minD END
          ) AS distance,
          paths
     WITH caller, distance,
          [pathInfo IN paths WHERE pathInfo.distance = distance][0].sources AS sources,
          [pathInfo IN paths WHERE pathInfo.distance = distance][0].rels AS rels
     OPTIONAL MATCH (caller)<-[:DEFINES]-(callerFile:File)
     OPTIONAL MATCH (callerFile)-[:IN_COMMUNITY]->(callerComm:Community)
     RETURN caller.name AS name,
            caller.path AS path,
            caller.startRow AS startRow,
            distance,
            sources,
            rels,
            callerFile.is_core AS callerIsCore,
            callerFile.pagerank AS callerPagerank,
            callerFile.isTest AS callerIsTest,
            callerComm.communityId AS callerCommId,
            callerComm.label AS callerCommLabel`,
    targetParams,
  );

  const allCallers: CallerInfo[] = callerRows.map((r) => {
    const rels = Array.isArray(r.rels) ? r.rels.map(String) : [];
    return {
    rels,
    // Any inheritance hop makes this an inheritance relationship rather than
    // a call, and it is reported in its own section.
    isSubtype: rels.some((t) => t === "EXTENDS" || t === "IMPLEMENTS"),
    name: String(r.name ?? "(anonymous)"),
    path: String(r.path ?? ""),
    startRow: asNumber(r.startRow) ?? 0,
    source: primarySource(r.sources),
    isTest: !!r.callerIsTest,
    isSpineCaller: !!r.callerIsCore,
    callerPagerank: asNumber(r.callerPagerank) ?? 0,
    callerCommunityId: asNumber(r.callerCommId),
    callerCommunityLabel: (r.callerCommLabel as string | null) ?? undefined,
    };
  });

  // Subtypes are impact, but they are not callers — keeping them out of the
  // caller counts stops a class with many subclasses from reading as a
  // heavily-called function.
  const subtypes = allCallers.filter((c) => c.isSubtype);

  // distance==1 callers are direct; rest are transitive.
  const direct = callerRows
    .map((r, i) =>
      asNumber(r.distance) === 1 && !allCallers[i].isSubtype ? allCallers[i] : null,
    )
    .filter((c): c is CallerInfo => c !== null);
  const transitive = allCallers.filter((c) => !c.isSubtype);

  const prodDirect = direct.filter((c) => !c.isTest);
  const testDirect = direct.filter((c) => c.isTest);
  const prodTransitive = transitive.filter((c) => !c.isTest);
  const testTransitive = transitive.filter((c) => c.isTest);
  // Spine callers exclude test files. A test file may be tagged is_core
  // because of high boundary degree (many imports) but tests don't ripple
  // outward, so they're not load-bearing in the blast-radius sense.
  const spineCallers = direct.filter((c) => c.isSpineCaller && !c.isTest);
  const confidence = summarizeConfidence(direct);

  // Group by community — set of communityIds seen in callers (ignoring "this" community).
  const callerCommunityIds = new Set<number>();
  for (const c of allCallers) {
    if (c.callerCommunityId !== undefined) callerCommunityIds.add(c.callerCommunityId);
  }
  const otherCommunities = [...callerCommunityIds].filter((id) => id !== targetCommId);

  // Risk score (metadata only — not rendered, but available to programmatic callers).
  const riskScore =
    prodDirect.length * 1.0 +
    (prodTransitive.length - prodDirect.length) * 0.3 +
    testDirect.length * 0.2 +
    (testTransitive.length - testDirect.length) * 0.05 +
    spineCallers.length * 2.0 +
    otherCommunities.length * 1.5 +
    (targetIsCore ? 10 : 0) +
    targetBoundary * 0.5;

  // 3. Verdict.
  const verdict = computeVerdict({
    prodDirectCount: prodDirect.length,
    spineCount: spineCallers.length,
    crossCommunityCount: otherCommunities.length,
    targetIsCore,
    confidence,
  });

  // 4. Apply truncation policy to production callers grouped by community.
  const renderedProd = truncateProdCallers(prodDirect, otherCommunities, targetCommId);

  // 5. Render verdict-first.
  return textResult(
    renderImpactAnalysis({
      target,
      targetFile,
      targetComm,
      targetCommId,
      targetCommLabel,
      targetIsCore,
      verdict,
      direct,
      transitive,
      prodDirect,
      testDirect,
      prodTransitive,
      testTransitive,
      spineCallers,
      subtypes,
      confidence,
      otherCommunities,
      callerCommunityIds,
      renderedProd,
      riskScore,
      maxDepth: d,
    }),
  );
}

function computeVerdict(args: {
  prodDirectCount: number;
  spineCount: number;
  crossCommunityCount: number;
  targetIsCore: boolean;
  confidence: ConfidenceSummary;
}): { tone: "safe" | "focus" | "risky"; line: string } {
  const {
    prodDirectCount,
    spineCount,
    crossCommunityCount,
    targetIsCore,
    confidence,
  } = args;

  // Risky requires real caller-side signal; targetIsCore alone is not enough
  // (a defunct helper inside a spine file has no real blast radius).
  const isRisky =
    prodDirectCount > 20 ||
    spineCount >= 3 ||
    crossCommunityCount >= 4 ||
    (targetIsCore && prodDirectCount >= 5);

  // Focus has a softer floor; targetIsCore amplifies when there's any traffic.
  const isFocus =
    prodDirectCount > 5 ||
    spineCount >= 1 ||
    crossCommunityCount >= 2 ||
    (targetIsCore && prodDirectCount >= 1);

  // Pluralization helper for "community/communities".
  const communityWord = (n: number) => (n === 1 ? "community" : "communities");

  if (isRisky) {
    return {
      tone: "risky",
      line:
        `⚠️ Risky change. ${prodDirectCount} direct production caller${pluralS(prodDirectCount)}` +
        (crossCommunityCount > 0
          ? ` across ${crossCommunityCount + 1} ${communityWord(crossCommunityCount + 1)}`
          : "") +
        (spineCount > 0 ? `, ${spineCount} spine caller${pluralS(spineCount)}` : "") +
        (targetIsCore ? `, target is itself a spine file` : "") +
        `. ${confidenceSentence(confidence)}`,
    };
  }
  if (isFocus) {
    return {
      tone: "focus",
      line:
        `Reviewer should focus here. ${prodDirectCount} direct production caller${pluralS(prodDirectCount)}` +
        (crossCommunityCount > 0
          ? ` across ${crossCommunityCount + 1} ${communityWord(crossCommunityCount + 1)}`
          : "") +
        (spineCount > 0 ? `, ${spineCount} spine caller${pluralS(spineCount)}` : "") +
        (targetIsCore ? ", in a spine file" : "") +
        `. ${confidenceSentence(confidence)}`,
    };
  }
  return {
    tone: "safe",
    line:
      `Probably safe to change. ${prodDirectCount} direct production caller${pluralS(prodDirectCount)}` +
      `, contained to one community, no spine callers. ${confidenceSentence(confidence)}`,
  };
}

interface ConfidenceSummary {
  high: number;
  nameOnly: number;
  ambiguous: number;
  dynamic: number;
  total: number;
  bySource: Record<string, number>;
}

function summarizeConfidence(callers: CallerInfo[]): ConfidenceSummary {
  const bySource: Record<string, number> = {};
  for (const c of callers) {
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  }
  const high =
    (bySource.static ?? 0) +
    (bySource.via_imports ?? 0) +
    (bySource.via_reexport ?? 0);
  const nameOnly = bySource.name_only ?? 0;
  const ambiguous = bySource.name_only_ambiguous ?? 0;
  const dynamic = bySource.dynamic ?? 0;
  return { high, nameOnly, ambiguous, dynamic, total: callers.length, bySource };
}

function confidenceSentence(c: ConfidenceSummary): string {
  if (c.total === 0) return "0 visible callers at any confidence.";
  const parts = [`${c.high} high-confidence`];
  if (c.nameOnly > 0) parts.push(`${c.nameOnly} name-only`);
  // Called out separately from plain name-only: these were a pick among
  // several same-named declarations, so the caller may not belong here at all.
  if (c.ambiguous > 0) parts.push(`${c.ambiguous} ambiguous-name (guessed)`);
  if (c.dynamic > 0) parts.push(`${c.dynamic} dynamic/heuristic`);
  return `Confidence: ${parts.join(", ")}.`;
}

interface TruncatedProd {
  perCommunity: Map<
    number,
    { kept: CallerInfo[]; total: number; communityLabel?: string }
  >;
  capUsed: number;
}

function truncateProdCallers(
  prodDirect: CallerInfo[],
  _otherCommunities: number[],
  _targetCommId: number | undefined,
): TruncatedProd {
  // Group by community.
  const byComm = new Map<number, CallerInfo[]>();
  const noCommBucket: CallerInfo[] = [];
  for (const c of prodDirect) {
    if (c.callerCommunityId === undefined) {
      noCommBucket.push(c);
      continue;
    }
    const arr = byComm.get(c.callerCommunityId) ?? [];
    arr.push(c);
    byComm.set(c.callerCommunityId, arr);
  }

  // Sort each community's callers: spine first, then by pagerank desc.
  for (const arr of byComm.values()) {
    arr.sort((a, b) => {
      if (a.isSpineCaller !== b.isSpineCaller) return a.isSpineCaller ? -1 : 1;
      return b.callerPagerank - a.callerPagerank;
    });
  }

  // Try caps in descending order until total fits.
  const caps = [10, 5, 3, 1];
  let chosenCap = 10;
  let total = 0;
  for (const cap of caps) {
    total = 0;
    for (const arr of byComm.values()) total += Math.min(arr.length, cap);
    total += Math.min(noCommBucket.length, cap);
    if (total <= HARD_TOTAL_CAP) {
      chosenCap = cap;
      break;
    }
    chosenCap = cap;
  }

  const perCommunity = new Map<
    number,
    { kept: CallerInfo[]; total: number; communityLabel?: string }
  >();
  for (const [cid, arr] of byComm) {
    const kept = arr.slice(0, chosenCap);
    perCommunity.set(cid, {
      kept,
      total: arr.length,
      communityLabel: arr[0].callerCommunityLabel,
    });
  }
  if (noCommBucket.length > 0) {
    // Bucket of callers without a community (shouldn't usually happen — File without IN_COMMUNITY).
    perCommunity.set(-1, {
      kept: noCommBucket.slice(0, chosenCap),
      total: noCommBucket.length,
      communityLabel: "(no community)",
    });
  }

  return { perCommunity, capUsed: chosenCap };
}

interface RenderArgs {
  target: { properties: Record<string, unknown> };
  targetFile: { properties: Record<string, unknown> } | null;
  targetComm: { properties: Record<string, unknown> } | null;
  targetCommId: number | undefined;
  targetCommLabel: string | null;
  targetIsCore: boolean;
  verdict: { tone: "safe" | "focus" | "risky"; line: string };
  direct: CallerInfo[];
  transitive: CallerInfo[];
  prodDirect: CallerInfo[];
  testDirect: CallerInfo[];
  prodTransitive: CallerInfo[];
  testTransitive: CallerInfo[];
  spineCallers: CallerInfo[];
  subtypes: CallerInfo[];
  confidence: ConfidenceSummary;
  otherCommunities: number[];
  callerCommunityIds: Set<number>;
  renderedProd: TruncatedProd;
  riskScore: number;
  maxDepth: number;
}

function renderImpactAnalysis(a: RenderArgs): string {
  const out: string[] = [];
  const targetName = a.target.properties.name;
  const targetPath = a.targetFile?.properties.path ?? "(unknown file)";
  const targetLine = (asNumber(a.target.properties.startRow) ?? 0) + 1;

  out.push(`# Impact analysis: \`${targetName}\` (${targetPath}:${targetLine})`);
  out.push("");

  // Verdict.
  out.push("## Verdict");
  out.push("");
  out.push(a.verdict.line);
  out.push("");
  // File-level blast — broader signal than this symbol's caller set. Useful
  // when the verdict says "safe" but the containing file is a hub: even
  // unrelated edits to the file can ripple.
  const blast = asNumber(a.targetFile?.properties.blastScore);
  if (blast !== undefined && blast > 0) {
    const direct = asNumber(a.targetFile?.properties.blastDirect) ?? 0;
    const transitive = asNumber(a.targetFile?.properties.blastTransitive) ?? 0;
    out.push(
      `**Containing file blast=${Math.round(blast)}** ` +
        `(${direct} direct importers, ${transitive} transitive) — ` +
        `file-level ripple, broader than this symbol's caller set.`,
    );
    out.push("");
  }
  out.push(
    "> Based on visible callers in the indexed graph. Low-confidence and dynamic callers are surfaced separately; still sanity-check before destructive edits.",
  );
  if (a.confidence.nameOnly > 0 || a.confidence.dynamic > 0) {
    out.push("");
    out.push(
      `Confidence breakdown: ${formatConfidenceBreakdown(a.confidence)}.`,
    );
  }
  out.push("");

  // Cross-community headline.
  out.push("## Cross-community impact");
  out.push("");
  if (a.otherCommunities.length === 0) {
    const homeLabel = a.targetCommLabel ?? `community-${a.targetCommId ?? "?"}`;
    out.push(`✅ Contained: all callers are in **${homeLabel}**.`);
  } else {
    const otherLabels = [...a.callerCommunityIds]
      .filter((id) => id !== a.targetCommId)
      .map((id) => {
        const slot = a.renderedProd.perCommunity.get(id);
        return slot?.communityLabel ?? `community-${id}`;
      });
    const word =
      a.otherCommunities.length === 1 ? "boundary" : "boundaries";
    out.push(
      `⚠️ Crosses ${a.otherCommunities.length} other community ${word}: ${otherLabels.join(", ")}.`,
    );
  }
  out.push("");

  // Spine callers (dedicated section).
  // Subtypes — reachable via EXTENDS/IMPLEMENTS rather than CALLS. A
  // CALLS-only traversal reported none of these.
  if (a.subtypes.length > 0) {
    out.push("## Subtypes affected");
    out.push("");
    out.push(
      `${a.subtypes.length} type${a.subtypes.length === 1 ? "" : "s"} inherit${a.subtypes.length === 1 ? "s" : ""} from the target — a signature or contract change reaches these:`,
    );
    out.push("");
    for (const t of a.subtypes.slice(0, 20)) {
      const via = t.rels.includes("IMPLEMENTS") ? "implements" : "extends";
      out.push(`- \`${t.name}\` (${via}) — ${t.path}:${t.startRow + 1}`);
    }
    if (a.subtypes.length > 20) {
      out.push(`- …and ${a.subtypes.length - 20} more`);
    }
    out.push("");
  }

  out.push("## Spine callers");
  out.push("");
  if (a.spineCallers.length === 0) {
    out.push("None — no callers are themselves spine files.");
  } else {
    out.push(
      `${a.spineCallers.length} of your callers are themselves spine files (their changes ripple):`,
    );
    for (const c of a.spineCallers) {
      const commLabel = c.callerCommunityLabel ?? `community-${c.callerCommunityId ?? "?"}`;
      out.push(`- \`${c.name}\` — ${c.path}:${c.startRow + 1} (community: ${commLabel})`);
    }
  }
  out.push("");

  // Test files to update — paths only.
  out.push("## Test files to update");
  out.push("");
  if (a.testDirect.length === 0) {
    out.push("None — no test callers detected.");
  } else {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const c of a.testDirect) {
      if (!seen.has(c.path)) {
        seen.add(c.path);
        paths.push(c.path);
      }
    }
    out.push(`${paths.length} test file${pluralS(paths.length)} (${a.testDirect.length} call site${pluralS(a.testDirect.length)}):`);
    for (const p of paths) out.push(`- ${p}`);
  }
  out.push("");

  // Production callers grouped by community, with truncation.
  out.push("## Production callers");
  out.push("");
  if (a.prodDirect.length === 0) {
    out.push("None — no direct production callers.");
  } else {
    out.push(
      `${a.prodDirect.length} direct production caller${pluralS(a.prodDirect.length)} (per-community cap: ${a.renderedProd.capUsed}):`,
    );
    out.push("");
    // Sort communities so the target's home is rendered first.
    const commIds = [...a.renderedProd.perCommunity.keys()].sort((x, y) => {
      if (x === a.targetCommId) return -1;
      if (y === a.targetCommId) return 1;
      return x - y;
    });
    for (const cid of commIds) {
      const slot = a.renderedProd.perCommunity.get(cid)!;
      const label = slot.communityLabel ?? `community-${cid}`;
      const isHome = cid === a.targetCommId;
      out.push(`### ${label}${isHome ? " (target's home)" : ""}`);
      for (const c of slot.kept) {
        const star = c.isSpineCaller ? "★ " : "";
        out.push(`- ${star}\`${c.name}\` — ${c.path}:${c.startRow + 1} (${sourceLabel(c.source)})`);
      }
      if (slot.total > slot.kept.length) {
        out.push(`- … and ${slot.total - slot.kept.length} more in this community`);
      }
      out.push("");
    }
  }

  // Cross-community detail (full breakdown after the headline).
  if (a.otherCommunities.length > 0) {
    out.push("## Cross-community detail");
    out.push("");
    const allComms = [...a.callerCommunityIds];
    for (const cid of allComms) {
      const slot = a.renderedProd.perCommunity.get(cid);
      const label = slot?.communityLabel ?? `community-${cid}`;
      const isHome = cid === a.targetCommId;
      const total =
        slot?.total ??
        a.transitive.filter((c) => c.callerCommunityId === cid).length;
      out.push(
        `- ${label}: ${total} caller${pluralS(total)}${isHome ? "  ← target's home" : ""}`,
      );
    }
    // Also surface the unlabeled-community ACTION REQUIRED nag.
    const unlabeled = [...a.callerCommunityIds].filter((id) => {
      const slot = a.renderedProd.perCommunity.get(id);
      return !slot || !slot.communityLabel || slot.communityLabel.startsWith("community-");
    });
    if (unlabeled.length > 0) {
      out.push("");
      out.push(
        `⚠️ ACTION REQUIRED: ${unlabeled.length} unlabeled communit${unlabeled.length === 1 ? "y" : "ies"} in this breakdown: ${unlabeled.join(", ")}. ` +
          `Call \`label_community\` for sharper output in future runs.`,
      );
    }
    out.push("");
  }

  // Polyglot fields footer (always render, use N/A explicitly).
  out.push("## Reference");
  out.push("");
  out.push(`- Target file is_core: ${a.targetIsCore ? "yes (target is a spine file)" : "no"}`);
  out.push(`- Direct caller count: ${a.direct.length} (${a.prodDirect.length} prod, ${a.testDirect.length} test)`);
  out.push(`- Caller confidence: ${formatConfidenceBreakdown(a.confidence)}`);
  out.push(`- Transitive caller count (depth ≤ ${a.maxDepth}): ${a.transitive.length} (${a.prodTransitive.length} prod, ${a.testTransitive.length} test)`);
  out.push(`- Interface impl callers: N/A (Tier 2 not yet enabled)`);
  out.push(`- Risk score: ${a.riskScore.toFixed(1)} (advisory metadata, see breakdown above for the actual signal)`);

  return out.join("\n");
}

/** Returns "s" for plural counts, "" for 1. Cleaner than the previous variadic helper. */
function pluralS(n: number): string {
  return n === 1 ? "" : "s";
}

function primarySource(value: unknown): string {
  const sources = Array.isArray(value) ? value : [];
  const first = sources.find((s) => typeof s === "string");
  return typeof first === "string" ? first : "name_only";
}

function sourceLabel(source: string): string {
  switch (source) {
    case "static":
      return "static";
    case "via_imports":
      return "import-confirmed";
    case "via_reexport":
      return "re-export-confirmed";
    case "dynamic":
      return "dynamic";
    case "name_only":
      return "name-only";
    default:
      return source;
  }
}

function formatConfidenceBreakdown(c: ConfidenceSummary): string {
  const ordered = [
    "static",
    "via_imports",
    "via_reexport",
    "name_only",
    "dynamic",
  ];
  const parts = ordered
    .map((source) => ({ source, count: c.bySource[source] ?? 0 }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.count} ${sourceLabel(item.source)}`);
  return parts.length > 0 ? parts.join(", ") : "0 callers";
}
