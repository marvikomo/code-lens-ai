import neo4j, { Driver, ManagedTransaction } from "neo4j-driver";
import { embedBatch, EMBEDDING_DIMS } from "./local";

export interface EmbedOptions {
  uri: string;
  user: string;
  password: string;
  database?: string;
  /** Embed only nodes of these kinds. Default: Function, Method, Class. */
  kinds?: string[];
  /** Skip nodes that already have an embedding. Default true. */
  skipExisting?: boolean;
  /** Batch size for the embedding model. Default 32. */
  batchSize?: number;
  /** Max chars from body to feed the model. Default 1500. */
  maxBodyChars?: number;
  /** Override default model (jinaai/jina-embeddings-v2-base-code). */
  model?: string;
}

export interface EmbedReport {
  totalCandidates: number;
  embedded: number;
  skipped: number;
  durationMs: number;
}

/**
 * Walks the graph, embeds nodes whose `body` is set, writes the vector to
 * Neo4j as the `embedding` property. Idempotent — re-running skips nodes
 * that already have an embedding (toggle with `skipExisting: false`).
 *
 * Also creates the vector index on first call.
 */
export async function computeAndStoreEmbeddings(
  opts: EmbedOptions,
): Promise<EmbedReport> {
  const driver: Driver = neo4j.driver(
    opts.uri,
    neo4j.auth.basic(opts.user, opts.password),
  );
  const sessionConfig = opts.database ? { database: opts.database } : {};
  const kinds = opts.kinds ?? ["Function", "Method", "Class"];
  const skipExisting = opts.skipExisting ?? true;
  const batchSize = opts.batchSize ?? 32;
  const maxBodyChars = opts.maxBodyChars ?? 1500;

  const start = Date.now();
  let embedded = 0;
  let skipped = 0;

  try {
    // Ensure vector index exists.
    {
      const session = driver.session(sessionConfig);
      try {
        await session.executeWrite((tx: ManagedTransaction) =>
          tx.run(
            `CREATE VECTOR INDEX code_vec IF NOT EXISTS
               FOR (n:CodeNode) ON (n.embedding)
               OPTIONS { indexConfig: {
                 \`vector.dimensions\`: $dims,
                 \`vector.similarity_function\`: 'cosine'
               }}`,
            { dims: neo4j.int(EMBEDDING_DIMS) },
          ),
        );
      } finally {
        await session.close();
      }
    }

    // Pull candidates: nodes of the chosen kinds with a body.
    const labelFilter = kinds.map((k) => `n:\`${k}\``).join(" OR ");
    const skipClause = skipExisting ? "AND n.embedding IS NULL" : "";
    const candidateQuery = `
      MATCH (n:CodeNode)
      WHERE (${labelFilter}) AND n.body IS NOT NULL ${skipClause}
      RETURN n.id AS id, n.signature AS signature, n.body AS body
    `;

    interface Candidate {
      id: string;
      signature?: string;
      body: string;
    }
    const candidates: Candidate[] = [];
    {
      const session = driver.session(sessionConfig);
      try {
        const result = await session.executeRead((tx: ManagedTransaction) =>
          tx.run(candidateQuery),
        );
        for (const r of result.records) {
          candidates.push({
            id: String(r.get("id")),
            signature: r.get("signature") ?? undefined,
            body: String(r.get("body") ?? ""),
          });
        }
      } finally {
        await session.close();
      }
    }

    if (candidates.length === 0) {
      console.error("[embed] nothing to embed (everything is up to date)");
      return {
        totalCandidates: 0,
        embedded: 0,
        skipped: 0,
        durationMs: Date.now() - start,
      };
    }
    console.error(
      `[embed] ${candidates.length} nodes to embed (batch=${batchSize})`,
    );

    // Process in batches.
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      const inputs = batch.map((c) => buildEmbeddingText(c, maxBodyChars));
      let vectors: number[][];
      try {
        vectors = await embedBatch(inputs, opts.model);
      } catch (err) {
        console.error(
          `[embed] batch ${i / batchSize + 1} failed: ${(err as Error).message}`,
        );
        skipped += batch.length;
        continue;
      }

      // Persist via UNWIND.
      const rows = batch.map((c, j) => ({ id: c.id, embedding: vectors[j] }));
      const session = driver.session(sessionConfig);
      try {
        await session.executeWrite((tx: ManagedTransaction) =>
          tx.run(
            `UNWIND $rows AS row
             MATCH (n:CodeNode { id: row.id })
             CALL db.create.setNodeVectorProperty(n, 'embedding', row.embedding)`,
            { rows },
          ),
        );
        embedded += batch.length;
      } finally {
        await session.close();
      }

      if ((i / batchSize) % 5 === 0) {
        const pct = Math.round(((i + batch.length) / candidates.length) * 100);
        console.error(
          `[embed] ${i + batch.length}/${candidates.length} (${pct}%)`,
        );
      }
    }

    return {
      totalCandidates: candidates.length,
      embedded,
      skipped,
      durationMs: Date.now() - start,
    };
  } finally {
    await driver.close();
  }
}

/** Signature + a bounded slice of the body — what the model actually sees. Shared with the local backend. */
export function buildEmbeddingText(
  c: { signature?: string; body: string },
  maxBodyChars: number,
): string {
  const sig = c.signature ? c.signature + "\n" : "";
  const body = c.body.length > maxBodyChars ? c.body.slice(0, maxBodyChars) : c.body;
  return sig + body;
}
