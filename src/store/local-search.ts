/**
 * Search for the local backend.
 *
 * Keyword search is `minisearch` over name / signature / body / path with
 * `name` boosted — BM25-flavoured, prefix and fuzzy matching, pure JS. It is
 * built lazily on the first query and kept for the store's lifetime.
 *
 * Semantic search reuses the in-process embedder (`embeddings/local.ts`) for
 * the query and a brute-force cosine scan over vectors stored in
 * `.codelens/embeddings.bin`. At tens of thousands of vectors this is a few
 * milliseconds; an ANN index would be engineering for a problem we don't have.
 *
 * Hybrid fuses the two by Reciprocal Rank Fusion, same as the Neo4j path.
 */
import fs from "fs";
import path from "path";
import MiniSearch from "minisearch";
import { embed } from "../embeddings/local";
import type { SearchHit, SearchMode } from "../search";
import type { GraphNode, NodeKind } from "../util/graph";
import { localDir, type LocalMeta } from "./persist";
import type { SearchOptions } from "./types";

const SEARCHABLE_KINDS: ReadonlySet<string> = new Set([
  "Function", "Method", "Class", "Interface", "TypeAlias", "Enum", "Property", "Variable", "File",
]);
const SNIPPET_CHARS = 280;
const RRF_K = 60;

interface Doc {
  id: string;
  name: string;
  signature: string;
  body: string;
  path: string;
}

export interface EmbeddingsFile {
  ids: string[];
  dims: number;
  model: string;
  vectors: Float32Array;
}

export class LocalSearch {
  private readonly nodeById: Map<string, GraphNode>;
  private readonly repoPath: string;
  private readonly embeddingModel: string | undefined;
  private mini: MiniSearch<Doc> | null = null;
  private embeddings: EmbeddingsFile | null | undefined;

  constructor(nodes: GraphNode[], meta: LocalMeta) {
    this.nodeById = new Map(nodes.filter((n) => SEARCHABLE_KINDS.has(n.kind)).map((n) => [n.id, n]));
    this.repoPath = meta.repoPath;
    this.embeddingModel = meta.embeddingModel;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 20;
    const mode: SearchMode = opts.mode ?? (this.loadEmbeddings() ? "hybrid" : "fts");
    switch (mode) {
      case "fts":
        return this.keyword(query, opts.kind, limit);
      case "vector":
        return this.semantic(query, opts.kind, limit);
      case "hybrid": {
        const fanout = limit * 3;
        const [fts, vec] = await Promise.all([
          this.keyword(query, opts.kind, fanout),
          this.semantic(query, opts.kind, fanout).catch((e) => {
            console.error(`[local-search] vector leg failed: ${(e as Error).message}`);
            return [] as SearchHit[];
          }),
        ]);
        return fuse(fts, vec, limit);
      }
    }
  }

  // ─── keyword ──────────────────────────────────────────────────────────────

  private async keyword(query: string, kind: NodeKind | undefined, limit: number): Promise<SearchHit[]> {
    this.mini ??= this.buildIndex();
    const results = this.mini.search(query, {
      prefix: true,
      fuzzy: 0.2,
      boost: { name: 4, signature: 2, path: 1.5 },
      combineWith: "OR",
      filter: kind ? (r) => this.nodeById.get(r.id)?.kind === kind : undefined,
    });
    return results.slice(0, limit).map((r) => this.hit(this.nodeById.get(r.id)!, r.score, "fts"));
  }

  private buildIndex(): MiniSearch<Doc> {
    const mini = new MiniSearch<Doc>({
      fields: ["name", "signature", "body", "path"],
      storeFields: [],
      // Split on whitespace and punctuation but also inside camelCase and
      // snake_case, so "resolveCalls" is found by "resolve".
      tokenize: tokenize,
      processTerm: (term) => term.toLowerCase(),
      searchOptions: { processTerm: (term) => term.toLowerCase() },
    });
    const docs: Doc[] = [];
    for (const n of this.nodeById.values()) {
      docs.push({
        id: n.id,
        name: n.name,
        signature: n.signature ?? "",
        body: n.body ?? "",
        path: n.path ? path.relative(this.repoPath, n.path) : "",
      });
    }
    mini.addAll(docs);
    return mini;
  }

