import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";

/**
 * The graph analytics behind `get_overview`'s subsystems and spine files,
 * computed in process instead of by Neo4j's GDS plugin.
 *
 * Why this is not a downgrade: the clustered graph is the **File** graph, not
 * the symbol graph — on a 3,482-file repo (k6) that is ~3.5k nodes. GDS is
 * built for graphs several orders of magnitude larger, and in exchange it
 * required Docker, a plugin install, and a `gds.*` security allowlist before
 * `get_overview` produced anything at all.
 *
 * Everything here is deterministic. Community ids feed `label_community`,
 * whose labels are keyed to them, so assignments that drift between identical
 * runs would silently re-point an agent's labels at the wrong files. The three
 * determinism guards are: sorted node insertion, canonicalized+sorted edges,
 * and a seeded RNG. The middle one is not hypothetical — graphify shipped a
 * fix for exactly this, where a graph library yielding an undirected edge's
 * endpoints in a different order made community assignments drift across
 * machines.
 */

export interface FileVertex {
  /** Graph node id. */
  readonly id: string;
}

export interface ImportEdge {
  /** Importing file — the dependent. */
  readonly from: string;
  /** Imported file — the dependency. */
  readonly to: string;
}

export interface MetricsOptions {
  /** Per-community top-K by PageRank tagged as spine. Default 5. */
  readonly spinePagerank?: number;
  /** Per-community top-K by boundary degree also tagged as spine. Default 3. */
  readonly spineBoundary?: number;
  /**
   * Hop cap for transitive blast radius. Default 8 — past that, "depends on"
   * stops being a meaningful signal on a large monorepo.
   */
  readonly blastMaxHops?: number;
  /** PageRank damping. Default 0.85. */
  readonly damping?: number;
  /** PageRank iteration cap. Default 100. */
  readonly maxIterations?: number;
  /** PageRank L1 convergence threshold. Default 1e-6. */
  readonly tolerance?: number;
  /** Seed for the community-detection RNG. Default 42, matching the old `randomSeed`. */
  readonly seed?: number;
}

export interface FileMetrics {
  readonly community: number;
  readonly pagerank: number;
  readonly boundary: number;
  readonly blastDirect: number;
  readonly blastTransitive: number;
  readonly blastScore: number;
  readonly isCore: boolean;
}

export interface MetricsResult {
  readonly byFile: Map<string, FileMetrics>;
  readonly communityCount: number;
  /** Newman modularity of the partition — a quality signal worth logging. */
  readonly modularity: number;
}

/**
 * Deterministic small-state PRNG (mulberry32). Louvain needs a random source
 * for tie-breaking; supplying our own makes runs reproducible.
 */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Canonical undirected edge key. Sorting the endpoints means `(a,b)` and
 * `(b,a)` collapse to one edge regardless of which direction the extractor
 * happened to emit.
 */
function canonicalEdge(from: string, to: string): [string, string] {
  return from <= to ? [from, to] : [to, from];
}

/** PageRank over the undirected import graph, matching the old GDS projection. */
function pageRank(
  ids: readonly string[],
  neighbours: ReadonlyMap<string, Set<string>>,
  opts: Required<Pick<MetricsOptions, "damping" | "maxIterations" | "tolerance">>,
): Map<string, number> {
  const n = ids.length;
  const scores = new Map<string, number>();
  if (n === 0) return scores;

  const initial = 1 / n;
  for (const id of ids) scores.set(id, initial);

  for (let iter = 0; iter < opts.maxIterations; iter++) {
    const next = new Map<string, number>();
    let danglingMass = 0;

    for (const id of ids) {
      const degree = neighbours.get(id)?.size ?? 0;
      if (degree === 0) danglingMass += scores.get(id) ?? 0;
      next.set(id, 0);
    }

    for (const id of ids) {
      const nbrs = neighbours.get(id);
      if (!nbrs || nbrs.size === 0) continue;
      const share = (scores.get(id) ?? 0) / nbrs.size;
      for (const nbr of nbrs) next.set(nbr, (next.get(nbr) ?? 0) + share);
    }

    const base = (1 - opts.damping) / n + (opts.damping * danglingMass) / n;
    let delta = 0;
    for (const id of ids) {
      const value = base + opts.damping * (next.get(id) ?? 0);
      delta += Math.abs(value - (scores.get(id) ?? 0));
      next.set(id, value);
    }

    for (const id of ids) scores.set(id, next.get(id) ?? 0);
    if (delta < opts.tolerance) break;
  }

  return scores;
}

/**
 * For each file, how many other files import it directly, and how many reach
 * it transitively within `maxHops`.
 *
 * This walks the **directed** import graph in reverse, unlike clustering which
 * projects undirected — "who breaks if this changes" is a directional question.
 */
function blastRadius(
  ids: readonly string[],
  importers: ReadonlyMap<string, Set<string>>,
  maxHops: number,
): Map<string, { direct: number; transitive: number }> {
  const result = new Map<string, { direct: number; transitive: number }>();

  for (const target of ids) {
    const directSet = importers.get(target);
    const direct = directSet?.size ?? 0;

    // Reverse BFS: everything that reaches `target` through import edges.
    const seen = new Set<string>([target]);
    let frontier: string[] = [...(directSet ?? [])];
    for (const f of frontier) seen.add(f);

    for (let hop = 1; hop < maxHops && frontier.length > 0; hop++) {
      const nextFrontier: string[] = [];
      for (const node of frontier) {
        const preds = importers.get(node);
        if (!preds) continue;
        for (const pred of preds) {
          if (seen.has(pred)) continue;
          seen.add(pred);
          nextFrontier.push(pred);
        }
      }
      frontier = nextFrontier;
    }

    // `seen` holds the target plus every reachable importer.
    const total = seen.size - 1;
    result.set(target, { direct, transitive: Math.max(0, total - direct) });
  }

  return result;
}

