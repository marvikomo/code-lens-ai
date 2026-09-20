/**
 * On-disk format for the local backend: a `.codelens/` folder in the repo.
 *
 *   graph.json[.gz]  nodes + edges, including per-file metrics and layers
 *   labels.json      agent-written community labels, keyed by community id
 *   meta.json        when and what was indexed
 *
 * `graph.json` has the same `{ nodes, edges }` shape as `codelens index --out`,
 * so an old dump loads as an index. Labels live apart from the graph so a
 * re-index never wipes them — the Neo4j backend loses labels on every
 * re-cluster and that has been a standing complaint.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import type { CodeGraph, GraphEdge, GraphNode } from "../util/graph";

export const LOCAL_DIR = ".codelens";
const FORMAT_VERSION = 1;
/** Above this many bytes the graph is gzipped; below, plain JSON stays greppable. */
const GZIP_THRESHOLD = 50 * 1024 * 1024;

export interface LocalMeta {
  version: number;
  repoPath: string;
  repoName: string;
  indexedAt: string;
  lastCommit: string | null;
  sourceUrl: string | null;
  /** Communities smaller than this are not materialized (mirrors `--cluster-min-size`). */
  minCommunitySize: number;
  /** Set when `--embed` wrote `embeddings.bin`. */
  embeddingModel?: string;
}

export interface CommunityLabel {
  label: string;
  labelWrittenAt: string;
  description?: string;
  descriptionWrittenAt?: string;
  descriptionSpineSnapshot?: string[];
  descriptionSpineHashes?: string[];
}

export type LabelsFile = Record<string, CommunityLabel>;

export interface LocalIndex {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  meta: LocalMeta;
  labels: LabelsFile;
}

export function localDir(repoPath: string): string {
  return path.join(repoPath, LOCAL_DIR);
}

export function localIndexExists(repoPath: string): boolean {
  const dir = localDir(repoPath);
  return (
    fs.existsSync(path.join(dir, "meta.json")) &&
    (fs.existsSync(path.join(dir, "graph.json")) || fs.existsSync(path.join(dir, "graph.json.gz")))
  );
}

export function writeLocalIndex(
  repoPath: string,
  index: { graph: CodeGraph | { nodes: GraphNode[]; edges: GraphEdge[] }; meta: LocalMeta },
): { dir: string; bytes: number; gzipped: boolean } {
  const dir = localDir(repoPath);
  fs.mkdirSync(dir, { recursive: true });

  const payload = JSON.stringify({ nodes: index.graph.nodes, edges: index.graph.edges });
  const gzipped = payload.length > GZIP_THRESHOLD;
  const plain = path.join(dir, "graph.json");
  const gz = path.join(dir, "graph.json.gz");
  if (gzipped) {
    fs.writeFileSync(gz, zlib.gzipSync(payload));
    if (fs.existsSync(plain)) fs.unlinkSync(plain);
  } else {
    fs.writeFileSync(plain, payload, "utf8");
    if (fs.existsSync(gz)) fs.unlinkSync(gz);
  }
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(index.meta, null, 2), "utf8");
  // Labels are never written here: they belong to the agent, not the indexer.
  if (!fs.existsSync(path.join(dir, "labels.json"))) writeLabels(repoPath, {});
  return { dir, bytes: payload.length, gzipped };
}

export function readLocalIndex(repoPath: string): LocalIndex {
  const dir = localDir(repoPath);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    throw new Error(
      `No local index at ${dir}. Run \`codelens index ${repoPath}\` first, ` +
        `or pass --neo4j-uri to use a Neo4j backend.`,
    );
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as LocalMeta;
  if (meta.version !== FORMAT_VERSION) {
    throw new Error(
      `Local index at ${dir} is format v${meta.version}; this build reads v${FORMAT_VERSION}. Re-run \`codelens index\`.`,
    );
  }
  const gz = path.join(dir, "graph.json.gz");
  const raw = fs.existsSync(gz)
    ? zlib.gunzipSync(fs.readFileSync(gz)).toString("utf8")
    : fs.readFileSync(path.join(dir, "graph.json"), "utf8");
  const graph = JSON.parse(raw) as { nodes: GraphNode[]; edges: GraphEdge[] };
  return { graph, meta, labels: readLabels(repoPath) };
}

export function readLabels(repoPath: string): LabelsFile {
  const p = path.join(localDir(repoPath), "labels.json");
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as LabelsFile;
  } catch {
    return {};
  }
}

export function writeLabels(repoPath: string, labels: LabelsFile): void {
  const dir = localDir(repoPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "labels.json"), JSON.stringify(labels, null, 2), "utf8");
}

export function newMeta(args: {
  repoPath: string;
  indexedAt: string;
  lastCommit: string | null;
  sourceUrl?: string | null;
  minCommunitySize: number;
}): LocalMeta {
  return {
    version: FORMAT_VERSION,
    repoPath: args.repoPath,
    repoName: path.basename(args.repoPath),
    indexedAt: args.indexedAt,
    lastCommit: args.lastCommit,
    sourceUrl: args.sourceUrl ?? null,
    minCommunitySize: args.minCommunitySize,
  };
}

/** True when `.codelens` is already ignored by the repo's root .gitignore. */
export function isLocalDirIgnored(repoPath: string): boolean {
  const gi = path.join(repoPath, ".gitignore");
  if (!fs.existsSync(gi)) return false;
  return fs
    .readFileSync(gi, "utf8")
    .split("\n")
    .some((line) => /^\/?\.codelens\/?\s*$/.test(line.trim()));
}
