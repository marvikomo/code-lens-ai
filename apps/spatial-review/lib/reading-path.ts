/**
 * Reading-path BFS: takes the PR's file subgraph and produces a deterministic
 * order that mirrors how a reviewer would naturally traverse it — entry-like
 * files first, deps later.
 *
 * Why this order: imports (a)→(b) means "a depends on b." Reviewers start at
 * the OUTSIDE surface (tests, route handlers, exported APIs — things nothing
 * else in the PR imports), then trace inward to what those depend on.
 *
 * Algorithm:
 *   1. Build in-degree per node (within the subgraph).
 *   2. Entry frontier = nodes with in-degree 0. If none (cyclic / fully
 *      interconnected), use the node with the lowest blast as a fallback
 *      entry — heuristic: least-depended-on tends to be the most "leaf-like"
 *      consumer.
 *   3. BFS from the frontier. Within a level, sort by:
 *        isSpine DESC, blastScore DESC, path ASC
 *      Spine first because those files dominate their subsystem; high-blast
 *      next because changes there ripple more; path alpha as a stable
 *      tiebreaker.
 *   4. Append unmatched files (new in the PR, not yet indexed) at the end
 *      with a flag so the UI can surface them distinctly.
 */
import type { PrFileNode, PrSubgraph } from "./neo4j";
import type { DiffLine } from "./diff";

/** Per-filename PR metadata joined into reading-path entries. */
export interface PrFileMeta {
  additions: number;
  deletions: number;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  diff: DiffLine[];
}

export interface ReadingPathEntry {
  matchedPath: string;
  absolutePath: string;
  blastScore: number;
  blastDirect: number;
  blastTransitive: number;
  isSpine: boolean;
  /** True if no other changed file imports this — likely entry surface. */
  isEntry: boolean;
  /** Resolved label fallback chain: label > heuristicLabel > community-N > null */
  communityLabel: string | null;
  communityId: number | null;
  /** BFS depth from entry frontier. 0 = entry point. Used by canvas
   *  to lay nodes out in columns. */
  level: number;
  /** Per-file PR stats (joined from the GitHub PR file list). */
  additions: number;
  deletions: number;
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
  /** Parsed unified-diff lines. Empty if no patch was available
   *  (binary file, too large, GitHub-truncated). */
  diff: import("./diff").DiffLine[];
}

export interface ReadingPath {
  entries: ReadingPathEntry[];
  /** PR files not found in Neo4j (e.g., newly added, not yet indexed). */
  unmatched: string[];
  /** IMPORTS edges within the PR subgraph. Endpoints are matchedPaths. */
  edges: Array<{ from: string; to: string }>;
  /** Computation metadata for debugging / display. */
  meta: {
    matchedCount: number;
    unmatchedCount: number;
    edgeCount: number;
    entryCount: number;
    /** Max BFS depth — number of layout columns the canvas will need. */
    maxLevel: number;
  };
}

export function computeReadingPath(
  subgraph: PrSubgraph,
  fileMeta: Map<string, PrFileMeta>,
): ReadingPath {
  const { nodes, edges, unmatched } = subgraph;

  // matchedPath → in-degree within the PR subgraph
  const inDegree = new Map<string, number>();
  // matchedPath → set of matchedPaths it imports (forward edges)
  const outEdges = new Map<string, Set<string>>();
  for (const n of nodes) {
    inDegree.set(n.matchedPath, 0);
    outEdges.set(n.matchedPath, new Set());
  }
  for (const e of edges) {
    if (!inDegree.has(e.to) || !outEdges.has(e.from)) continue;
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    outEdges.get(e.from)!.add(e.to);
  }

  // Entry frontier: nodes with in-degree 0 in this subgraph.
  let frontier = nodes.filter((n) => (inDegree.get(n.matchedPath) ?? 0) === 0);

  // Fallback: if every node has incoming edges (cyclic), pick the lowest-blast
  // node as the synthetic entry. Don't crash on cycles, don't silently drop
  // nodes — gracefully degrade.
  if (frontier.length === 0 && nodes.length > 0) {
    const sorted = [...nodes].sort(
      (a, b) => a.blastScore - b.blastScore || a.matchedPath.localeCompare(b.matchedPath),
    );
    frontier = [sorted[0]];
  }

  const entryPathSet = new Set(frontier.map((n) => n.matchedPath));

  // BFS, level by level, with within-level sorting. We tag each visited
  // node with its level for downstream canvas layout (column = level).
  const visited = new Set<string>();
  const levelOf = new Map<string, number>();
  const ordered: PrFileNode[] = [];
  let currentLevel: PrFileNode[] = frontier;
  let depth = 0;

  while (currentLevel.length > 0) {
    currentLevel.sort(sortKey);
    const nextLevel: PrFileNode[] = [];
    for (const n of currentLevel) {
      if (visited.has(n.matchedPath)) continue;
      visited.add(n.matchedPath);
      levelOf.set(n.matchedPath, depth);
      ordered.push(n);
      const outs = outEdges.get(n.matchedPath);
      if (!outs) continue;
      for (const to of outs) {
        if (visited.has(to)) continue;
        const target = nodes.find((x) => x.matchedPath === to);
        if (target) nextLevel.push(target);
      }
    }
    currentLevel = nextLevel;
    depth++;
  }

  // Catch any nodes the BFS didn't reach (defensive). Append at the end,
  // assigned to the next level so they don't visually overlap the BFS output.
  for (const n of nodes) {
    if (visited.has(n.matchedPath)) continue;
    levelOf.set(n.matchedPath, depth);
    ordered.push(n);
  }

  const maxLevel = Math.max(0, ...Array.from(levelOf.values()));

  const entries: ReadingPathEntry[] = ordered.map((n) => {
    const meta = fileMeta.get(n.matchedPath);
    return {
      matchedPath: n.matchedPath,
      absolutePath: n.absolutePath,
      blastScore: n.blastScore,
      blastDirect: n.blastDirect,
      blastTransitive: n.blastTransitive,
      isSpine: n.isSpine,
      isEntry: entryPathSet.has(n.matchedPath),
      communityLabel: resolveCommunityLabel(n),
      communityId: n.communityId,
      level: levelOf.get(n.matchedPath) ?? 0,
      // Defaults cover the rare case where the BFS surfaces a node whose
      // filename isn't in fileMeta (shouldn't happen since both derive
      // from the PR file list, but defensive).
      additions: meta?.additions ?? 0,
      deletions: meta?.deletions ?? 0,
      status: meta?.status ?? "modified",
      diff: meta?.diff ?? [],
    };
  });

  return {
    entries,
    unmatched,
    edges,
    meta: {
      matchedCount: nodes.length,
      unmatchedCount: unmatched.length,
      edgeCount: edges.length,
      entryCount: entryPathSet.size,
      maxLevel,
    },
  };
}

function sortKey(a: PrFileNode, b: PrFileNode): number {
  // isSpine DESC: spine files first within a level.
  if (a.isSpine !== b.isSpine) return a.isSpine ? -1 : 1;
  // blastScore DESC: high-blast next.
  if (a.blastScore !== b.blastScore) return b.blastScore - a.blastScore;
  // Path ASC: stable alpha tiebreaker.
  return a.matchedPath.localeCompare(b.matchedPath);
}

function resolveCommunityLabel(n: PrFileNode): string | null {
  if (n.communityLabel) return n.communityLabel;
  if (n.communityHeuristicLabel) return n.communityHeuristicLabel;
  if (n.communityId !== null) return `community-${n.communityId}`;
  return null;
}
