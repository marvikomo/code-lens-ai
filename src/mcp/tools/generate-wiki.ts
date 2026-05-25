import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../server";
import { readQuery, asNumber, textResult, int } from "../util";

// Defaults tuned to fit within typical Claude Code MCP result limits
// (~15K tokens) on big repos. All overridable via tool args at call time.
const SPINE_PER_COMMUNITY = 5;
const TOP_FNS_PER_COMMUNITY = 5;
const EXTERNALS_PER_COMMUNITY = 8;
const ROUTES_RENDER_CAP = 80;
const TESTS_RENDER_CAP = 30;
const GLOSSARY_LIMIT_DEFAULT = 25;
const ORPHANS_RENDER_CAP = 5;
const COMMUNITIES_RENDER_CAP_DEFAULT = 15;
const SECTION_DIVIDER = "\n\n---\n\n";

interface CommunityRow {
  id: number;
  label: string | null;
  heuristicLabel: string | null;
  description: string | null;
  descriptionWrittenAt: string | null;
  descriptionSpineSnapshot: string[];
  descriptionSpineHashes: string[];
  currentSpine: string[];
  currentSpineHashes: string[];
  size: number;
}

interface SpineFile {
  cid: number;
  path: string;
  name: string;
  pagerank: number;
}

interface TopFn {
  cid: number;
  name: string;
  signature: string | null;
  path: string;
  startRow: number;
  callCount: number;
}

interface CrossEdge {
  fromId: number;
  fromLabel: string | null;
  fromHeuristic: string | null;
  toId: number;
  toLabel: string | null;
  toHeuristic: string | null;
  count: number;
}

interface Route {
  method: string;
  route: string;
  path: string;
  startRow: number;
}

interface TestFile {
  path: string;
  framework: string | null;
}

interface GlossaryEntry {
  name: string;
  signature: string | null;
  path: string;
  startRow: number;
  callCount: number;
}

interface ExternalImport {
  cid: number;
  spec: string;
  uses: number;
}

interface CoverageStats {
  total: number;
  clustered: number;
  orphans: string[];
}

const inputSchema: Record<string, any> = {
  maxCommunities: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Number of subsystems to render in full detail (default 15). Beyond this, " +
        "smaller communities collapse to a one-line summary. Increase if your client " +
        "supports larger results; decrease if you hit MCP result size limits.",
    ),
  glossaryLimit: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Number of most-called symbols in the glossary (default 25)."),
};

export function registerGenerateWiki(
  server: McpServer,
  ctx: ToolContext,
): void {
  server.registerTool(
    "generate_wiki",
    {
      title: "Generate a wiki skeleton for the indexed codebase",
      description:
        "Produces a structured markdown wiki with the structural facts pre-computed: " +
        "per-community spine files, top functions, route inventory, entry points, test breakdown, " +
        "and a glossary of the most-called symbols. Sections marked [AGENT FILLS] need " +
        "synthesis from you (codebase purpose, per-subsystem narrative, data-flow story). " +
        "Use this when asked to write project documentation, a wiki, an architecture overview, " +
        "or a 'what is this codebase' explanation — replaces the exploratory grep/find chain " +
        "you'd otherwise run. Returns markdown. Read the [AGENT FILLS] sections, do targeted " +
        "read_code/get_definition calls to fill them, then write the final document. " +
        "Tunable: pass maxCommunities and glossaryLimit to dial output size.",
      inputSchema,
    },
    async (args: { maxCommunities?: number; glossaryLimit?: number }) => {
      return await runGenerateWiki(ctx, args);
    },
  );
}

