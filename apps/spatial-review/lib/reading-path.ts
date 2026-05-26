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
}

export interface ReadingPath {
  entries: ReadingPathEntry[];
  /** PR files not found in Neo4j (e.g., newly added, not yet indexed). */
  unmatched: string[];
  /** Computation metadata for debugging / display. */
  meta: {
    matchedCount: number;
    unmatchedCount: number;
    edgeCount: number;
    entryCount: number;
  };
}

export function computeReadingPath(subgraph: PrSubgraph): ReadingPath {
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

  // BFS, level by level, with within-level sorting.
  const visited = new Set<string>();
  const ordered: PrFileNode[] = [];
  let currentLevel: PrFileNode[] = frontier;

  while (currentLevel.length > 0) {
    currentLevel.sort(sortKey);
    const nextLevel: PrFileNode[] = [];
    for (const n of currentLevel) {
      if (visited.has(n.matchedPath)) continue;
      visited.add(n.matchedPath);
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
  }

  // Catch any nodes the BFS didn't reach (e.g., disconnected component with
  // all nodes having in-degree > 0 — shouldn't happen given the fallback,
  // but defensive). Append at the end, sorted.
  for (const n of nodes) {
    if (visited.has(n.matchedPath)) continue;
    ordered.push(n);
  }

  const entries: ReadingPathEntry[] = ordered.map((n) => ({
    matchedPath: n.matchedPath,
    absolutePath: n.absolutePath,
    blastScore: n.blastScore,
    blastDirect: n.blastDirect,
    blastTransitive: n.blastTransitive,
    isSpine: n.isSpine,
    isEntry: entryPathSet.has(n.matchedPath),
    communityLabel: resolveCommunityLabel(n),
    communityId: n.communityId,
  }));

  return {
    entries,
    unmatched,
    meta: {
      matchedCount: nodes.length,
      unmatchedCount: unmatched.length,
      edgeCount: edges.length,
      entryCount: entryPathSet.size,
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