  // ─── semantic ─────────────────────────────────────────────────────────────

  private async semantic(query: string, kind: NodeKind | undefined, limit: number): Promise<SearchHit[]> {
    const emb = this.loadEmbeddings();
    if (!emb) {
      throw new Error("No embeddings in the local index. Run `codelens index <repo> --embed` first.");
    }
    const q = await embed(query, emb.model);
    const scored: Array<{ id: string; score: number }> = [];
    for (let i = 0; i < emb.ids.length; i++) {
      const node = this.nodeById.get(emb.ids[i]);
      if (!node || (kind && node.kind !== kind)) continue;
      scored.push({ id: emb.ids[i], score: dot(q, emb.vectors, i * emb.dims, emb.dims) });
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => this.hit(this.nodeById.get(s.id)!, s.score, "vector"));
  }

  /** Cached; `undefined` means not yet checked, `null` means absent. */
  private loadEmbeddings(): EmbeddingsFile | null {
    if (this.embeddings !== undefined) return this.embeddings;
    this.embeddings = readEmbeddings(this.repoPath);
    return this.embeddings;
  }

  private hit(n: GraphNode, score: number, matchedBy: "fts" | "vector"): SearchHit {
    return {
      id: n.id,
      kind: n.kind,
      name: n.name,
      path: n.path,
      language: n.language,
      signature: n.signature,
      bodySnippet: n.body ? n.body.slice(0, SNIPPET_CHARS) : undefined,
      startRow: n.range?.start.row,
      endRow: n.range?.end.row,
      score,
      matchedBy: [matchedBy],
    };
  }
}

// ─── embeddings file ────────────────────────────────────────────────────────

export function embeddingsPaths(repoPath: string): { bin: string; json: string } {
  const dir = localDir(repoPath);
  return { bin: path.join(dir, "embeddings.bin"), json: path.join(dir, "embeddings.json") };
}

export function writeEmbeddings(repoPath: string, file: EmbeddingsFile): void {
  const { bin, json } = embeddingsPaths(repoPath);
  fs.writeFileSync(bin, Buffer.from(file.vectors.buffer, file.vectors.byteOffset, file.vectors.byteLength));
  fs.writeFileSync(json, JSON.stringify({ ids: file.ids, dims: file.dims, model: file.model }), "utf8");
}

export function readEmbeddings(repoPath: string): EmbeddingsFile | null {
  const { bin, json } = embeddingsPaths(repoPath);
  if (!fs.existsSync(bin) || !fs.existsSync(json)) return null;
  const header = JSON.parse(fs.readFileSync(json, "utf8")) as { ids: string[]; dims: number; model: string };
  const buf = fs.readFileSync(bin);
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return { ...header, vectors };
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Reciprocal Rank Fusion — hits found by both legs float to the top. */
function fuse(fts: SearchHit[], vec: SearchHit[], limit: number): SearchHit[] {
  const fused = new Map<string, SearchHit>();
  fts.forEach((h, rank) => fused.set(h.id, { ...h, score: 1 / (RRF_K + rank + 1), matchedBy: ["fts"] }));
  vec.forEach((h, rank) => {
    const score = 1 / (RRF_K + rank + 1);
    const existing = fused.get(h.id);
    if (existing) fused.set(h.id, { ...existing, score: existing.score + score, matchedBy: [...existing.matchedBy, "vector"] });
    else fused.set(h.id, { ...h, score, matchedBy: ["vector"] });
  });
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Identifier-aware tokenizer: `resolveCallsByName` → resolve, calls, by, name (plus the whole). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9_$]+/)) {
    if (!raw) continue;
    out.push(raw);
    const parts = raw.split(/_+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter((p) => p.length > 1);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

function dot(q: number[], vectors: Float32Array, offset: number, dims: number): number {
  let s = 0;
  for (let i = 0; i < dims; i++) s += q[i] * vectors[offset + i];
  return s;
}
