/**
 * `GraphStore` over Neo4j.
 *
 * Every query here was lifted verbatim from the tool that used to own it.
 * The point of this file is that Neo4j mode behaves exactly as it did before
 * the store seam existed, so the rule for edits is: change the row mapping
 * freely, do not touch the Cypher without a reason that has nothing to do
 * with the local backend.
 */
import neo4j, { type Driver, type ManagedTransaction, type Session } from "neo4j-driver";
import { search as runSearch } from "../search";
import type { SearchHit } from "../search";
import type {
  BlastFile,
  CalleeRow,
  CallerRow,
  ClusterCoverage,
  CommunitySummary,
  CrossCommunityEdge,
  ExternalDepRow,
  FindSymbolsOptions,
  GlossaryRow,
  GraphStore,
  ImpactCallerRow,
  KindCount,
  LanguageCount,
  LayerCount,
  RepositoryMeta,
  RouteRow,
  SearchOptions,
  SpineFileRow,
  SymbolRow,
  TestFileRow,
  TopFunctionRow,
} from "./types";

export interface Neo4jStoreOptions {
  uri: string;
  user: string;
  password: string;
  database?: string;
}

type Row = Record<string, unknown>;

export class Neo4jStore implements GraphStore {
  readonly backend = "neo4j" as const;
  readonly supportsCypher = true;

  private readonly driver: Driver;
  private readonly database?: string;

  constructor(opts: Neo4jStoreOptions) {
    this.driver = neo4j.driver(opts.uri, neo4j.auth.basic(opts.user, opts.password));
    this.database = opts.database;
  }

  /** Fails fast with a readable error instead of at the first tool call. */
  async connect(uri: string): Promise<void> {
    try {
      await this.read("RETURN 1");
    } catch (err) {
      await this.driver.close();
      throw new Error(`Failed to connect to Neo4j at ${uri}: ${(err as Error).message}`);
    }
  }

  // ─── plumbing ─────────────────────────────────────────────────────────────

  private session(): Session {
    return this.driver.session(this.database ? { database: this.database } : {});
  }

