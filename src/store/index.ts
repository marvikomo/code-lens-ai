/**
 * One rule for which backend a command talks to: Neo4j when a URI was given
 * (flag or `NEO4J_URI`), otherwise the local index under `<repo>/.codelens/`.
 */
import path from "path";
import { LocalStore } from "./local";
import { Neo4jStore } from "./neo4j";
import type { GraphStore } from "./types";

export type { GraphStore } from "./types";
export { LocalStore } from "./local";
export { Neo4jStore } from "./neo4j";

export interface OpenStoreOptions {
  neo4jUri?: string;
  neo4jUser?: string;
  neo4jPassword?: string;
  neo4jDatabase?: string;
  /** Repo whose `.codelens/` to open. Default: current directory. */
  repo?: string;
}

export async function openStore(opts: OpenStoreOptions): Promise<GraphStore> {
  if (opts.neo4jUri) {
    if (!opts.neo4jUser || !opts.neo4jPassword) {
      throw new Error(
        "--neo4j-uri requires --neo4j-user and --neo4j-password (or NEO4J_USER / NEO4J_PASSWORD env vars)",
      );
    }
    const store = new Neo4jStore({
      uri: opts.neo4jUri,
      user: opts.neo4jUser,
      password: opts.neo4jPassword,
      database: opts.neo4jDatabase,
    });
    await store.connect(opts.neo4jUri);
    return store;
  }
  return LocalStore.open(path.resolve(opts.repo ?? process.cwd()));
}
