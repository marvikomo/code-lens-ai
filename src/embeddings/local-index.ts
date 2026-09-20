/**
 * `--embed` for the local backend: embed Function/Method/Class bodies with
 * the in-process model and write `.codelens/embeddings.{bin,json}`.
 * Mirrors `computeAndStoreEmbeddings`, minus the database.
 */
import type { CodeGraph } from "../util/graph";
import { writeEmbeddings } from "../store/local-search";
import { embedBatch, EMBEDDING_DIMS } from "./local";
import { buildEmbeddingText, type EmbedReport } from "./pipeline";

const DEFAULT_MODEL = "jinaai/jina-embeddings-v2-base-code";

export interface LocalEmbedOptions {
  repoPath: string;
  kinds?: string[];
  batchSize?: number;
  maxBodyChars?: number;
  model?: string;
}

export async function computeLocalEmbeddings(
  graph: CodeGraph,
  opts: LocalEmbedOptions,
): Promise<EmbedReport & { model: string }> {
  const start = Date.now();
  const kinds = new Set(opts.kinds ?? ["Function", "Method", "Class"]);
  const model = opts.model ?? DEFAULT_MODEL;
  const batchSize = opts.batchSize ?? 32;
  const maxBodyChars = opts.maxBodyChars ?? 1500;

  const candidates = graph.nodes.filter((n) => kinds.has(n.kind) && n.body);
  const ids: string[] = [];
  const vectors = new Float32Array(candidates.length * EMBEDDING_DIMS);
  let offset = 0;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const texts = batch.map((n) => buildEmbeddingText({ signature: n.signature, body: n.body! }, maxBodyChars));
    const vecs = await embedBatch(texts, model);
    for (let j = 0; j < batch.length; j++) {
      ids.push(batch[j].id);
      vectors.set(vecs[j], offset);
      offset += EMBEDDING_DIMS;
    }
    if ((i / batchSize) % 10 === 0) {
      console.error(`[embed] ${Math.min(i + batchSize, candidates.length)}/${candidates.length}`);
    }
  }
  writeEmbeddings(opts.repoPath, { ids, dims: EMBEDDING_DIMS, model, vectors });
  return {
    totalCandidates: candidates.length,
    embedded: ids.length,
    skipped: 0,
    durationMs: Date.now() - start,
    model,
  };
}
