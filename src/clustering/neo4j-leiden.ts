import neo4j, { Driver, ManagedTransaction, Session } from "neo4j-driver";
import {
  computeFileMetrics,
  FileVertex,
  ImportEdge,
} from "./graph-metrics";

/** Property writes per statement — keeps the parameter payload bounded. */
const WRITE_BATCH = 1000;

export interface ClusterOptions {
  uri: string;
  user: string;
  password: string;
  database?: string;
  /** Per-community top-K by PageRank — get tagged is_core. Default 5. */
  spinePagerank?: number;
  /** Per-community top-K by boundary degree — also tagged is_core. Default 3. */
  spineBoundary?: number;
  /** Materialize :Community nodes only for groups with size >= this. Default 3. */
  minSize?: number;
  /** Wipe community props + :Community nodes before running. */
  clear?: boolean;
}

export interface ClusterReport {
  communities: number;
  materialized: number;
  spineNodes: number;
  filesScored: number;
  /** Newman modularity of the partition — log it to catch quality regressions. */
  modularity: number;
}

/**
 * Clusters the File-IMPORTS subgraph and writes the results back to Neo4j.
 *
 * Sequence: optional clear → read the File-IMPORTS subgraph → compute
 * communities, PageRank, boundary degree, blast radius and spine locally →
 * write properties back → materialize :Community nodes with heuristic labels.
 *
 * **No longer requires the Graph Data Science plugin.** The analytics moved
 * in-process (see `graph-metrics.ts`): the clustered graph is the File graph,
 * a few thousand nodes even on a large monorepo, and requiring a Docker
 * plugin plus a `gds.*` security allowlist to compute it was by far the
 * heaviest part of getting `get_overview` to produce anything.
 *
 * Community detection is Louvain rather than GDS's Leiden. Leiden's advantage
 * is avoiding internally-disconnected communities; at this graph size the
 * partitions are close, and `modularity` is returned so the quality is
 * observable rather than assumed.
 */