async function runGenerateWiki(
  ctx: ToolContext,
  args: { maxCommunities?: number; glossaryLimit?: number } = {},
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const maxCommunities = args.maxCommunities ?? COMMUNITIES_RENDER_CAP_DEFAULT;
  const glossaryLimit = args.glossaryLimit ?? GLOSSARY_LIMIT_DEFAULT;
  // Run the independent queries in parallel — biggest perf win.
  const [
    repoRows,
    countRows,
    languageRows,
    communityRows,
    spineRows,
    topFnRows,
    crossRows,
    routeRows,
    entryRows,
    testRows,
    glossaryRows,
    externalRows,
    coverageRows,
    topBlastRows,
  ] = await Promise.all([
    readQuery(
      ctx,
      `MATCH (r:Repository)
       RETURN r.name AS name, r.path AS path,
              r.lastIndexed AS lastIndexed, r.lastCommit AS lastCommit
       LIMIT 1`,
    ),
    readQuery(
      ctx,
      `MATCH (n:CodeNode)
       WITH labels(n) AS labels
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
      // Fetch the current spine PATHS + contentHashes alongside the
      // snapshot so describeDescriptionFreshness can detect content drift
      // (same shape as get-overview.ts — see comments there).
      `MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)
       OPTIONAL MATCH (c)<-[:IN_COMMUNITY]-(curSpine:File {is_core: true})
       WITH c, count(DISTINCT f) AS size,
            collect(DISTINCT { path: curSpine.path, hash: curSpine.contentHash }) AS curSpineInfo
       WITH c, size,
            [x IN curSpineInfo WHERE x.path IS NOT NULL | x.path] AS currentSpine,
            [x IN curSpineInfo WHERE x.path IS NOT NULL | coalesce(x.hash, '')] AS currentSpineHashes
       RETURN c.communityId AS id, c.label AS label,
              c.heuristicLabel AS heuristicLabel,
              c.description AS description,
              c.descriptionWrittenAt AS descriptionWrittenAt,
              c.descriptionSpineSnapshot AS descriptionSpineSnapshot,
              c.descriptionSpineHashes AS descriptionSpineHashes,
              currentSpine, currentSpineHashes, size
       ORDER BY size DESC`,
    ),
    readQuery(
      ctx,
      `MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)
       WHERE f.is_core = true
       WITH c.communityId AS cid, f
       ORDER BY f.pagerank DESC
       RETURN cid, f.path AS path, f.name AS name, f.pagerank AS pagerank`,
    ),
    readQuery(
      ctx,
      `MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)-[:DEFINES]->(fn:Function)
       OPTIONAL MATCH (fn)<-[r:CALLS]-(:CodeNode)
       WITH c.communityId AS cid, fn, count(r) AS callCount
       WHERE callCount > 0
       RETURN cid, fn.name AS name, fn.signature AS signature,
              fn.path AS path, fn.startRow AS startRow, callCount
       ORDER BY callCount DESC`,
    ),
    readQuery(
      ctx,
      `MATCH (c1:Community)<-[:IN_COMMUNITY]-(:File)-[:IMPORTS]->(:File)-[:IN_COMMUNITY]->(c2:Community)
       WHERE c1 <> c2
       RETURN c1.communityId AS fromId, c1.label AS fromLabel,
              c1.heuristicLabel AS fromHeuristic,
              c2.communityId AS toId, c2.label AS toLabel,
              c2.heuristicLabel AS toHeuristic,
              count(*) AS count`,
    ),
    readQuery(
      ctx,
      `MATCH (n:Function) WHERE n.httpMethod IS NOT NULL
       RETURN n.httpMethod AS method, n.route AS route,
              n.path AS path, n.startRow AS startRow
       ORDER BY n.path, n.startRow`,
    ),
    readQuery(
      ctx,
      `MATCH (f:File) WHERE NOT (f)<-[:IMPORTS]-()
       RETURN f.path AS path ORDER BY f.path`,
    ),
    readQuery(
      ctx,
      `MATCH (f:File) WHERE f.isTest = true
       RETURN f.path AS path, f.testFramework AS framework
       ORDER BY f.path`,
    ),
    readQuery(
      ctx,
      `MATCH (target)<-[r:CALLS]-(:CodeNode)
       WHERE (target:Function OR target:Method) AND target.name IS NOT NULL
       WITH target, count(r) AS callCount
       ORDER BY callCount DESC LIMIT $limit
       RETURN target.name AS name, target.signature AS signature,
              target.path AS path, target.startRow AS startRow, callCount`,
      { limit: int(glossaryLimit) },
    ),
    readQuery(
      ctx,
      // Skip Java stdlib (java.*, javax.*) — every Java file imports it, so it
      // would dominate the per-community top-N and crowd out actionable signal
      // like Spring/Hibernate/etc.
      `MATCH (c:Community)<-[:IN_COMMUNITY]-(:File)-[:IMPORTS]->(u:Unresolved)
       WHERE u.symbol IS NOT NULL
         AND NOT u.symbol STARTS WITH 'java.'
         AND NOT u.symbol STARTS WITH 'javax.'
       WITH c.communityId AS cid, u.symbol AS spec, count(*) AS uses
       RETURN cid, spec, uses
       ORDER BY cid, uses DESC`,
    ),
    readQuery(
      ctx,
      // Subsystem coverage — files NOT in any materialized :Community are
      // invisible to every per-subsystem render below. Surface the gap honestly
      // so the reader can calibrate trust in the wiki's completeness.
      `MATCH (f:File)
       OPTIONAL MATCH (f)-[ic:IN_COMMUNITY]->(:Community)
       WITH count(f) AS total, count(ic) AS clustered,
            collect(CASE WHEN ic IS NULL THEN f.path END) AS rawOrphans
       RETURN total, clustered,
              [p IN rawOrphans WHERE p IS NOT NULL] AS orphans`,
    ),
    // Top-15 by blast — high-blast file rendering, see get-overview.ts for
    // the formula commentary. Adjacent to Entry points in the wiki so readers
    // see the contrast: high-blast = "files everyone leans on";
    // entry points = "files no one imports."
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
       LIMIT 15`,
    ),
  ]);

  const repo = repoRows[0] ?? { name: "(unknown)", path: "(unknown)" };
  const repoLastIndexed = (repo.lastIndexed as string | undefined) ?? null;
  const repoLastCommit = (repo.lastCommit as string | undefined) ?? null;

  const counts = countRows.map((r) => ({
    kind: String(r.kind),
    count: asNumber(r.count) ?? 0,
  }));

  const languages = languageRows.map((r) => ({
    language: String(r.language),
    count: asNumber(r.count) ?? 0,
  }));

  const communities: CommunityRow[] = communityRows.map((r) => ({
    id: asNumber(r.id) ?? 0,
    label: (r.label as string | null) ?? null,
    heuristicLabel: (r.heuristicLabel as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    descriptionWrittenAt:
      (r.descriptionWrittenAt as string | null) ?? null,
    descriptionSpineSnapshot: Array.isArray(r.descriptionSpineSnapshot)
      ? (r.descriptionSpineSnapshot as unknown[]).map(String)
      : [],
    descriptionSpineHashes: Array.isArray(r.descriptionSpineHashes)
      ? (r.descriptionSpineHashes as unknown[]).map(String)
      : [],
    currentSpine: Array.isArray(r.currentSpine)
      ? (r.currentSpine as unknown[]).map(String)
      : [],
    currentSpineHashes: Array.isArray(r.currentSpineHashes)
      ? (r.currentSpineHashes as unknown[]).map(String)
      : [],
    size: asNumber(r.size) ?? 0,
  }));

  const spine: SpineFile[] = spineRows.map((r) => ({
    cid: asNumber(r.cid) ?? 0,
    path: String(r.path),
    name: String(r.name),
    pagerank: asNumber(r.pagerank) ?? 0,
  }));

  const topFns: TopFn[] = topFnRows.map((r) => ({
    cid: asNumber(r.cid) ?? 0,
    name: String(r.name ?? "(anonymous)"),
    signature: (r.signature as string | null) ?? null,
    path: String(r.path ?? ""),
    startRow: asNumber(r.startRow) ?? 0,
    callCount: asNumber(r.callCount) ?? 0,
  }));

  const cross: CrossEdge[] = crossRows.map((r) => ({
    fromId: asNumber(r.fromId) ?? 0,
    fromLabel: (r.fromLabel as string | null) ?? null,
    fromHeuristic: (r.fromHeuristic as string | null) ?? null,
    toId: asNumber(r.toId) ?? 0,
    toLabel: (r.toLabel as string | null) ?? null,
    toHeuristic: (r.toHeuristic as string | null) ?? null,
    count: asNumber(r.count) ?? 0,
  }));

  const routes: Route[] = routeRows.map((r) => ({
    method: String(r.method),
    route: String(r.route ?? ""),
    path: String(r.path ?? ""),
    startRow: asNumber(r.startRow) ?? 0,
  }));

  const entries: string[] = entryRows.map((r) => String(r.path));

  const tests: TestFile[] = testRows.map((r) => ({
    path: String(r.path),
    framework: (r.framework as string | null) ?? null,
  }));

  const glossary: GlossaryEntry[] = glossaryRows.map((r) => ({
    name: String(r.name),
    signature: (r.signature as string | null) ?? null,
    path: String(r.path ?? ""),
    startRow: asNumber(r.startRow) ?? 0,
    callCount: asNumber(r.callCount) ?? 0,
  }));

  const externals: ExternalImport[] = externalRows.map((r) => ({
    cid: asNumber(r.cid) ?? 0,
    spec: String(r.spec),
    uses: asNumber(r.uses) ?? 0,
  }));

  const coverageRow = coverageRows[0] ?? { total: 0, clustered: 0, orphans: [] };
  const coverage: CoverageStats = {
    total: asNumber(coverageRow.total) ?? 0,
    clustered: asNumber(coverageRow.clustered) ?? 0,
    orphans: Array.isArray(coverageRow.orphans)
      ? (coverageRow.orphans as unknown[]).map((p) => String(p))
      : [],
  };

  const topBlast: BlastFile[] = topBlastRows.map((r) => ({
    path: String(r.path ?? ""),
    blast: asNumber(r.blast) ?? 0,
    direct: asNumber(r.direct) ?? 0,
    transitive: asNumber(r.transitive) ?? 0,
    isSpine: Boolean(r.isSpine),
    community: (r.community as string | null) ?? "(no community)",
  }));

  return textResult(
    renderWiki({
      repoName: String(repo.name),
      repoPath: String(repo.path),
      lastIndexed: repoLastIndexed,
      lastCommit: repoLastCommit,
      counts,
      languages,
      communities,
      spine,
      topFns,
      cross,
      routes,
      entries,
      tests,
      glossary,
      externals,
      coverage,
      topBlast,
      maxCommunities,
    }),
  );
}

