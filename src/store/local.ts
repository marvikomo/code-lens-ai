/**
 * `GraphStore` over an in-memory `CodeGraph`.
 *
 * Loaded from `.codelens/` (see `persist.ts`) or built directly from a graph
 * the indexer just produced. Every query is a filter or a bounded traversal
 * over a handful of indexes built once in the constructor; the whole graph
 * for a large monorepo is a few hundred thousand nodes, which is nothing.
 *
 * Where Neo4j's answer depended on storage order (`collect()` without an
 * `ORDER BY`), this store sorts deterministically instead. Where Neo4j
 * joined through `DEFINES` to find a symbol's file — which misses methods,
 * since only top-level declarations have that edge — this store uses the
 * node's own `path`.
 */
import type { FileMetrics } from "../clustering/graph-metrics";
import { heuristicLabelFor } from "../clustering/graph-metrics";
import type { SearchHit } from "../search";
import type { GraphEdge, GraphNode } from "../util/graph";
import { readLocalIndex, writeLabels, type LabelsFile, type LocalMeta } from "./persist";
import type {
  BlastFile,
  CalleeRow,
  CallerRow,
  ClusterCoverage,
  CommunitySummary,
  CrossCommunityEdge,
  ExternalDepRow,
  FileFacts,
  FindSymbolsOptions,
  GlossaryRow,
  GraphStore,
  ImpactCallerRow,
  KindCount,
  LanguageCount,
  LayerCount,
  NodeRef,
  RepositoryMeta,
  RouteRow,
  SearchOptions,
  SpineFileRow,
  SpineRef,
  SymbolRow,
  TestFileRow,
  TopFunctionRow,
} from "./types";
import { LocalSearch } from "./local-search";

export interface LocalStoreOptions {
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  meta: LocalMeta;
  labels?: LabelsFile;
  /** When set, `setCommunityLabel` persists to `<repoPath>/.codelens/labels.json`. */
  persistLabels?: boolean;
}

interface Community {
  id: number;
  members: GraphNode[];
  /** `is_core` members, highest PageRank first. */
  spine: GraphNode[];
}

const CALLABLE: ReadonlySet<string> = new Set(["Function", "Method"]);
const UNRESOLVED_PREFIX = "unresolved:";

export class LocalStore implements GraphStore {
  readonly backend = "local" as const;
  readonly supportsCypher = false;

  private readonly nodes: GraphNode[];
  private readonly edges: GraphEdge[];
  private readonly meta: LocalMeta;
  private labels: LabelsFile;
  private readonly persistLabels: boolean;

  private readonly nodeById = new Map<string, GraphNode>();
  private readonly nodesByName = new Map<string, GraphNode[]>();
  private readonly fileByPath = new Map<string, GraphNode>();
  private readonly outEdges = new Map<string, GraphEdge[]>();
  private readonly inEdges = new Map<string, GraphEdge[]>();
  /** Materialized communities (size >= minCommunitySize), keyed by id. */
  private readonly communityById = new Map<number, Community>();
  private searchIndex: LocalSearch | null = null;

  static open(repoPath: string): LocalStore {
    const index = readLocalIndex(repoPath);
    return new LocalStore({ ...index, persistLabels: true });
  }

  constructor(opts: LocalStoreOptions) {
    this.nodes = opts.graph.nodes;
    this.edges = opts.graph.edges;
    this.meta = opts.meta;
    this.labels = opts.labels ?? {};
    this.persistLabels = opts.persistLabels ?? false;

    for (const n of this.nodes) {
      this.nodeById.set(n.id, n);
      push(this.nodesByName, n.name, n);
      if (n.kind === "File" && n.path) this.fileByPath.set(n.path, n);
    }
    for (const e of this.edges) {
      push(this.outEdges, e.from, e);
      push(this.inEdges, e.to, e);
    }

    const members = new Map<number, GraphNode[]>();
    for (const f of this.fileByPath.values()) {
      if (f.metrics) push(members, f.metrics.community, f);
    }
    for (const [id, files] of members) {
      if (files.length < this.meta.minCommunitySize) continue;
      files.sort((a, b) => a.path!.localeCompare(b.path!));
      const spine = files
        .filter((f) => f.metrics!.isCore)
        .sort((a, b) => b.metrics!.pagerank - a.metrics!.pagerank || a.path!.localeCompare(b.path!));
      this.communityById.set(id, { id, members: files, spine });
    }
  }

  // ─── overview / wiki aggregates ───────────────────────────────────────────