  private async read(cypher: string, params: Row = {}): Promise<Row[]> {
    const session = this.session();
    try {
      const result = await session.executeRead((tx: ManagedTransaction) => tx.run(cypher, params));
      return result.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  private async write(cypher: string, params: Row = {}): Promise<Row[]> {
    const session = this.session();
    try {
      const result = await session.executeWrite((tx: ManagedTransaction) => tx.run(cypher, params));
      return result.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  // ─── overview / wiki aggregates ───────────────────────────────────────────

  async repositoryMeta(): Promise<RepositoryMeta | null> {
    const rows = await this.read(
      `MATCH (r:Repository)
       RETURN r.name AS name, r.path AS path,
              r.lastIndexed AS lastIndexed, r.lastCommit AS lastCommit,
              r.sourceUrl AS sourceUrl
       LIMIT 1`,
    );
    const r = rows[0];
    if (!r) return null;
    return {
      name: str(r.name) ?? "(unknown)",
      path: str(r.path) ?? "(unknown)",
      lastIndexed: str(r.lastIndexed),
      lastCommit: str(r.lastCommit),
      sourceUrl: str(r.sourceUrl),
    };
  }

  async countsByKind(): Promise<KindCount[]> {
    const rows = await this.read(
      `MATCH (n:CodeNode)
       WITH labels(n) AS labels, n
       UNWIND labels AS l
       WITH l, count(*) AS c WHERE l <> 'CodeNode'
       RETURN l AS kind, c AS count ORDER BY count DESC`,
    );
    return rows.map((r) => ({ kind: String(r.kind), count: num(r.count) ?? 0 }));
  }

  async languageCounts(): Promise<LanguageCount[]> {
    const rows = await this.read(
      `MATCH (f:File) WHERE f.language IS NOT NULL
       RETURN f.language AS language, count(*) AS count ORDER BY count DESC`,
    );
    return rows.map((r) => ({ language: String(r.language), count: num(r.count) ?? 0 }));
  }

  async layerCounts(): Promise<LayerCount[]> {
    const rows = await this.read(
      `MATCH (f:File) WHERE f.layer IS NOT NULL
       WITH f.layer AS layer,
            count(*) AS count,
            sum(CASE WHEN f.layerConfidence < 0.6 THEN 1 ELSE 0 END) AS lowConfidence
       RETURN layer, count, lowConfidence ORDER BY count DESC`,
    );
    return rows.map((r) => ({
      layer: String(r.layer),
      count: num(r.count) ?? 0,
      lowConfidence: num(r.lowConfidence) ?? 0,
    }));
  }

  async communities(opts: { limit?: number } = {}): Promise<CommunitySummary[]> {
    // Spine info is one collect so paths, hashes and blasts stay parallel.
    // The id tiebreak is the one deliberate query change in this file: the
    // original ordered by size alone, so which size-3 communities made a
    // top-12 list depended on storage order and differed run to run.
    const rows = await this.read(
      `MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)
       OPTIONAL MATCH (c)<-[:IN_COMMUNITY]-(spine:File {is_core: true})
       WITH c, count(DISTINCT f) AS size,
            collect(DISTINCT { path: spine.path, hash: spine.contentHash, blast: spine.blastScore }) AS spineInfo,
            collect(DISTINCT f.path)[..3] AS samplePaths
       WITH c, size, samplePaths,
            [x IN spineInfo WHERE x.path IS NOT NULL] AS spine
       RETURN c.communityId AS id,
              c.label AS label,
              c.heuristicLabel AS heuristicLabel,
              c.description AS description,
              c.descriptionWrittenAt AS descriptionWrittenAt,
              c.descriptionSpineSnapshot AS descriptionSpineSnapshot,
              c.descriptionSpineHashes AS descriptionSpineHashes,
              size, spine, samplePaths
       ORDER BY size DESC, c.communityId ASC
       ${opts.limit ? "LIMIT $limit" : ""}`,
      opts.limit ? { limit: neo4j.int(opts.limit) } : {},
    );
    return rows.map((r) => ({
      id: num(r.id) ?? 0,
      label: str(r.label),
      heuristicLabel: str(r.heuristicLabel),
      description: str(r.description),
      descriptionWrittenAt: str(r.descriptionWrittenAt),
      descriptionSpineSnapshot: strArr(r.descriptionSpineSnapshot),
      descriptionSpineHashes: strArr(r.descriptionSpineHashes),
      size: num(r.size) ?? 0,
      spine: (Array.isArray(r.spine) ? (r.spine as Row[]) : []).map((s) => ({
        path: String(s.path),
        hash: str(s.hash) ?? "",
        blast: num(s.blast) ?? null,
      })),
      samplePaths: strArr(r.samplePaths),
    }));
  }

  async topBlastFiles(limit: number): Promise<BlastFile[]> {
    const rows = await this.read(
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
       LIMIT $limit`,
      { limit: neo4j.int(limit) },
    );
    return rows.map((r) => ({
      path: String(r.path ?? ""),
      blast: num(r.blast) ?? 0,
      direct: num(r.direct) ?? 0,
      transitive: num(r.transitive) ?? 0,
      isSpine: Boolean(r.isSpine),
      community: str(r.community) ?? "(no community)",
    }));
  }

  // ─── symbols and traversals ───────────────────────────────────────────────

  async findSymbols(opts: FindSymbolsOptions): Promise<SymbolRow[]> {
    const where: string[] = ["n.name = $name"];
    const params: Row = { name: opts.name };
    if (opts.pathContains) {
      where.push("n.path CONTAINS $file");
      params.file = opts.pathContains;
    }
    if (opts.kinds?.length) {
      where.push("(" + opts.kinds.map((k) => `n:\`${k}\``).join(" OR ") + ")");
    }
    const limit = neo4j.int(opts.limit ?? 20);

    if (!opts.withFileFacts) {
      const rows = await this.read(
        `MATCH (n:CodeNode)
         WHERE ${where.join(" AND ")}
         RETURN n
         ORDER BY n.path, n.startRow
         LIMIT $limit`,
        { ...params, limit },
      );
      return rows.map((r) => symbolFromNode(r.n as Neo4jNode));
    }

    const rows = await this.read(
      `MATCH (n:CodeNode)
       WHERE ${where.join(" AND ")}
       OPTIONAL MATCH (n)<-[:DEFINES]-(targetFile:File)
       OPTIONAL MATCH (targetFile)-[:IN_COMMUNITY]->(targetComm:Community)
       RETURN n, targetFile, targetComm
       ORDER BY n.path, n.startRow
       LIMIT $limit`,
      { ...params, limit },
    );
    return rows.map((r) => {
      const sym = symbolFromNode(r.n as Neo4jNode);
      const file = r.targetFile as Neo4jNode | null;
      const comm = r.targetComm as Neo4jNode | null;
      sym.file = file
        ? {
            path: String(file.properties.path ?? ""),
            isCore: Boolean(file.properties.is_core),
            pagerank: num(file.properties.pagerank) ?? 0,
            boundary: num(file.properties.boundary) ?? 0,
            blastScore: num(file.properties.blastScore),
            blastDirect: num(file.properties.blastDirect),
            blastTransitive: num(file.properties.blastTransitive),
            isTest: Boolean(file.properties.isTest),
            communityId: comm ? num(comm.properties.communityId) : undefined,
            communityLabel: comm ? str(comm.properties.label) : undefined,
          }
        : null;
      return sym;
    });
  }

  async callers(symbol: string, depth: number, limit: number): Promise<CallerRow[]> {
    const rows = await this.read(
      `MATCH (caller:CodeNode)-[r:CALLS*1..${depth}]->(target)
       WHERE target.name = $symbol OR target.symbol = $symbol
       WITH caller, size(r) AS distance, target
       RETURN DISTINCT caller, distance, target.name AS targetName, target.path AS targetPath
       ORDER BY distance, caller.path
       LIMIT $lim`,
      { symbol, lim: neo4j.int(limit) },
    );
    return rows.map((r) => ({
      caller: refFromNode(r.caller as Neo4jNode),
      distance: num(r.distance) ?? 0,
      targetName: String(r.targetName ?? symbol),
      targetPath: str(r.targetPath) ?? undefined,
    }));
  }

  async callees(
    symbol: string,
    opts: { pathContains?: string; depth: number; limit: number },
  ): Promise<CalleeRow[]> {
    const fileFilter = opts.pathContains ? "AND src.path CONTAINS $file" : "";
    const params: Row = { symbol, lim: neo4j.int(opts.limit) };
    if (opts.pathContains) params.file = opts.pathContains;
    const rows = await this.read(
      `MATCH (src:CodeNode { name: $symbol })
       WHERE src:Function OR src:Method ${fileFilter}
       WITH src LIMIT 5
       MATCH (src)-[r:CALLS*1..${opts.depth}]->(target)
       WITH DISTINCT target, size(r) AS distance
       RETURN target, distance
       ORDER BY distance, target.name
       LIMIT $lim`,
      params,
    );
    return rows.map((r) => ({
      target: refFromNode(r.target as Neo4jNode),
      distance: num(r.distance) ?? 0,
    }));
  }

  async impactCallers(
    target: { name: string; path: string },
    depth: number,
    relations: readonly string[],
  ): Promise<ImpactCallerRow[]> {
    const rows = await this.read(
      `MATCH (target:CodeNode { name: $symbol })
       WHERE (target:Function OR target:Method OR target:Class OR target:Variable)
         AND target.path = $targetPath
       WITH target LIMIT 1
       MATCH p=(caller)-[:${relations.join("|")}*1..${depth}]->(target)
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
      { symbol: target.name, targetPath: target.path },
    );
    return rows.map((r) => ({
      name: String(r.name ?? "(anonymous)"),
      path: String(r.path ?? ""),
      startRow: num(r.startRow) ?? 0,
      distance: num(r.distance) ?? 0,
      sources: strArr(r.sources),
      rels: strArr(r.rels),
      callerIsCore: Boolean(r.callerIsCore),
      callerPagerank: num(r.callerPagerank) ?? 0,
      callerIsTest: Boolean(r.callerIsTest),
      callerCommunityId: num(r.callerCommId),
      callerCommunityLabel: str(r.callerCommLabel),
    }));
  }

  // ─── wiki ─────────────────────────────────────────────────────────────────

  async spineFiles(): Promise<SpineFileRow[]> {
    const rows = await this.read(
      `MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)
       WHERE f.is_core = true
       WITH c.communityId AS cid, f
       ORDER BY f.pagerank DESC
       RETURN cid, f.path AS path, f.name AS name, f.pagerank AS pagerank`,
    );
    return rows.map((r) => ({
      cid: num(r.cid) ?? 0,
      path: String(r.path),
      name: String(r.name),
      pagerank: num(r.pagerank) ?? 0,
    }));
  }

  async topFunctionsByCommunity(): Promise<TopFunctionRow[]> {
    const rows = await this.read(
      `MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)-[:DEFINES]->(fn:Function)
       OPTIONAL MATCH (fn)<-[r:CALLS]-(:CodeNode)
       WITH c.communityId AS cid, fn, count(r) AS callCount
       WHERE callCount > 0
       RETURN cid, fn.name AS name, fn.signature AS signature,
              fn.path AS path, fn.startRow AS startRow, callCount
       ORDER BY callCount DESC`,
    );
    return rows.map((r) => ({
      cid: num(r.cid) ?? 0,
      name: String(r.name ?? "(anonymous)"),
      signature: str(r.signature),
      path: String(r.path ?? ""),
      startRow: num(r.startRow) ?? 0,
      callCount: num(r.callCount) ?? 0,
    }));
  }

  async crossCommunityImports(): Promise<CrossCommunityEdge[]> {
    const rows = await this.read(
      `MATCH (c1:Community)<-[:IN_COMMUNITY]-(:File)-[:IMPORTS]->(:File)-[:IN_COMMUNITY]->(c2:Community)
       WHERE c1 <> c2
       RETURN c1.communityId AS fromId, c1.label AS fromLabel,
              c1.heuristicLabel AS fromHeuristic,
              c2.communityId AS toId, c2.label AS toLabel,
              c2.heuristicLabel AS toHeuristic,
              count(*) AS count`,
    );
    return rows.map((r) => ({
      fromId: num(r.fromId) ?? 0,
      fromLabel: str(r.fromLabel),
      fromHeuristic: str(r.fromHeuristic),
      toId: num(r.toId) ?? 0,
      toLabel: str(r.toLabel),
      toHeuristic: str(r.toHeuristic),
      count: num(r.count) ?? 0,
    }));
  }

  async routes(): Promise<RouteRow[]> {
    const rows = await this.read(
      `MATCH (n:Function) WHERE n.httpMethod IS NOT NULL
       RETURN n.httpMethod AS method, n.route AS route,
              n.path AS path, n.startRow AS startRow
       ORDER BY n.path, n.startRow`,
    );
    return rows.map((r) => ({
      method: String(r.method),
      route: String(r.route ?? ""),
      path: String(r.path ?? ""),
      startRow: num(r.startRow) ?? 0,
    }));
  }

  async entryPoints(): Promise<string[]> {
    const rows = await this.read(
      `MATCH (f:File) WHERE NOT (f)<-[:IMPORTS]-()
       RETURN f.path AS path ORDER BY f.path`,
    );
    return rows.map((r) => String(r.path));
  }

  async testFiles(): Promise<TestFileRow[]> {
    const rows = await this.read(
      `MATCH (f:File) WHERE f.isTest = true
       RETURN f.path AS path, f.testFramework AS framework
       ORDER BY f.path`,
    );
    return rows.map((r) => ({ path: String(r.path), framework: str(r.framework) }));
  }

  async glossary(limit: number): Promise<GlossaryRow[]> {
    const rows = await this.read(
      `MATCH (target)<-[r:CALLS]-(:CodeNode)
       WHERE (target:Function OR target:Method) AND target.name IS NOT NULL
       WITH target, count(r) AS callCount
       ORDER BY callCount DESC LIMIT $limit
       RETURN target.name AS name, target.signature AS signature,
              target.path AS path, target.startRow AS startRow, callCount`,
      { limit: neo4j.int(limit) },
    );
    return rows.map((r) => ({
      name: String(r.name),
      signature: str(r.signature),
      path: String(r.path ?? ""),
      startRow: num(r.startRow) ?? 0,
      callCount: num(r.callCount) ?? 0,
    }));
  }

  async externalDepsByCommunity(): Promise<ExternalDepRow[]> {
    const rows = await this.read(
      `MATCH (c:Community)<-[:IN_COMMUNITY]-(:File)-[:IMPORTS]->(u:Unresolved)
       WHERE u.symbol IS NOT NULL
         AND NOT u.symbol STARTS WITH 'java.'
         AND NOT u.symbol STARTS WITH 'javax.'
       WITH c.communityId AS cid, u.symbol AS spec, count(*) AS uses
       RETURN cid, spec, uses
       ORDER BY cid, uses DESC`,
    );
    return rows.map((r) => ({
      cid: num(r.cid) ?? 0,
      spec: String(r.spec),
      uses: num(r.uses) ?? 0,
    }));
  }

  async clusterCoverage(): Promise<ClusterCoverage> {
    const rows = await this.read(
      `MATCH (f:File)
       OPTIONAL MATCH (f)-[ic:IN_COMMUNITY]->(:Community)
       WITH count(f) AS total, count(ic) AS clustered,
            collect(CASE WHEN ic IS NULL THEN f.path END) AS rawOrphans
       RETURN total, clustered,
              [p IN rawOrphans WHERE p IS NOT NULL] AS orphans`,
    );
    const r = rows[0] ?? {};
    return {
      total: num(r.total) ?? 0,
      clustered: num(r.clustered) ?? 0,
      orphans: strArr(r.orphans),
    };
  }

  // ─── writes ───────────────────────────────────────────────────────────────

  async setCommunityLabel(
    communityId: number,
    update: { label: string; description?: string; writtenAt: string },
  ): Promise<boolean> {
    const params: Row = {
      cid: neo4j.int(communityId),
      label: update.label,
      now: update.writtenAt,
    };
    let cypher = `MATCH (c:Community { communityId: $cid })
      SET c.label = $label, c.labelWrittenAt = $now`;
    if (update.description) {
      cypher += `, c.description = $description, c.descriptionWrittenAt = $now`;
      params.description = update.description;
      // Snapshot the current spine as two parallel arrays (paths, hashes) so
      // the read side can tell "spine changed" from "spine content changed".
      cypher += `
        WITH c
        OPTIONAL MATCH (c)<-[:IN_COMMUNITY]-(spine:File {is_core: true})
        WITH c, collect(DISTINCT { path: spine.path, hash: spine.contentHash }) AS info
        WITH c,
             [x IN info WHERE x.path IS NOT NULL | x.path] AS paths,
             [x IN info WHERE x.path IS NOT NULL | coalesce(x.hash, '')] AS hashes
        SET c.descriptionSpineSnapshot = paths,
            c.descriptionSpineHashes  = hashes`;
    }
    cypher += ` RETURN c.communityId AS id, c.label AS label`;
    const rows = await this.write(cypher, params);
    return rows.length > 0;
  }

  // ─── search / escape hatch ────────────────────────────────────────────────

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    return runSearch(this.driver, query, { ...opts, database: this.database });
  }

  async cypher(query: string): Promise<Record<string, unknown>[]> {
    const rows = await this.read(query);
    return rows.map((r) => unwrap(r) as Record<string, unknown>);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

// ─── row helpers ────────────────────────────────────────────────────────────

interface Neo4jNode {
  labels: string[];
  properties: Record<string, unknown>;
}

function symbolFromNode(n: Neo4jNode): SymbolRow {
  const p = n.properties;
  return {
    id: String(p.id ?? ""),
    kind: nodeKind(n.labels),
    name: String(p.name ?? ""),
    path: str(p.path) ?? undefined,
    language: str(p.language) ?? undefined,
    startRow: num(p.startRow) ?? 0,
    endRow: num(p.endRow) ?? 0,
    signature: str(p.signature) ?? undefined,
    body: str(p.body) ?? undefined,
    bodyTruncated: p.bodyTruncated ? true : undefined,
  };
}

function refFromNode(n: Neo4jNode): { id: string; kind: string; name: string; path?: string; startRow?: number } {
  const p = n.properties;
  return {
    id: String(p.id ?? ""),
    kind: nodeKind(n.labels),
    // Unresolved placeholders carry `symbol`, not `name`.
    name: String(p.name ?? p.symbol ?? "(unknown)"),
    path: str(p.path) ?? undefined,
    startRow: num(p.startRow),
  };
}

/** The kind label, skipping the `:CodeNode` base label. */
export function nodeKind(labels: string[]): string {
  return labels.find((l) => l !== "CodeNode") ?? "Unknown";
}

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map(String) : [];
}

/** Neo4j `Integer` (Int64) or plain numeric value to a JS number. */
function num(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  if (typeof v === "object" && "toNumber" in (v as object)) {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

/** Recursively convert Neo4j Integers, Nodes and Relationships to plain data. */
export function unwrap(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  if ("low" in v && "high" in v && "toNumber" in v) {
    return (v as { toNumber: () => number }).toNumber();
  }
  if ("identity" in v && "labels" in v && "properties" in v) {
    return {
      labels: (v as { labels: string[] }).labels,
      properties: unwrap((v as { properties: unknown }).properties),
    };
  }
  if ("type" in v && "start" in v && "end" in v && "properties" in v) {
    return {
      type: (v as { type: string }).type,
      properties: unwrap((v as { properties: unknown }).properties),
    };
  }
  if (Array.isArray(v)) return v.map(unwrap);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k] = unwrap(val);
  return out;
}
