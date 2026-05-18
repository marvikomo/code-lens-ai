import neo4j, { Driver, ManagedTransaction } from "neo4j-driver";
import type { CodeGraph, GraphEdge, GraphNode } from "../util/graph";

export interface Neo4jOptions {
  uri: string;
  user: string;
  password: string;
  database?: string;
  /** Wipe the target DB before indexing (DETACH DELETE everything). */
  clear?: boolean;
  /** How many nodes/edges to push per UNWIND batch. */
  batchSize?: number;
  /** Skip writing edges whose `to` is an `unresolved:*` synthetic id. */
  skipUnresolved?: boolean;
}

/**
 * Pushes a CodeGraph into Neo4j.
 *
 * Strategy:
 *   - Each `GraphNode` becomes a node with two labels: `:CodeNode` and `:<Kind>`.
 *     `id` is the unique merge key (we create a uniqueness constraint up-front).
 *   - Each `GraphEdge` becomes a relationship typed by its `kind`
 *     (`CONTAINS`, `DEFINES`, `HAS_METHOD`, …).
 *   - Writes happen in batched `UNWIND` calls inside a single transaction per batch,
 *     so a moderately sized repo indexes in a few seconds.
 */
export async function indexToNeo4j(
  graph: CodeGraph,
  opts: Neo4jOptions,
): Promise<{ nodesWritten: number; edgesWritten: number }> {
  const driver: Driver = neo4j.driver(
    opts.uri,
    neo4j.auth.basic(opts.user, opts.password),
  );
  const sessionConfig = opts.database ? { database: opts.database } : {};
  const batchSize = opts.batchSize ?? 500;

  let nodesWritten = 0;
  let edgesWritten = 0;

  try {
    // 1. Schema: uniqueness constraint + full-text index on CodeNode.
    {
      const session = driver.session(sessionConfig);
      try {
        await session.executeWrite((tx: ManagedTransaction) =>
          tx.run(
            `CREATE CONSTRAINT code_node_id IF NOT EXISTS
               FOR (n:CodeNode) REQUIRE n.id IS UNIQUE`,
          ),
        );
        // Full-text index for keyword search across name/signature/body/path.
        // Uses `whitespace` analyzer — no stemming, preserves identifiers.
        await session.executeWrite((tx: ManagedTransaction) =>
          tx.run(
            `CREATE FULLTEXT INDEX code_fts IF NOT EXISTS
               FOR (n:CodeNode)
               ON EACH [n.name, n.signature, n.body, n.path]
               OPTIONS { indexConfig: { \`fulltext.analyzer\`: 'whitespace' } }`,
          ),
        );
        if (opts.clear) {
          await session.executeWrite((tx: ManagedTransaction) =>
            tx.run(`MATCH (n:CodeNode) DETACH DELETE n`),
          );
        }
      } finally {
        await session.close();
      }
    }

    // 2. Nodes — group by kind so we can apply both labels (`:CodeNode:<Kind>`).
    const nodesByKind = new Map<string, GraphNode[]>();
    for (const n of graph.nodes) {
      const arr = nodesByKind.get(n.kind) ?? [];
      arr.push(n);
      nodesByKind.set(n.kind, arr);
    }

    for (const [kind, nodes] of nodesByKind) {
      for (const batch of chunk(nodes, batchSize)) {
        const session = driver.session(sessionConfig);
        try {
          await session.executeWrite((tx: ManagedTransaction) =>
            tx.run(
              `UNWIND $rows AS row
               MERGE (n:CodeNode { id: row.id })
               SET n += row.props
               SET n:\`${kind}\``,
              { rows: batch.map(nodeToRow) },
            ),
          );
          nodesWritten += batch.length;
        } finally {
          await session.close();
        }
      }
    }

    // 3. Edges — one MERGE per kind because rel-type can't be parameterised.
    const validIds = new Set(graph.nodes.map((n) => n.id));
    const edgesByKind = new Map<string, GraphEdge[]>();
    for (const e of graph.edges) {
      if (opts.skipUnresolved && e.unresolved) continue;
      const arr = edgesByKind.get(e.kind) ?? [];
      arr.push(e);
      edgesByKind.set(e.kind, arr);
    }

    for (const [kind, edges] of edgesByKind) {
      // Split edges into "both endpoints known" vs "synthetic unresolved target".
      // For the second group we MERGE a placeholder `:Unresolved` node on the fly.
      const resolved = edges.filter((e) => validIds.has(e.to));
      const unresolved = edges.filter((e) => !validIds.has(e.to));

      for (const batch of chunk(resolved, batchSize)) {
        const session = driver.session(sessionConfig);
        try {
          await session.executeWrite((tx: ManagedTransaction) =>
            tx.run(
              `UNWIND $rows AS row
               MATCH (a:CodeNode { id: row.from })
               MATCH (b:CodeNode { id: row.to })
               MERGE (a)-[r:\`${kind}\` { id: row.id }]->(b)
               SET r += row.props`,
              { rows: batch.map(edgeToRow) },
            ),
          );
          edgesWritten += batch.length;
        } finally {
          await session.close();
        }
      }

      for (const batch of chunk(unresolved, batchSize)) {
        const session = driver.session(sessionConfig);
        try {
          await session.executeWrite((tx: ManagedTransaction) =>
            tx.run(
              `UNWIND $rows AS row
               MATCH (a:CodeNode { id: row.from })
               MERGE (b:Unresolved { id: row.to })
                 ON CREATE SET b.symbol = row.symbol
               MERGE (a)-[r:\`${kind}\` { id: row.id }]->(b)
               SET r += row.props`,
              { rows: batch.map(edgeToRow) },
            ),
          );
          edgesWritten += batch.length;
        } finally {
          await session.close();
        }
      }
    }
  } finally {
    await driver.close();
  }

  return { nodesWritten, edgesWritten };
}