export async function clusterInNeo4j(
  opts: ClusterOptions,
): Promise<ClusterReport> {
  const driver: Driver = neo4j.driver(
    opts.uri,
    neo4j.auth.basic(opts.user, opts.password),
  );
  const sessionConfig = opts.database ? { database: opts.database } : {};
  const spinePagerank = opts.spinePagerank ?? 5;
  const spineBoundary = opts.spineBoundary ?? 3;
  const minSize = opts.minSize ?? 3;

  const run = async (
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    const session = driver.session(sessionConfig);
    try {
      const result = await session.executeWrite((tx: ManagedTransaction) =>
        tx.run(cypher, params),
      );
      return result.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  };

  const runRead = async (
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> => {
    const session: Session = driver.session(sessionConfig);
    try {
      const result = await session.executeRead((tx: ManagedTransaction) =>
        tx.run(cypher, params),
      );
      return result.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  };

  try {
    // 1. Optional clear.
    if (opts.clear) {
      await run(`MATCH (c:Community) DETACH DELETE c`);
      await run(
        `MATCH (f:File) REMOVE f.community, f.pagerank, f.boundary, f.is_core,
                                 f.blastDirect, f.blastTransitive, f.blastScore`,
      );
    }

    // 2. Read the File-IMPORTS subgraph out of the store. This is the graph
    //    GDS used to project; it is the File graph, not the symbol graph, so
    //    it is small — a few thousand nodes even on a large monorepo.
    const fileRows = await runRead(`MATCH (f:File) RETURN f.path AS id`);
    const edgeRows = await runRead(
      `MATCH (a:File)-[:IMPORTS]->(b:File)
       RETURN a.path AS from, b.path AS to`,
    );
    const files: FileVertex[] = fileRows
      .map((r) => ({ id: String(r.id ?? "") }))
      .filter((f) => f.id !== "");
    const importEdges: ImportEdge[] = edgeRows
      .map((r) => ({ from: String(r.from ?? ""), to: String(r.to ?? "") }))
      .filter((e) => e.from !== "" && e.to !== "");

    // 3. Community detection, PageRank, boundary degree, blast radius and
    //    spine selection — all in process. Previously eight `gds.*` calls,
    //    which is why the tool needed the GDS plugin installed and
    //    security-allowlisted before it produced anything.
    const metrics = computeFileMetrics(files, importEdges, {
      spinePagerank,
      spineBoundary,
    });

    // 4. Write the computed properties back in one batched statement.
    const payload = [...metrics.byFile.entries()].map(([id, m]) => ({
      path: id,
      community: neo4j.int(m.community),
      pagerank: m.pagerank,
      boundary: neo4j.int(m.boundary),
      blastDirect: neo4j.int(m.blastDirect),
      blastTransitive: neo4j.int(m.blastTransitive),
      blastScore: m.blastScore,
      isCore: m.isCore,
    }));
    for (let i = 0; i < payload.length; i += WRITE_BATCH) {
      await run(
        `UNWIND $rows AS row
         MATCH (f:File { path: row.path })
         SET f.community = row.community,
             f.pagerank = row.pagerank,
             f.boundary = row.boundary,
             f.blastDirect = row.blastDirect,
             f.blastTransitive = row.blastTransitive,
             f.blastScore = row.blastScore,
             f.is_core = row.isCore`,
        { rows: payload.slice(i, i + WRITE_BATCH) },
      );
    }

    // 8a. Drop all :Community nodes from prior runs — Leiden assigns fresh
    //     community IDs on each unseeded run, so old :Community nodes would
    //     accumulate (and old labels would attach to the wrong files).
    //     Cheap to drop + re-materialize in step 8 since size/heuristicLabel
    //     are recomputed there. Existing labels/descriptions DO get wiped
    //     here — that's the trade-off the rolled-back seedProperty was
    //     trying to avoid; label stability handled separately by item #1'.
    await run(`MATCH (c:Community) DETACH DELETE c`);

    // 8. Materialize :Community nodes for groups with size >= minSize.
    await run(
      `MATCH (f:File) WHERE f.community IS NOT NULL
       WITH f.community AS cid, collect(f) AS members, count(*) AS size
       WHERE size >= $minSize
       MERGE (c:Community:CodeNode { id: 'community:' + toString(cid) })
         ON CREATE SET c.communityId = cid, c.size = size,
                       c.name = 'community-' + toString(cid),
                       c.kind = 'Community'
         ON MATCH  SET c.size = size, c.kind = 'Community'
       WITH c, members
       UNWIND members AS f
       MERGE (f)-[:IN_COMMUNITY]->(c)`,
      { minSize: neo4j.int(minSize) },
    );

    // 8b. Heuristic label per community — most-common informative folder
    //     segment among member file paths, scoped to the path WITHIN the
    //     repo (otherwise the user's home folder dominates every label).
    //     Used as a fallback when no semantic label has been set via the
    //     `label_community` MCP tool. Always recomputed so it tracks
    //     current files. Example: /Users/x/repo/libs/auth/login.ts →
    //     stripped to "libs/auth/login.ts" → label "auth" (libs is
    //     in the stop-list, ".ts" segment is filtered out).
    await run(
      `MATCH (r:Repository) WITH r.path AS repoPath LIMIT 1
       MATCH (c:Community)<-[:IN_COMMUNITY]-(f:File)
       WITH c, repoPath,
            CASE WHEN f.path STARTS WITH repoPath
                 THEN substring(f.path, size(repoPath))
                 ELSE f.path END AS relPath
       WITH c, split(relPath, '/') AS segs
       UNWIND segs AS seg
       WITH c, seg
       WHERE seg <> ''
         AND NOT seg CONTAINS '.'
         AND size(seg) > 1
         AND NOT seg IN [
           'src', 'lib', 'libs', 'dist', 'build', 'out', 'bin',
           'app', 'pkg', 'packages', 'node_modules', 'vendor', 'target',
           'index', 'main',
           'tests', 'test', '__tests__', 'spec', '__mocks__', 'mocks',
           'common', 'shared', 'public', 'private', 'internal'
         ]
       WITH c, seg, count(*) AS n
       ORDER BY n DESC
       WITH c, collect(seg)[0] AS heuristic
       WHERE heuristic IS NOT NULL
       SET c.heuristicLabel = heuristic`,
    );

    // 9. Build report.
    const [counts] = await runRead(
      `MATCH (f:File) WHERE f.community IS NOT NULL
       WITH count(f) AS filesScored, collect(DISTINCT f.community) AS comms
       OPTIONAL MATCH (c:Community)
       WITH filesScored, size(comms) AS communities, count(c) AS materialized
       OPTIONAL MATCH (s:File {is_core: true})
       RETURN filesScored, communities, materialized, count(s) AS spineNodes`,
    );

    const num = (k: string): number => {
      const v = counts[k];
      if (v && typeof v === "object" && "toNumber" in v) {
        return (v as { toNumber: () => number }).toNumber();
      }
      return Number(v ?? 0);
    };

    return {
      communities: num("communities"),
      materialized: num("materialized"),
      spineNodes: num("spineNodes"),
      filesScored: num("filesScored"),
      modularity: metrics.modularity,
    };
  } finally {
    await driver.close();
  }
}