  async repositoryMeta(): Promise<RepositoryMeta> {
    return {
      name: this.meta.repoName,
      path: this.meta.repoPath,
      lastIndexed: this.meta.indexedAt,
      lastCommit: this.meta.lastCommit,
      sourceUrl: this.meta.sourceUrl,
    };
  }

  async countsByKind(): Promise<KindCount[]> {
    const counts = new Map<string, number>();
    for (const n of this.nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
    // Neo4j materializes communities as `:Community:CodeNode` nodes, so they
    // show up in its kind counts. Match that.
    if (this.communityById.size > 0) counts.set("Community", this.communityById.size);
    return [...counts]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  }

  async languageCounts(): Promise<LanguageCount[]> {
    const counts = new Map<string, number>();
    for (const f of this.fileByPath.values()) {
      if (f.language) counts.set(f.language, (counts.get(f.language) ?? 0) + 1);
    }
    return [...counts]
      .map(([language, count]) => ({ language, count }))
      .sort((a, b) => b.count - a.count || a.language.localeCompare(b.language));
  }

  async layerCounts(): Promise<LayerCount[]> {
    const counts = new Map<string, { count: number; lowConfidence: number }>();
    for (const f of this.fileByPath.values()) {
      if (!f.layer) continue;
      const slot = counts.get(f.layer) ?? { count: 0, lowConfidence: 0 };
      slot.count++;
      if ((f.layerConfidence ?? 1) < 0.6) slot.lowConfidence++;
      counts.set(f.layer, slot);
    }
    return [...counts]
      .map(([layer, c]) => ({ layer, ...c }))
      .sort((a, b) => b.count - a.count || a.layer.localeCompare(b.layer));
  }

  async communities(opts: { limit?: number } = {}): Promise<CommunitySummary[]> {
    const rows = [...this.communityById.values()]
      .sort((a, b) => b.members.length - a.members.length || a.id - b.id)
      .map((c) => {
        const l = this.labels[String(c.id)];
        return {
          id: c.id,
          label: l?.label ?? null,
          heuristicLabel: this.heuristicLabel(c),
          description: l?.description ?? null,
          descriptionWrittenAt: l?.descriptionWrittenAt ?? null,
          descriptionSpineSnapshot: l?.descriptionSpineSnapshot ?? [],
          descriptionSpineHashes: l?.descriptionSpineHashes ?? [],
          size: c.members.length,
          spine: c.spine.map((f) => this.spineRef(f)),
          samplePaths: c.members.slice(0, 3).map((f) => f.path!),
        };
      });
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  async topBlastFiles(limit: number): Promise<BlastFile[]> {
    return [...this.fileByPath.values()]
      .filter((f) => (f.metrics?.blastScore ?? 0) > 0)
      .sort((a, b) => b.metrics!.blastScore - a.metrics!.blastScore || a.path!.localeCompare(b.path!))
      .slice(0, limit)
      .map((f) => ({
        path: f.path!,
        blast: f.metrics!.blastScore,
        direct: f.metrics!.blastDirect,
        transitive: f.metrics!.blastTransitive,
        isSpine: f.metrics!.isCore,
        community: this.communityDisplayName(f),
      }));
  }

  // ─── symbols and traversals ───────────────────────────────────────────────

  async findSymbols(opts: FindSymbolsOptions): Promise<SymbolRow[]> {
    const kinds = opts.kinds ? new Set<string>(opts.kinds) : null;
    return (this.nodesByName.get(opts.name) ?? [])
      .filter((n) => !kinds || kinds.has(n.kind))
      .filter((n) => !opts.pathContains || (n.path ?? "").includes(opts.pathContains))
      .sort(byPathAndRow)
      .slice(0, opts.limit ?? 20)
      .map((n) => {
        const row = symbolRow(n);
        if (opts.withFileFacts) row.file = n.path ? this.fileFacts(n.path) : null;
        return row;
      });
  }

  async callers(symbol: string, depth: number, limit: number): Promise<CallerRow[]> {
    const rows: CallerRow[] = [];
    // Real nodes with that name, plus the placeholder for an external symbol
    // (Neo4j matches `target.symbol = $symbol` on `:Unresolved`).
    const targets: Array<{ id: string; name: string; path?: string }> = (
      this.nodesByName.get(symbol) ?? []
    ).map((n) => ({ id: n.id, name: n.name, path: n.path }));
    for (const prefix of ["callable", "class"]) {
      const id = `${UNRESOLVED_PREFIX}${prefix}:${symbol}`;
      if (this.inEdges.has(id)) targets.push({ id, name: symbol });
    }
    for (const t of targets) {
      for (const [id, dist] of this.reach(t.id, depth, "in", ["CALLS"])) {
        const caller = this.nodeById.get(id);
        if (!caller) continue;
        rows.push({ caller: nodeRef(caller), distance: dist, targetName: t.name, targetPath: t.path });
      }
    }
    return rows
      .sort((a, b) => a.distance - b.distance || (a.caller.path ?? "").localeCompare(b.caller.path ?? ""))
      .slice(0, limit);
  }

  async callees(
    symbol: string,
    opts: { pathContains?: string; depth: number; limit: number },
  ): Promise<CalleeRow[]> {
    const sources = (this.nodesByName.get(symbol) ?? [])
      .filter((n) => CALLABLE.has(n.kind))
      .filter((n) => !opts.pathContains || (n.path ?? "").includes(opts.pathContains))
      .sort(byPathAndRow)
      .slice(0, 5);
    const best = new Map<string, number>();
    for (const src of sources) {
      for (const [id, dist] of this.reach(src.id, opts.depth, "out", ["CALLS"])) {
        const prev = best.get(id);
        if (prev === undefined || dist < prev) best.set(id, dist);
      }
    }
    return [...best]
      .map(([id, distance]) => ({ target: this.refFor(id), distance }))
      .sort((a, b) => a.distance - b.distance || a.target.name.localeCompare(b.target.name))
      .slice(0, opts.limit);
  }

  async impactCallers(
    target: { name: string; path: string },
    depth: number,
    relations: readonly string[],
  ): Promise<ImpactCallerRow[]> {
    const node = (this.nodesByName.get(target.name) ?? [])
      .filter((n) => ["Function", "Method", "Class", "Variable"].includes(n.kind))
      .find((n) => n.path === target.path);
    if (!node) return [];

    // Reverse BFS. The first time a node is reached is along a shortest
    // path, and that path's edges (caller-first) are what the row reports.
    const paths = new Map<string, GraphEdge[]>([[node.id, []]]);
    let frontier = [node.id];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of this.inEdges.get(id) ?? []) {
          if (!relations.includes(e.kind) || paths.has(e.from)) continue;
          paths.set(e.from, [e, ...paths.get(id)!]);
          next.push(e.from);
        }
      }
      frontier = next;
    }
    paths.delete(node.id);