function nodeToRow(n: GraphNode): Record<string, unknown> {
  // `kind` mirrors the Neo4j label so cypher queries can read `n.kind`
  // directly instead of unwrapping `labels(n)` (which carries both `:CodeNode`
  // and `:<Kind>` and is order-dependent — a real footgun real users hit).
  const props: Record<string, unknown> = {
    name: n.name,
    kind: n.kind,
  };
  if (n.path) props.path = n.path;
  if (n.language) props.language = n.language;
  if (n.signature) props.signature = n.signature;
  if (n.body) props.body = n.body;
  if (n.bodyTruncated) props.bodyTruncated = n.bodyTruncated;
  if (n.httpMethod) props.httpMethod = n.httpMethod;
  if (n.route) props.route = n.route;
  if (n.routerObject) props.routerObject = n.routerObject;
  if (n.builder) props.builder = n.builder;
  if (n.isTest) props.isTest = n.isTest;
  if (n.testFramework) props.testFramework = n.testFramework;
  if (n.contentHash) props.contentHash = n.contentHash;
  if (n.lastIndexed) props.lastIndexed = n.lastIndexed;
  if (n.lastCommit) props.lastCommit = n.lastCommit;
  if (n.sourceUrl) props.sourceUrl = n.sourceUrl;
  if (n.range) {
    props.startRow = n.range.start.row;
    props.startColumn = n.range.start.column;
    props.endRow = n.range.end.row;
    props.endColumn = n.range.end.column;
  }
  if (n.meta) {
    for (const [k, v] of Object.entries(n.meta)) {
      // Neo4j only supports primitives / arrays of primitives as properties.
      if (isStorableProp(v)) props[`meta_${k}`] = v;
    }
  }
  return { id: n.id, kind: n.kind, props };
}

function edgeToRow(e: GraphEdge): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  if (e.source) props.source = e.source;
  if (e.unresolved) props.unresolved = e.unresolved;
  if (e.meta) {
    for (const [k, v] of Object.entries(e.meta)) {
      if (isStorableProp(v)) props[`meta_${k}`] = v;
    }
  }
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    symbol: e.unresolved ?? null,
    props,
  };
}

function isStorableProp(v: unknown): boolean {
  if (v === null) return false;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(v)) return v.every(isStorableProp);
  return false;
}

function* chunk<T>(arr: T[], size: number): Iterable<T[]> {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size);
}
