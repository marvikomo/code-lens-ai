/**
 * The storage seam between the MCP tools and wherever the graph lives.
 *
 * Every tool used to be a Cypher string run against a Neo4j driver, which
 * made a running database a hard requirement for the server even though the
 * graph itself is computed in-process. This interface has one method per
 * data need the tools have; `Neo4jStore` answers them with the original
 * Cypher and `LocalStore` answers them from an in-memory `CodeGraph`.
 *
 * Rows are plain data with plain numbers. No driver types, no Neo4j
 * `Integer`s, no node wrappers reach a tool.
 */
import type { NodeKind } from "../util/graph";
import type { SearchHit, SearchMode } from "../search";

export interface RepositoryMeta {
  name: string;
  path: string;
  lastIndexed: string | null;
  lastCommit: string | null;
  sourceUrl?: string | null;
}

export interface KindCount {
  kind: string;
  count: number;
}

export interface LanguageCount {
  language: string;
  count: number;
}

export interface LayerCount {
  layer: string;
  count: number;
  /** Files whose `layerConfidence` is below 0.6. */
  lowConfidence: number;
}

/** A spine (`is_core`) file of a community, with what the freshness check needs. */
export interface SpineRef {
  path: string;
  /** Content hash at index time; "" when unknown (legacy graphs). */
  hash: string;
  /** File-level blast score, or null when the blast pass never ran. */
  blast: number | null;
}

export interface CommunitySummary {
  id: number;
  label: string | null;
  heuristicLabel: string | null;
  description: string | null;
  descriptionWrittenAt: string | null;
  /** Spine paths captured when the description was written (parallel to hashes). */
  descriptionSpineSnapshot: string[];
  descriptionSpineHashes: string[];
  size: number;
  /** Every current spine file. Consumers slice for display. */
  spine: SpineRef[];
  /** Up to three member paths, for unlabeled communities. */
  samplePaths: string[];
}

export interface BlastFile {
  path: string;
  blast: number;
  direct: number;
  transitive: number;
  isSpine: boolean;
  /** Label → heuristic label → `community-N` → "(no community)". */
  community: string;
}

/** What a tool needs to know about the file a symbol lives in. */
export interface FileFacts {
  path: string;
  isCore: boolean;
  pagerank: number;
  boundary: number;
  blastScore?: number;
  blastDirect?: number;
  blastTransitive?: number;
  isTest: boolean;
  communityId?: number;
  communityLabel?: string | null;
}

export interface SymbolRow {
  id: string;
  kind: string;
  name: string;
  path?: string;
  language?: string;
  startRow: number;
  endRow: number;
  signature?: string;
  body?: string;
  bodyTruncated?: boolean;
  /** Present when requested with `withFileFacts`. Null when the file node is missing. */
  file?: FileFacts | null;
}

export interface FindSymbolsOptions {
  name: string;
  /** Restrict to these kinds. Omit for any kind. */
  kinds?: NodeKind[];
  /** Substring match on `path`. */
  pathContains?: string;
  limit?: number;
  /** Also resolve the containing file's metrics and community. */
  withFileFacts?: boolean;
}

/** Minimal identity of a node in a traversal result. Kind may be "Unresolved". */
export interface NodeRef {
  id: string;
  kind: string;
  name: string;
  path?: string;
  startRow?: number;
}

export interface CallerRow {
  caller: NodeRef;
  distance: number;
  targetName: string;
  targetPath?: string;
}

export interface CalleeRow {
  target: NodeRef;
  distance: number;
}

export interface ImpactCallerRow {
  name: string;
  path: string;
  startRow: number;
  /** Shortest-path length to the target. */
  distance: number;
  /** Edge `source` along that shortest path, nearest the caller first. */
  sources: string[];
  /** Relation kinds along that path, e.g. ["CALLS"] or ["EXTENDS"]. */
  rels: string[];
  callerIsCore: boolean;
  callerPagerank: number;
  callerIsTest: boolean;
  callerCommunityId?: number;
  callerCommunityLabel?: string | null;
}

export interface SpineFileRow {
  cid: number;
  path: string;
  name: string;
  pagerank: number;
}

export interface TopFunctionRow {
  cid: number;
  name: string;
  signature: string | null;
  path: string;
  startRow: number;
  callCount: number;
}

export interface CrossCommunityEdge {
  fromId: number;
  fromLabel: string | null;
  fromHeuristic: string | null;
  toId: number;
  toLabel: string | null;
  toHeuristic: string | null;
  count: number;
}

export interface RouteRow {
  method: string;
  route: string;
  path: string;
  startRow: number;
}

export interface TestFileRow {
  path: string;
  framework: string | null;
}

export interface GlossaryRow {
  name: string;
  signature: string | null;
  path: string;
  startRow: number;
  callCount: number;
}

export interface ExternalDepRow {
  cid: number;
  spec: string;
  uses: number;
}

export interface ClusterCoverage {
  total: number;
  clustered: number;
  orphans: string[];
}

export interface SearchOptions {
  mode?: SearchMode;
  kind?: NodeKind;
  limit?: number;
}

export interface GraphStore {
  /** Human-readable backend name for logs and tool descriptions. */
  readonly backend: "neo4j" | "local";
  /** Whether `cypher()` works. False for the local store; the tool is not registered. */
  readonly supportsCypher: boolean;

  repositoryMeta(): Promise<RepositoryMeta | null>;
  countsByKind(): Promise<KindCount[]>;
  languageCounts(): Promise<LanguageCount[]>;
  layerCounts(): Promise<LayerCount[]>;

  /** Materialized communities, largest first. */
  communities(opts?: { limit?: number }): Promise<CommunitySummary[]>;
  topBlastFiles(limit: number): Promise<BlastFile[]>;

  findSymbols(opts: FindSymbolsOptions): Promise<SymbolRow[]>;
  callers(symbol: string, depth: number, limit: number): Promise<CallerRow[]>;
  callees(
    symbol: string,
    opts: { pathContains?: string; depth: number; limit: number },
  ): Promise<CalleeRow[]>;
  /**
   * Every node that reaches `target` through `relations` within `depth`
   * hops, with the shortest path's edge sources and kinds.
   */
  impactCallers(
    target: { name: string; path: string },
    depth: number,
    relations: readonly string[],
  ): Promise<ImpactCallerRow[]>;

  spineFiles(): Promise<SpineFileRow[]>;
  topFunctionsByCommunity(): Promise<TopFunctionRow[]>;
  crossCommunityImports(): Promise<CrossCommunityEdge[]>;
  routes(): Promise<RouteRow[]>;
  /** Files no other file imports. */
  entryPoints(): Promise<string[]>;
  testFiles(): Promise<TestFileRow[]>;
  glossary(limit: number): Promise<GlossaryRow[]>;
  externalDepsByCommunity(): Promise<ExternalDepRow[]>;
  clusterCoverage(): Promise<ClusterCoverage>;

  /**
   * Attach a label (and optionally a description) to a community. When a
   * description is given the store snapshots the current spine so drift can
   * be detected later. Returns false when no such community exists.
   */
  setCommunityLabel(
    communityId: number,
    update: { label: string; description?: string; writtenAt: string },
  ): Promise<boolean>;

  search(query: string, opts?: SearchOptions): Promise<SearchHit[]>;

  /** Read-only free-form query. Throws when `supportsCypher` is false. */
  cypher(query: string): Promise<Record<string, unknown>[]>;

  close(): Promise<void>;
}