    const rows: ImpactCallerRow[] = [];
    for (const [id, edgesOnPath] of paths) {
      const caller = this.nodeById.get(id);
      if (!caller) continue;
      const file = caller.path ? this.fileFacts(caller.path) : null;
      rows.push({
        name: caller.name,
        path: caller.path ?? "",
        startRow: caller.range?.start.row ?? 0,
        distance: edgesOnPath.length,
        sources: edgesOnPath.map((e) => e.source ?? "name_only"),
        rels: edgesOnPath.map((e) => e.kind),
        callerIsCore: file?.isCore ?? false,
        callerPagerank: file?.pagerank ?? 0,
        callerIsTest: file?.isTest ?? false,
        callerCommunityId: file?.communityId,
        callerCommunityLabel: file?.communityLabel ?? null,
      });
    }
    return rows.sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path) || a.startRow - b.startRow);
  }

  // ─── wiki ─────────────────────────────────────────────────────────────────

  async spineFiles(): Promise<SpineFileRow[]> {
    const rows: SpineFileRow[] = [];
    for (const c of this.communityById.values()) {
      for (const f of c.spine) {
        rows.push({ cid: c.id, path: f.path!, name: f.name, pagerank: f.metrics!.pagerank });
      }
    }
    return rows.sort((a, b) => b.pagerank - a.pagerank || a.path.localeCompare(b.path));
  }

  async topFunctionsByCommunity(): Promise<TopFunctionRow[]> {
    const rows: TopFunctionRow[] = [];
    for (const c of this.communityById.values()) {
      for (const f of c.members) {
        for (const e of this.outEdges.get(f.id) ?? []) {
          if (e.kind !== "DEFINES") continue;
          const fn = this.nodeById.get(e.to);
          if (!fn || fn.kind !== "Function") continue;
          const callCount = this.incomingCalls(fn.id);
          if (callCount === 0) continue;
          rows.push({
            cid: c.id,
            name: fn.name,
            signature: fn.signature ?? null,
            path: fn.path ?? "",
            startRow: fn.range?.start.row ?? 0,
            callCount,
          });
        }
      }
    }
    return rows.sort((a, b) => b.callCount - a.callCount || a.path.localeCompare(b.path) || a.startRow - b.startRow);
  }

  async crossCommunityImports(): Promise<CrossCommunityEdge[]> {
    const counts = new Map<string, CrossCommunityEdge>();
    for (const e of this.edges) {
      if (e.kind !== "IMPORTS") continue;
      const from = this.materializedCommunityOf(this.nodeById.get(e.from));
      const to = this.materializedCommunityOf(this.nodeById.get(e.to));
      if (from === undefined || to === undefined || from === to) continue;
      const key = `${from}->${to}`;
      const row = counts.get(key) ?? {
        fromId: from,
        fromLabel: this.labels[String(from)]?.label ?? null,
        fromHeuristic: this.heuristicLabel(this.communityById.get(from)!),
        toId: to,
        toLabel: this.labels[String(to)]?.label ?? null,
        toHeuristic: this.heuristicLabel(this.communityById.get(to)!),
        count: 0,
      };
      row.count++;
      counts.set(key, row);
    }
    return [...counts.values()].sort((a, b) => a.fromId - b.fromId || a.toId - b.toId);
  }

  async routes(): Promise<RouteRow[]> {
    return this.nodes
      .filter((n) => n.kind === "Function" && n.httpMethod)
      .sort(byPathAndRow)
      .map((n) => ({
        method: n.httpMethod!,
        route: n.route ?? "",
        path: n.path ?? "",
        startRow: n.range?.start.row ?? 0,
      }));
  }

  async entryPoints(): Promise<string[]> {
    return [...this.fileByPath.values()]
      .filter((f) => !(this.inEdges.get(f.id) ?? []).some((e) => e.kind === "IMPORTS"))
      .map((f) => f.path!)
      .sort();
  }

  async testFiles(): Promise<TestFileRow[]> {
    return [...this.fileByPath.values()]
      .filter((f) => f.isTest)
      .sort((a, b) => a.path!.localeCompare(b.path!))
      .map((f) => ({ path: f.path!, framework: f.testFramework ?? null }));
  }

  async glossary(limit: number): Promise<GlossaryRow[]> {
    return this.nodes
      .filter((n) => CALLABLE.has(n.kind) && n.name)
      .map((n) => ({
        name: n.name,
        signature: n.signature ?? null,
        path: n.path ?? "",
        startRow: n.range?.start.row ?? 0,
        callCount: this.incomingCalls(n.id),
      }))
      .filter((r) => r.callCount > 0)
      .sort((a, b) => b.callCount - a.callCount || a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      .slice(0, limit);
  }

  async externalDepsByCommunity(): Promise<ExternalDepRow[]> {
    const counts = new Map<string, ExternalDepRow>();
    for (const e of this.edges) {
      if (e.kind !== "IMPORTS" || !e.unresolved) continue;
      if (e.unresolved.startsWith("java.") || e.unresolved.startsWith("javax.")) continue;
      const cid = this.materializedCommunityOf(this.nodeById.get(e.from));
      if (cid === undefined) continue;
      const key = `${cid}\u0000${e.unresolved}`;
      const row = counts.get(key) ?? { cid, spec: e.unresolved, uses: 0 };
      row.uses++;
      counts.set(key, row);
    }
    return [...counts.values()].sort((a, b) => a.cid - b.cid || b.uses - a.uses || a.spec.localeCompare(b.spec));
  }

  async clusterCoverage(): Promise<ClusterCoverage> {
    const orphans: string[] = [];
    let clustered = 0;
    for (const f of this.fileByPath.values()) {
      if (this.materializedCommunityOf(f) !== undefined) clustered++;
      else orphans.push(f.path!);
    }
    return { total: this.fileByPath.size, clustered, orphans: orphans.sort() };
  }

  // ─── writes ───────────────────────────────────────────────────────────────

  async setCommunityLabel(
    communityId: number,
    update: { label: string; description?: string; writtenAt: string },
  ): Promise<boolean> {
    const c = this.communityById.get(communityId);
    if (!c) return false;
    const prev = this.labels[String(communityId)];
    const next = { ...prev, label: update.label, labelWrittenAt: update.writtenAt };
    if (update.description) {
      next.description = update.description;
      next.descriptionWrittenAt = update.writtenAt;
      next.descriptionSpineSnapshot = c.spine.map((f) => f.path!);
      next.descriptionSpineHashes = c.spine.map((f) => f.contentHash ?? "");
    }
    this.labels = { ...this.labels, [String(communityId)]: next };
    if (this.persistLabels) writeLabels(this.meta.repoPath, this.labels);
    return true;
  }

  // ─── search / escape hatch ────────────────────────────────────────────────

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    this.searchIndex ??= new LocalSearch(this.nodes, this.meta);
    return this.searchIndex.search(query, opts);
  }

  async cypher(): Promise<Record<string, unknown>[]> {
    throw new Error("Cypher queries need the Neo4j backend (index with --neo4j-uri).");
  }

  async close(): Promise<void> {
    // Nothing to release; labels are written through on each change.
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  /** Node ids reachable from `start` within `depth` hops along `kinds`, with shortest distance. */
  private reach(
    start: string,
    depth: number,
    direction: "in" | "out",
    kinds: readonly string[],
  ): Map<string, number> {
    const seen = new Map<string, number>([[start, 0]]);
    let frontier = [start];
    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        const edges = direction === "in" ? this.inEdges.get(id) : this.outEdges.get(id);
        for (const e of edges ?? []) {
          if (!kinds.includes(e.kind)) continue;
          const other = direction === "in" ? e.from : e.to;
          if (seen.has(other)) continue;
          seen.set(other, d);
          next.push(other);
        }
      }
      frontier = next;
    }
    seen.delete(start);
    return seen;
  }

  private incomingCalls(id: string): number {
    return (this.inEdges.get(id) ?? []).filter((e) => e.kind === "CALLS").length;
  }

  private fileFacts(filePath: string): FileFacts | null {
    const f = this.fileByPath.get(filePath);
    if (!f) return null;
    const m: FileMetrics | undefined = f.metrics;
    const cid = this.materializedCommunityOf(f);
    return {
      path: f.path!,
      isCore: m?.isCore ?? false,
      pagerank: m?.pagerank ?? 0,
      boundary: m?.boundary ?? 0,
      blastScore: m?.blastScore,
      blastDirect: m?.blastDirect,
      blastTransitive: m?.blastTransitive,
      isTest: !!f.isTest,
      communityId: cid,
      communityLabel: cid === undefined ? undefined : this.labels[String(cid)]?.label ?? null,
    };
  }

  private materializedCommunityOf(file: GraphNode | undefined): number | undefined {
    const cid = file?.metrics?.community;
    return cid !== undefined && this.communityById.has(cid) ? cid : undefined;
  }

  /** Label → heuristic → `community-N` → "(no community)", as Neo4j's `coalesce` chain. */
  private communityDisplayName(file: GraphNode): string {
    const cid = this.materializedCommunityOf(file);
    if (cid === undefined) return "(no community)";
    return this.labels[String(cid)]?.label ?? this.heuristicLabel(this.communityById.get(cid)!) ?? `community-${cid}`;
  }

  private heuristicLabel(c: Community): string | null {
    return heuristicLabelFor(c.members.map((f) => this.rel(f.path!)));
  }

  private rel(p: string): string {
    return p.startsWith(this.meta.repoPath) ? p.slice(this.meta.repoPath.length) : p;
  }

  private spineRef(f: GraphNode): SpineRef {
    return { path: f.path!, hash: f.contentHash ?? "", blast: f.metrics?.blastScore ?? null };
  }

  /** A NodeRef for a real node or an `unresolved:*` placeholder id. */
  private refFor(id: string): NodeRef {
    const n = this.nodeById.get(id);
    if (n) return nodeRef(n);
    const symbol = id.startsWith(UNRESOLVED_PREFIX) ? id.slice(id.indexOf(":", UNRESOLVED_PREFIX.length) + 1) : id;
    return { id, kind: "Unresolved", name: symbol };
  }
}

// ─── module helpers ─────────────────────────────────────────────────────────

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

function byPathAndRow(a: GraphNode, b: GraphNode): number {
  return (a.path ?? "").localeCompare(b.path ?? "") || (a.range?.start.row ?? 0) - (b.range?.start.row ?? 0);
}

function nodeRef(n: GraphNode): NodeRef {
  return { id: n.id, kind: n.kind, name: n.name, path: n.path, startRow: n.range?.start.row };
}

function symbolRow(n: GraphNode): SymbolRow {
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    path: n.path,
    language: n.language,
    startRow: n.range?.start.row ?? 0,
    endRow: n.range?.end.row ?? 0,
    signature: n.signature,
    body: n.body,
    bodyTruncated: n.bodyTruncated,
  };
}