/**
 * Pick each community's spine: the top-K by PageRank plus the top-M by
 * boundary degree. Additive, matching the previous two-pass Cypher.
 *
 * Ties break on node id so the spine set is stable across runs.
 */
function selectSpine(
  ids: readonly string[],
  community: ReadonlyMap<string, number>,
  pagerankScores: ReadonlyMap<string, number>,
  boundaryScores: ReadonlyMap<string, number>,
  topPagerank: number,
  topBoundary: number,
): Set<string> {
  const byCommunity = new Map<number, string[]>();
  for (const id of ids) {
    const c = community.get(id);
    if (c === undefined) continue;
    const bucket = byCommunity.get(c) ?? [];
    bucket.push(id);
    byCommunity.set(c, bucket);
  }

  const spine = new Set<string>();
  for (const members of byCommunity.values()) {
    const byPagerank = [...members].sort(
      (a, b) =>
        (pagerankScores.get(b) ?? 0) - (pagerankScores.get(a) ?? 0) ||
        a.localeCompare(b),
    );
    for (const id of byPagerank.slice(0, topPagerank)) spine.add(id);

    const byBoundary = [...members]
      .filter((id) => (boundaryScores.get(id) ?? 0) > 0)
      .sort(
        (a, b) =>
          (boundaryScores.get(b) ?? 0) - (boundaryScores.get(a) ?? 0) ||
          a.localeCompare(b),
      );
    for (const id of byBoundary.slice(0, topBoundary)) spine.add(id);
  }
  return spine;
}

/**
 * Community detection, PageRank, boundary degree, blast radius and spine
 * selection over a file-import graph.
 *
 * Isolated files (no imports either way) are still assigned a community of
 * their own, matching the previous behaviour where Leiden scored every
 * projected node.
 */
export function computeFileMetrics(
  files: readonly FileVertex[],
  edges: readonly ImportEdge[],
  options: MetricsOptions = {},
): MetricsResult {
  const spinePagerank = options.spinePagerank ?? 5;
  const spineBoundary = options.spineBoundary ?? 3;
  const blastMaxHops = options.blastMaxHops ?? 8;
  const seed = options.seed ?? 42;

  // Determinism guard 1: insert nodes in sorted order.
  const ids = [...new Set(files.map((f) => f.id))].sort();
  if (ids.length === 0) {
    return { byFile: new Map(), communityCount: 0, modularity: 0 };
  }
  const known = new Set(ids);

  // Determinism guard 2: canonicalize each undirected edge, dedupe, sort.
  const undirectedKeys = new Set<string>();
  const neighbours = new Map<string, Set<string>>();
  const importers = new Map<string, Set<string>>();
  for (const id of ids) {
    neighbours.set(id, new Set());
    importers.set(id, new Set());
  }

  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    const [a, b] = canonicalEdge(edge.from, edge.to);
    undirectedKeys.add(`${a} ${b}`);
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
    // Directed, for blast radius: `to` is imported by `from`.
    importers.get(edge.to)!.add(edge.from);
  }

  const graph = new UndirectedGraph();
  for (const id of ids) graph.addNode(id);
  for (const key of [...undirectedKeys].sort()) {
    const [a, b] = key.split(" ");
    graph.addEdge(a, b);
  }

  // Determinism guard 3: seeded RNG for Louvain's tie-breaking.
  const detailed = louvain.detailed(graph, { rng: seededRng(seed) });
  const rawCommunity = detailed.communities as Record<string, number>;

  // Renumber communities by their smallest member id so ids depend on graph
  // content rather than on visitation order.
  const firstMember = new Map<number, string>();
  for (const id of ids) {
    const c = rawCommunity[id];
    if (c === undefined) continue;
    const seenAt = firstMember.get(c);
    if (seenAt === undefined || id < seenAt) firstMember.set(c, id);
  }
  const ordered = [...firstMember.entries()].sort((x, y) =>
    x[1].localeCompare(y[1]),
  );
  const renumbered = new Map<number, number>();
  ordered.forEach(([rawId], index) => renumbered.set(rawId, index));

  const community = new Map<string, number>();
  for (const id of ids) {
    const raw = rawCommunity[id];
    if (raw === undefined) continue;
    community.set(id, renumbered.get(raw) ?? 0);
  }

  const pagerankScores = pageRank(ids, neighbours, {
    damping: options.damping ?? 0.85,
    maxIterations: options.maxIterations ?? 100,
    tolerance: options.tolerance ?? 1e-6,
  });

  // Boundary degree: distinct neighbours sitting in a different community.
  const boundaryScores = new Map<string, number>();
  for (const id of ids) {
    const own = community.get(id);
    let count = 0;
    for (const nbr of neighbours.get(id) ?? []) {
      if (community.get(nbr) !== own) count++;
    }
    boundaryScores.set(id, count);
  }

  const blast = blastRadius(ids, importers, blastMaxHops);
  const spine = selectSpine(
    ids,
    community,
    pagerankScores,
    boundaryScores,
    spinePagerank,
    spineBoundary,
  );

  const byFile = new Map<string, FileMetrics>();
  for (const id of ids) {
    const b = blast.get(id) ?? { direct: 0, transitive: 0 };
    byFile.set(id, {
      community: community.get(id) ?? 0,
      pagerank: pagerankScores.get(id) ?? 0,
      boundary: boundaryScores.get(id) ?? 0,
      blastDirect: b.direct,
      blastTransitive: b.transitive,
      blastScore: b.direct + 0.5 * b.transitive,
      isCore: spine.has(id),
    });
  }

  return {
    byFile,
    communityCount: renumbered.size,
    modularity: detailed.modularity,
  };
}
