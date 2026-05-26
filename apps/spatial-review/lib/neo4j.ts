/**
 * Thin Neo4j read client. Reads the same DB that `codelens index` writes to.
 * Server-side only.
 *
 * Driver is module-scoped so we reuse the connection pool across API
 * invocations (Next.js dev mode hot-reloads can leak drivers — we accept the
 * leak in dev because killing the driver on every reload would tank perf).
 */
import neo4j, { Driver, Session } from "neo4j-driver";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (driver) return driver;
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error(
      "Neo4j connection not configured. Set NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD in .env.local.",
    );
  }
  driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  return driver;
}

function session(): Session {
  const database = process.env.NEO4J_DATABASE;
  return database ? getDriver().session({ database }) : getDriver().session();
}

export interface IndexedRepo {
  /** Local filesystem path the analyzer was run against. */
  path: string;
  /** Repo name (folder basename, usually matches GitHub repo name). */
  name: string;
  /** Source URL if known (set during indexing if --source-url passed). */
  sourceUrl: string | null;
  /** Last commit indexed. */
  lastCommit: string | null;
  /** ISO timestamp of last index run. */
  lastIndexed: string | null;
  /** Approximate file count. */
  fileCount: number;
  /** Approximate community count. */
  communityCount: number;
}

/**
 * Returns all repos currently indexed in Neo4j. For the prototype we read
 * Repository nodes directly; on Day 2 we'll cross-reference with GitHub repos
 * the user owns (matching by sourceUrl or path basename).
 */
export async function listIndexedRepos(): Promise<IndexedRepo[]> {
  const s = session();
  try {
    const res = await s.executeRead((tx) =>
      tx.run(
        `MATCH (r:Repository)
         OPTIONAL MATCH (r)-[:CONTAINS*]->(f:File)
         WITH r, count(DISTINCT f) AS fileCount
         OPTIONAL MATCH (c:Community)
         RETURN r.path AS path, r.name AS name,
                r.sourceUrl AS sourceUrl,
                r.lastCommit AS lastCommit,
                r.lastIndexed AS lastIndexed,
                fileCount,
                count(DISTINCT c) AS communityCount
         ORDER BY coalesce(r.lastIndexed, '') DESC`,
      ),
    );
    return res.records.map((rec) => ({
      path: String(rec.get("path") ?? ""),
      name: String(rec.get("name") ?? ""),
      sourceUrl: (rec.get("sourceUrl") as string | null) ?? null,
      lastCommit: (rec.get("lastCommit") as string | null) ?? null,
      lastIndexed: (rec.get("lastIndexed") as string | null) ?? null,
      fileCount: toInt(rec.get("fileCount")),
      communityCount: toInt(rec.get("communityCount")),
    }));
  } finally {
    await s.close();
  }
}

function toInt(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "toNumber" in v) {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}

function toFloat(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "toNumber" in v) {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export interface PrFileNode {
  /** Path key the caller used to match (typically the PR's filename). */
  matchedPath: string;
  /** Absolute path stored in Neo4j (full repo path). */
  absolutePath: string;
  blastScore: number;
  blastDirect: number;
  blastTransitive: number;
  isSpine: boolean;
  communityId: number | null;
  communityLabel: string | null;
  communityHeuristicLabel: string | null;
}

export interface PrSubgraph {
  /** File nodes from Neo4j that matched the PR's changed files. */
  nodes: PrFileNode[];
  /** IMPORTS edges scoped to within `nodes`. Strings are matchedPath keys. */
  edges: Array<{ from: string; to: string }>;
  /** Paths in the PR that had no matching File node in Neo4j (new files etc.) */
  unmatched: string[];
}

/**
 * Resolves PR-changed file paths to their File nodes + the IMPORTS edges
 * scoped to within that set. Used by the reading-path BFS.
 *
 * Matching strategy: the PR's `filename` is repo-relative (e.g.
 * `libs/langchain-core/src/messages/ai.ts`). Neo4j stores absolute paths
 * (e.g. `/Users/.../langchainjs/libs/langchain-core/src/messages/ai.ts`).
 * We match by `f.path ENDS WITH '/' + filename` — handles any monorepo
 * root location without us caring about it.
 */
export async function getPrSubgraph(
  repoFilenames: string[],
): Promise<PrSubgraph> {
  if (repoFilenames.length === 0) {
    return { nodes: [], edges: [], unmatched: [] };
  }

  // The same physical file may match more than one filename if the user
  // has multiple repos indexed with overlapping paths. We take the longest
  // matching absolute path per filename to disambiguate (most-specific wins).
  const s = session();
  try {
    const res = await s.executeRead((tx) =>
      tx.run(
        `WITH $filenames AS filenames
         UNWIND filenames AS fn
         OPTIONAL MATCH (f:File)
         WHERE f.path = fn OR f.path ENDS WITH ('/' + fn)
         WITH fn, f
         ORDER BY size(coalesce(f.path, '')) DESC
         WITH fn, head(collect(f)) AS f
         OPTIONAL MATCH (f)-[:IN_COMMUNITY]->(c:Community)
         RETURN fn AS matchedPath,
                f.path AS absolutePath,
                f.blastScore AS blastScore,
                f.blastDirect AS blastDirect,
                f.blastTransitive AS blastTransitive,
                f.is_core AS isSpine,
                c.communityId AS communityId,
                c.label AS communityLabel,
                c.heuristicLabel AS communityHeuristicLabel`,
        { filenames: repoFilenames },
      ),
    );

    const nodes: PrFileNode[] = [];
    const unmatched: string[] = [];
    const absToMatched = new Map<string, string>(); // absolutePath → matchedPath
    for (const rec of res.records) {
      const matchedPath = String(rec.get("matchedPath"));
      const absolutePath = rec.get("absolutePath") as string | null;
      if (!absolutePath) {
        unmatched.push(matchedPath);
        continue;
      }
      absToMatched.set(absolutePath, matchedPath);
      nodes.push({
        matchedPath,
        absolutePath,
        blastScore: toFloat(rec.get("blastScore")),
        blastDirect: toInt(rec.get("blastDirect")),
        blastTransitive: toInt(rec.get("blastTransitive")),
        isSpine: Boolean(rec.get("isSpine")),
        communityId: rec.get("communityId") == null
          ? null
          : toInt(rec.get("communityId")),
        communityLabel: (rec.get("communityLabel") as string | null) ?? null,
        communityHeuristicLabel:
          (rec.get("communityHeuristicLabel") as string | null) ?? null,
      });
    }

    // Edges: IMPORTS where both endpoints are in our matched set.
    if (nodes.length === 0) {
      return { nodes, edges: [], unmatched };
    }
    const absPaths = nodes.map((n) => n.absolutePath);
    const edgeRes = await s.executeRead((tx) =>
      tx.run(
        `MATCH (a:File)-[:IMPORTS]->(b:File)
         WHERE a.path IN $paths AND b.path IN $paths
         RETURN a.path AS from, b.path AS to`,
        { paths: absPaths },
      ),
    );
    const edges: Array<{ from: string; to: string }> = [];
    for (const rec of edgeRes.records) {
      const fromAbs = String(rec.get("from"));
      const toAbs = String(rec.get("to"));
      const fromMatched = absToMatched.get(fromAbs);
      const toMatched = absToMatched.get(toAbs);
      if (fromMatched && toMatched) {
        edges.push({ from: fromMatched, to: toMatched });
      }
    }

    return { nodes, edges, unmatched };
  } finally {
    await s.close();
  }
}