interface BlastFile {
  path: string;
  blast: number;
  direct: number;
  transitive: number;
  isSpine: boolean;
  community: string;
}

interface RenderInput {
  repoName: string;
  repoPath: string;
  lastIndexed: string | null;
  lastCommit: string | null;
  maxCommunities: number;
  counts: { kind: string; count: number }[];
  languages: { language: string; count: number }[];
  communities: CommunityRow[];
  spine: SpineFile[];
  topFns: TopFn[];
  cross: CrossEdge[];
  routes: Route[];
  entries: string[];
  tests: TestFile[];
  glossary: GlossaryEntry[];
  externals: ExternalImport[];
  coverage: CoverageStats;
  topBlast: BlastFile[];
}

function renderWiki(d: RenderInput): string {
  const out: string[] = [];
  // Strip the repo prefix from absolute paths so they render as relative —
  // saves significant bytes on big repos with deep paths (e.g. langchainjs).
  const rel = (p: string): string =>
    p.startsWith(d.repoPath) ? p.slice(d.repoPath.length).replace(/^\/+/, "") : p;

  // Label fallback chain — agent-set label > heuristic folder name > nothing.
  // Agents see "(heuristic)" tag on heading so they know it's auto-derived
  // and can be upgraded via label_community.
  const heuristicOnly = d.communities.filter(
    (c) => !c.label && c.heuristicLabel,
  ).length;
  const trulyUnlabeled = d.communities.filter(
    (c) => !c.label && !c.heuristicLabel,
  );

  const headingFor = (c: CommunityRow): string => {
    if (c.label) return `### \`${c.label}\` (community ${c.id}, ${c.size} files)`;
    if (c.heuristicLabel)
      return `### \`${c.heuristicLabel}\` (community ${c.id}, ${c.size} files, heuristic)`;
    return `### community-${c.id} (UNLABELED, ${c.size} files)`;
  };

  const xrefName = (
    label: string | null,
    heuristic: string | null,
    id: number,
  ): string => label ?? heuristic ?? `community-${id}`;

  out.push(`# Wiki for \`${d.repoName}\` (skeleton)`);
  // Index-freshness signal — agents shouldn't trust a stale graph for
  // current-state questions. Same pattern as get_overview.
  const indexAge = describeAge(d.lastIndexed);
  if (indexAge || d.lastCommit) {
    const parts: string[] = [];
    if (indexAge) parts.push(`indexed ${indexAge}`);
    if (d.lastCommit) parts.push(`commit ${d.lastCommit.slice(0, 12)}`);
    out.push(`> ${parts.join(" · ")}`);
  }
  out.push("");
  out.push(`> ⚠️ This is a structural skeleton, not the final wiki. As the agent, you should:`);
  out.push("> 1. Synthesize the **Overview** section from the repo's README + project structure");
  out.push("> 2. Write each subsystem's **Purpose** paragraph by inspecting its spine files");
  out.push("> 3. Write the **How it fits together** narrative by tracing cross-community imports");
  out.push(">");
  out.push(
    "> All numerical and structural facts below are extracted from the indexed graph — trust them. " +
      "All `[AGENT FILLS]` markers are prose you should write.",
  );

  if (heuristicOnly > 0 || trulyUnlabeled.length > 0) {
    out.push("");
    const parts: string[] = [];
    if (heuristicOnly > 0) {
      parts.push(
        `${heuristicOnly} use heuristic folder-name labels (auto-derived)`,
      );
    }
    if (trulyUnlabeled.length > 0) {
      const ids = trulyUnlabeled
        .slice(0, 12)
        .map((c) => c.id)
        .join(", ");
      const tail =
        trulyUnlabeled.length > 12
          ? `, … +${trulyUnlabeled.length - 12} more`
          : "";
      parts.push(
        `${trulyUnlabeled.length} are fully unlabeled (IDs: ${ids}${tail})`,
      );
    }
    out.push(
      `> ⚠️ Of ${d.communities.length} subsystems: ${parts.join("; ")}. ` +
        `Run \`label_community\` to upgrade to semantic names; heuristic labels ` +
        `track current folder structure but lack semantic meaning.`,
    );
  }

  // ─── Overview ──────────────────────────────────────────────────────────
  out.push(SECTION_DIVIDER);
  out.push("## Overview");
  out.push("");
  out.push("[AGENT FILLS — 2-3 sentences from the repo README + top-level structure]");
  out.push("");
  out.push(`**Repo path:** \`${d.repoPath}\``);
  out.push("");

  if (d.languages.length > 0) {
    const langLine = d.languages
      .map((l) => `${l.language} (${l.count} files)`)
      .join(", ");
    out.push(`**Languages:** ${langLine}`);
  }
  if (d.counts.length > 0) {
    const countLine = d.counts
      .filter((c) => c.kind !== "Repository" && c.kind !== "Folder")
      .map((c) => `${c.count.toLocaleString()} ${pluralKind(c.kind, c.count)}`)
      .join(", ");
    out.push(`**Counts:** ${countLine}`);
  }
  out.push(`**Architectural subsystems:** ${d.communities.length} (Leiden-detected)`);

  // Coverage signal — tells the reader what % of files are visible in the
  // per-subsystem sections below. Files in unmaterialized (below-threshold)
  // communities are invisible to the per-community rendering, so surfacing
  // the gap lets the reader calibrate trust in the wiki's completeness.
  if (d.coverage.total > 0) {
    const pct = Math.round((d.coverage.clustered / d.coverage.total) * 100);
    out.push(
      `**Files clustered into subsystems:** ${d.coverage.clustered} of ${d.coverage.total} (${pct}%)`,
    );
    if (d.coverage.orphans.length > 0) {
      const shown = d.coverage.orphans.slice(0, ORPHANS_RENDER_CAP);
      const hidden = d.coverage.orphans.length - shown.length;
      const list = shown.map((p) => `\`${rel(p)}\``).join(", ");
      const tail =
        hidden > 0 ? ` (showing ${shown.length} of ${d.coverage.orphans.length})` : "";
      out.push("");
      const filesWord = d.coverage.orphans.length === 1 ? "file" : "files";
      out.push(
        `> ${d.coverage.orphans.length} ${filesWord} not in any materialized subsystem${tail}: ${list}`,
      );
    }
  }

  // ─── Subsystems ────────────────────────────────────────────────────────
  if (d.communities.length > 0) {
    out.push(SECTION_DIVIDER);
    out.push("## Subsystems");
    out.push("");

    // Pre-index spine + topFns + cross + externals by community id.
    const spineByCid = groupBy(d.spine, (s) => s.cid);
    const topFnsByCid = groupBy(d.topFns, (f) => f.cid);
    const crossByFromId = groupBy(d.cross, (c) => c.fromId);
    const crossByToId = groupBy(d.cross, (c) => c.toId);
    const externalsByCid = groupBy(d.externals, (e) => e.cid);

    // Cap full-detail rendering — the d.communities array is already sorted
    // by size DESC from the Cypher query, so the top-N are the largest.
    const fullDetail = d.communities.slice(0, d.maxCommunities);
    const collapsed = d.communities.slice(d.maxCommunities);

    if (collapsed.length > 0) {
      out.push(
        `> ⚠️ Rendering ${fullDetail.length} of ${d.communities.length} subsystems in full detail. ` +
          `${collapsed.length} smaller subsystem(s) are summarized inline at the end of this section. ` +
          `Run \`cypher\` if you need full data for them.`,
      );
      out.push("");
    }

    for (const c of fullDetail) {
      // Compute freshness first — if invalidated (>50% spine drift), we
      // suppress the agent's label/description and render the community
      // as if it had no semantic label (heuristic or UNLABELED). Lazy
      // invalidation: read-time only, the underlying DB properties stay.
      const freshness = c.description
        ? describeDescriptionFreshness(
            c.descriptionWrittenAt,
            c.descriptionSpineSnapshot,
            c.descriptionSpineHashes,
            c.currentSpine,
            c.currentSpineHashes,
          )
        : null;

      const labelInvalidated = !!(freshness && freshness.invalidated);
      const renderC: CommunityRow = labelInvalidated
        ? { ...c, label: null, description: null }
        : c;
      out.push(headingFor(renderC));
      out.push("");

      if (renderC.description) {
        out.push(`**Purpose:** ${renderC.description}`);
        if (freshness && freshness.annotation) {
          out.push(`> ${freshness.annotation}`);
        }
      } else if (labelInvalidated && c.label) {
        // Stale-auto-invalidated: surface what was there and why so the
        // agent knows there's a re-label opportunity (and what the prior
        // label was — often a useful starting point for the new one).
        const pct = Math.round((freshness?.driftFraction ?? 0) * 100);
        out.push(
          `**Purpose:** [AGENT FILLS — auto-invalidated, was \`${c.label}\` ` +
            `(${pct}% spine drift since labeling). Re-infer from spine files ` +
            `below and call \`label_community\` to refresh.]`,
        );
      } else {
        out.push("**Purpose:** [AGENT FILLS — 1 paragraph inferred from spine files below]");
      }
      out.push("");

      // Spine files (top by pagerank, then by name).
      const spine = (spineByCid.get(c.id) ?? [])
        .sort((a, b) => b.pagerank - a.pagerank)
        .slice(0, SPINE_PER_COMMUNITY);

      out.push("**Spine files (most central by PageRank):**");
      if (spine.length === 0) {
        out.push("- (none flagged is_core in this community)");
      } else {
        for (const s of spine) out.push(`- \`${s.name}\` — ${rel(s.path)}`);
      }
      out.push("");

      // Top functions (top by callCount in this community).
      const fns = (topFnsByCid.get(c.id) ?? [])
        .sort((a, b) => b.callCount - a.callCount)
        .slice(0, TOP_FNS_PER_COMMUNITY);

      out.push("**Top functions (most called within this codebase):**");
      if (fns.length === 0) {
        out.push("- (no internal callers)");
      } else {
        for (const f of fns) {
          const sig = f.signature
            ? f.signature.split("\n")[0].trim().slice(0, 100)
            : f.name;
          out.push(`- \`${sig}\` — ${rel(f.path)}:${f.startRow + 1} (called ${f.callCount}×)`);
        }
      }
      out.push("");

      // Cross-community.
      const importsFrom = (crossByFromId.get(c.id) ?? [])
        .map((e) => xrefName(e.toLabel, e.toHeuristic, e.toId))
        .filter((s, i, arr) => arr.indexOf(s) === i);
      const importedBy = (crossByToId.get(c.id) ?? [])
        .map((e) => xrefName(e.fromLabel, e.fromHeuristic, e.fromId))
        .filter((s, i, arr) => arr.indexOf(s) === i);
      out.push(
        `**Imports from:** ${importsFrom.length > 0 ? importsFrom.join(", ") : "(self-contained)"}`,
      );
      out.push(
        `**Imported by:** ${importedBy.length > 0 ? importedBy.join(", ") : "(none — outermost layer)"}`,
      );

      // External dependencies (imports to :Unresolved nodes — packages or
      // out-of-scope paths). Surfaces what the agent would otherwise discover
      // by grepping `import` statements.
      const externals = (externalsByCid.get(c.id) ?? [])
        .sort((a, b) => b.uses - a.uses)
        .slice(0, EXTERNALS_PER_COMMUNITY);
      if (externals.length > 0) {
        const rendered = externals
          .map((e) => `\`${e.spec}\` (${e.uses}×)`)
          .join(", ");
        out.push(`**External deps (not indexed):** ${rendered}`);
      }
      out.push("");
    }

    // Collapsed summary of the smaller subsystems we didn't render in full.
    if (collapsed.length > 0) {
      out.push(`### Smaller subsystems (${collapsed.length} not detailed)`);
      out.push("");
      out.push(
        `These communities exist in the graph but were collapsed to keep the wiki within size limits. ` +
          `Listed by size descending; use \`cypher\` to inspect any of them in detail.`,
      );
      out.push("");
      for (const c of collapsed) {
        const display = c.label
          ? `\`${c.label}\``
          : c.heuristicLabel
            ? `\`${c.heuristicLabel}\` (heuristic)`
            : `community-${c.id}`;
        const filesWord = c.size === 1 ? "file" : "files";
        out.push(`- ${display} (community ${c.id}, ${c.size} ${filesWord})`);
      }
      out.push("");
    }
  }

  // ─── HTTP routes ───────────────────────────────────────────────────────
  if (d.routes.length > 0) {
    out.push(SECTION_DIVIDER);
    out.push(`## HTTP routes (${d.routes.length} detected)`);
    out.push("");
    out.push("| Method | Route | File |");
    out.push("|---|---|---|");
    for (const r of d.routes.slice(0, ROUTES_RENDER_CAP)) {
      const file = `${rel(r.path)}:${r.startRow + 1}`;
      out.push(`| ${r.method} | ${r.route || "(no path)"} | ${file} |`);
    }
    if (d.routes.length > ROUTES_RENDER_CAP) {
      out.push(`\n*… ${d.routes.length - ROUTES_RENDER_CAP} more routes truncated.*`);
    }
  }

  // ─── Entry points ──────────────────────────────────────────────────────
  out.push(SECTION_DIVIDER);
  // ─── High-blast files ─────────────────────────────────────────────────
  if (d.topBlast.length > 0) {
    out.push(SECTION_DIVIDER);
    out.push("## High-blast files");
    out.push("");
    out.push(
      "Files whose modification ripples widest through the codebase. " +
        "Score = direct importers + 0.5 × transitive importers (up to 8 hops). " +
        "Antonym of Entry points below: high-blast = files everyone leans on; " +
        "entry points = files no one leans on.",
    );
    out.push("");
    out.push("| Rank | File | Blast | Direct | Transitive | Community |");
    out.push("|---|---|---|---|---|---|");
    d.topBlast.forEach((b, i) => {
      const spineMark = b.isSpine ? " ★" : "";
      out.push(
        `| ${i + 1} | \`${rel(b.path)}\`${spineMark} | ${Math.round(b.blast)} | ${b.direct} | ${b.transitive} | ${b.community} |`,
      );
    });
    out.push("");
    out.push("> ★ = also a spine file in its community.");
  }

  out.push(SECTION_DIVIDER);
  out.push("## Entry points");
  out.push("");
  if (d.entries.length === 0) {
    out.push("(None detected — every indexed file is imported by another. Check whether `index.ts` etc. are picked up.)");
  } else {
    out.push("Files that nothing else in the indexed graph imports — likely application starts:");
    out.push("");
    for (const p of d.entries.slice(0, 20)) out.push(`- \`${rel(p)}\``);
    if (d.entries.length > 20) out.push(`\n*… ${d.entries.length - 20} more.*`);
  }

  // ─── Tests ─────────────────────────────────────────────────────────────
  out.push(SECTION_DIVIDER);
  out.push("## Test inventory");
  out.push("");
  if (d.tests.length === 0) {
    out.push("**No test files detected** in this codebase (no AST patterns matched and no path-based fallback hit).");
  } else {
    const byFramework: Record<string, number> = {};
    for (const t of d.tests) {
      const k = t.framework ?? "(unknown)";
      byFramework[k] = (byFramework[k] ?? 0) + 1;
    }
    out.push(`**${d.tests.length}** test file${d.tests.length === 1 ? "" : "s"} detected.`);
    out.push("");
    out.push("| Framework | Files |");
    out.push("|---|---|");
    for (const [k, v] of Object.entries(byFramework)) out.push(`| ${k} | ${v} |`);
    out.push("");
    out.push("**Files:**");
    for (const t of d.tests.slice(0, TESTS_RENDER_CAP)) {
      out.push(`- \`${rel(t.path)}\` (${t.framework ?? "?"})`);
    }
    if (d.tests.length > TESTS_RENDER_CAP) {
      out.push(`\n*… ${d.tests.length - TESTS_RENDER_CAP} more truncated.*`);
    }
  }

  // ─── How it fits together ──────────────────────────────────────────────
  out.push(SECTION_DIVIDER);
  out.push("## How it fits together");
  out.push("");
  out.push(
    "[AGENT FILLS — read 4-6 spine files (entry points + top spines from the largest community) " +
      "and write a 2-3 paragraph data-flow narrative. Cite specific files+lines.]",
  );
  if (d.cross.length > 0) {
    out.push("");
    out.push("**Top cross-community import edges (data-flow hints):**");
    out.push("");
    out.push("| From | → To | Imports |");
    out.push("|---|---|---|");
    const sortedCross = [...d.cross].sort((a, b) => b.count - a.count).slice(0, 15);
    for (const c of sortedCross) {
      const from = xrefName(c.fromLabel, c.fromHeuristic, c.fromId);
      const to = xrefName(c.toLabel, c.toHeuristic, c.toId);
      out.push(`| ${from} | ${to} | ${c.count} |`);
    }
  }

  // ─── Glossary ──────────────────────────────────────────────────────────
  out.push(SECTION_DIVIDER);
  out.push(`## Glossary (top ${d.glossary.length} most-called symbols)`);
  out.push("");
  out.push("Useful as an index and to spot core abstractions:");
  out.push("");
  for (const g of d.glossary) {
    const sig = g.signature
      ? g.signature.split("\n")[0].trim().slice(0, 120)
      : g.name;
    out.push(`- **\`${g.name}\`** (${g.callCount}×) — \`${sig}\` — ${rel(g.path)}:${g.startRow + 1}`);
  }

  return out.join("\n");
}

