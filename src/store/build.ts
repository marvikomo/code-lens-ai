/**
 * Turns an analysed `CodeGraph` into a local index: computes file metrics in
 * process, stamps them onto the File nodes, and writes `.codelens/`.
 *
 * This is the local counterpart of `indexToNeo4j` + `clusterInNeo4j`. The
 * maths is the same `computeFileMetrics` the Neo4j path calls; only where
 * the numbers end up differs.
 */
import { computeFileMetrics, type MetricsOptions, type MetricsResult } from "../clustering/graph-metrics";
import type { GraphEdge, GraphNode } from "../util/graph";

/** The parts of a `CodeGraph` the local index needs; a loaded `graph.json` qualifies. */
export type GraphData = { nodes: GraphNode[]; edges: GraphEdge[] };
import { newMeta, writeLocalIndex, type LocalMeta } from "./persist";

export interface BuildLocalIndexOptions extends MetricsOptions {
  repoPath: string;
  indexedAt: string;
  lastCommit: string | null;
  sourceUrl?: string | null;
  /** Communities smaller than this are not materialized. Default 3. */
  minCommunitySize?: number;
  /** Recorded in meta when `--embed` ran, so search knows a model to use. */
  embeddingModel?: string;
}

export interface BuildLocalIndexResult {
  meta: LocalMeta;
  metrics: MetricsResult;
  dir: string;
  bytes: number;
  gzipped: boolean;
}

/** Compute metrics and set `node.metrics` on every File node. Pure apart from that mutation. */
export function applyFileMetrics(graph: GraphData, opts: MetricsOptions = {}): MetricsResult {
  const files = graph.nodes.filter((n) => n.kind === "File" && n.path);
  const byPath = new Map(files.map((f) => [f.path!, f]));
  const imports = graph.edges
    .filter((e) => e.kind === "IMPORTS" && !e.unresolved)
    .map((e) => ({ from: e.from.replace(/^file:/, ""), to: e.to.replace(/^file:/, "") }))
    .filter((e) => byPath.has(e.from) && byPath.has(e.to));
  const metrics = computeFileMetrics(
    files.map((f) => ({ id: f.path! })),
    imports,
    opts,
  );
  for (const [p, m] of metrics.byFile) {
    const f = byPath.get(p);
    if (f) f.metrics = m;
  }
  return metrics;
}

export function buildLocalIndex(graph: GraphData, opts: BuildLocalIndexOptions): BuildLocalIndexResult {
  const metrics = applyFileMetrics(graph, opts);
  const meta = newMeta({
    repoPath: opts.repoPath,
    indexedAt: opts.indexedAt,
    lastCommit: opts.lastCommit,
    sourceUrl: opts.sourceUrl,
    minCommunitySize: opts.minCommunitySize ?? 3,
  });
  if (opts.embeddingModel) meta.embeddingModel = opts.embeddingModel;
  const written = writeLocalIndex(opts.repoPath, { graph, meta });
  return { meta, metrics, ...written };
}
