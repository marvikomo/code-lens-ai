import neo4j, { Driver, ManagedTransaction, Session } from "neo4j-driver";

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
  /** GDS in-memory projection name. Default "ast-cluster". */
  projectionName?: string;
  /** Wipe community props + :Community nodes before running. */
  clear?: boolean;
}

export interface ClusterReport {
  communities: number;
  materialized: number;
  spineNodes: number;
  filesScored: number;
}

/**
 * Runs Leiden community detection on the File-IMPORTS subgraph already in Neo4j.
 *
 * Sequence: preflight → optional clear → drop stale projection → project →
 * Leiden → PageRank → boundary degree → per-community spine tagging →
 * materialize :Community nodes → drop projection (finally).
 *
 * Requires the Neo4j Graph Data Science plugin (gds.*). Throws with a
 * helpful message if it's missing.
 */
export async function clusterInNeo4j(
  opts: ClusterOptions,
): Promise<ClusterReport> {
  const driver: Driver = neo4j.driver(
    opts.uri,
    neo4j.auth.basic(opts.user, opts.password),
  );
  const sessionConfig = opts.database ? { database: opts.database } : {};
  const name = opts.projectionName ?? "ast-cluster";
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
    // 0. Preflight — confirm GDS is installed.
    try {
      await runRead(`RETURN gds.version() AS v`);
    } catch (err) {
      throw new Error(
        `GDS plugin not installed or not allowlisted. Edit docker-compose.yml to add "graph-data-science" to NEO4J_PLUGINS and "gds.*" to NEO4J_dbms_security_procedures_unrestricted, then 'docker compose down && docker compose up -d'. Underlying error: ${(err as Error).message}`,
      );
    }

    // 1. Optional clear.
    if (opts.clear) {
      await run(`MATCH (c:Community) DETACH DELETE c`);
      await run(
        `MATCH (f:File) REMOVE f.community, f.pagerank, f.boundary, f.is_core`,
      );
    }

    // 2. Drop stale projection from a previous crashed run.
    await run(
      `CALL gds.graph.exists($name) YIELD exists
       WITH exists WHERE exists
       CALL gds.graph.drop($name) YIELD graphName RETURN graphName`,
      { name },
    );

    // 3. Native projection — :File nodes + :IMPORTS edges, undirected.
    // :IMPORTS → :Unresolved is auto-skipped (Unresolved isn't in the node set).
    //
    // Note (2026-05): we tried using gds.leiden.write's `seedProperty` to
    // preserve community IDs across re-runs (per the architecture-recovery
    // literature). GDS's implementation produced runaway over-merging
    // (back-to-back runs collapsed 99% of files into one community), and
    // placeholder seed values leaked into the output. Reverted; ID stability
    // will be handled via post-clustering Jaccard label migration instead.
    await run(
      `CALL gds.graph.project($name, 'File',
         { IMPORTS: { orientation: 'UNDIRECTED' } })`,
      { name },
    );

    // 4. Leiden — deterministic for identical input via randomSeed.
    await run(
      `CALL gds.leiden.write($name, {
         writeProperty: 'community',
         concurrency: 4,
         randomSeed: 42
       }) YIELD communityCount, modularity`,
      { name },
    );

    // 5. PageRank.
    await run(
      `CALL gds.pageRank.write($name, { writeProperty: 'pagerank' })
       YIELD nodePropertiesWritten`,
      { name },
    );

    // 6. Boundary degree — count distinct neighbors in *other* communities.
    await run(
      `MATCH (f:File)
       OPTIONAL MATCH (f)-[r:IMPORTS]-(other:File)
       WHERE other.community <> f.community
       WITH f, count(DISTINCT other) AS boundary
       SET f.boundary = boundary`,
    );

    // 7. Per-community spine — top-K PageRank, then top-M boundary (additive).
    await run(
      `MATCH (f:File) WHERE f.community IS NOT NULL
       WITH f.community AS c, f ORDER BY f.pagerank DESC
       WITH c, collect(f)[0..$k] AS top
       UNWIND top AS f SET f.is_core = true`,
      { k: neo4j.int(spinePagerank) },
    );
    await run(
      `MATCH (f:File) WHERE f.community IS NOT NULL AND f.boundary > 0
       WITH f.community AS c, f ORDER BY f.boundary DESC
       WITH c, collect(f)[0..$k] AS top
       UNWIND top AS f SET f.is_core = true`,
      { k: neo4j.int(spineBoundary) },
    );

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
    };
  } finally {
    // Cleanup — drop the projection if it still exists.
    try {
      await run(
        `CALL gds.graph.drop($name, false) YIELD graphName RETURN graphName`,
        { name },
      );
    } catch {
      // ignore — projection may never have been created
    }
    await driver.close();
  }
}
