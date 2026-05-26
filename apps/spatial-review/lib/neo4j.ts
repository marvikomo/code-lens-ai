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