/**
 * Compact wall-clock age for an ISO timestamp ("3h ago", "2d ago", "5w ago").
 * Mirror of the helper in get-overview.ts; kept inline since the surface is tiny.
 */
function describeAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const ms = Date.now() - ts;
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
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
 * Hash-baseline freshness check for an agent-written community description.
 * Mirror of the helper in get-overview.ts (see that file for full notes on
 * the tiering and the union-size denominator). Kept inline rather than
 * factored because the two surfaces have slightly different render shapes
 * and the helper itself is small.
 */
interface FreshnessResult {
  tier: "verified" | "no-baseline" | "drifted" | "verify" | "stale";
  annotation: string | null;
  invalidated: boolean;
  driftFraction: number;
}

function describeDescriptionFreshness(
  writtenAt: string | null,
  snapshotPaths: string[],
  snapshotHashes: string[],
  currentSpinePaths: string[],
  currentSpineHashes: string[],
): FreshnessResult {
  const snapMap = new Map<string, string>();
  for (let i = 0; i < snapshotPaths.length; i++) {
    snapMap.set(snapshotPaths[i], snapshotHashes[i] ?? "");
  }
  const curMap = new Map<string, string>();
  for (let i = 0; i < currentSpinePaths.length; i++) {
    curMap.set(currentSpinePaths[i], currentSpineHashes[i] ?? "");
  }

  if (snapMap.size === 0 || curMap.size === 0) {
    return { tier: "verified", annotation: null, invalidated: false, driftFraction: 0 };
  }

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
      const snapHash = snapMap.get(path) ?? "";
      const curHash = curMap.get(path) ?? "";
      if (snapHash) hasAnyBaselineHash = true;
      if (snapHash && curHash && snapHash !== curHash) contentChanged++;
    }
  }

  const driftFraction =
    union.size === 0 ? 0 : (dropped + added + contentChanged) / union.size;

  const ageParts: string[] = [];
  if (writtenAt) {
    const ts = Date.parse(writtenAt);
    if (!Number.isNaN(ts)) {
      const ageDays = Math.floor((Date.now() - ts) / 86_400_000);
      if (ageDays >= 7) ageParts.push(`written ${ageDays}d ago`);
    }
  }

  const driftParts: string[] = [];
  if (dropped) driftParts.push(`${dropped} dropped`);
  if (added) driftParts.push(`${added} added`);
  if (contentChanged) driftParts.push(`${contentChanged} content-changed`);

  const totalDrift = dropped + added + contentChanged;

  if (!hasAnyBaselineHash && totalDrift === 0) {
    return {
      tier: "no-baseline",
      annotation: "no content baseline — verify if material",
      invalidated: false,
      driftFraction: 0,
    };
  }

  if (totalDrift === 0 && ageParts.length === 0) {
    return { tier: "verified", annotation: null, invalidated: false, driftFraction: 0 };
  }

  let tier: FreshnessResult["tier"];
  let invalidated = false;
  if (driftFraction === 0) tier = "verified";
  else if (driftFraction <= 0.3) tier = "drifted";
  else if (driftFraction <= 0.5) tier = "verify";
  else {
    tier = "stale";
    invalidated = true;
  }

  const allParts: string[] = [];
  if (driftParts.length > 0) allParts.push(`spine: ${driftParts.join(", ")}`);
  if (ageParts.length > 0) allParts.push(ageParts.join("; "));

  let annotation: string | null = null;
  if (allParts.length > 0) {
    const prefix = tier === "stale" || tier === "verify" ? "⚠️ " : "";
    annotation = `${prefix}${allParts.join("; ")} — verify before relying`;
  }

  return { tier, annotation, invalidated, driftFraction };
}

/**
 * Lowercased + pluralized rendering of a node kind. Hand-tuned because the
 * naive +"s" rule mangles "TypeAlias" → "typealiass" and "Community" → "communitys".
 */
function pluralKind(kind: string, count: number): string {
  if (count === 1) {
    return kind.toLowerCase();
  }
  switch (kind) {
    case "TypeAlias":
      return "type aliases";
    case "Community":
      return "communities";
    case "Class":
      return "classes";
    case "Property":
      return "properties";
    default:
      return `${kind.toLowerCase()}s`;
  }
}

function groupBy<T, K>(xs: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k) ?? [];
    arr.push(x);
    m.set(k, arr);
  }
  return m;
}
