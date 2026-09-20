/**
 * Semantic layer tagging for File nodes.
 *
 * Leiden communities answer "which files change together?" — a structural
 * question. Agents also ask "where is the persistence layer?" — a semantic
 * one, and no amount of import-graph clustering answers it. This pass gives
 * every File a `layer` from a fixed vocabulary (`LAYERS`) by asking a System
 * One model one Choice question per file over evidence the graph already
 * holds: path, language, external packages, declarations, routes, and the
 * first lines of source.
 *
 * Division of labour: code owns the vocabulary, the evidence, the batching
 * and the thresholds; the model only picks. The raw pick and its confidence
 * are both stored, so display policy (`minConfidence`) can change without
 * re-running inference.
 */
import fs from "fs";
import path from "path";
import type { CodeGraph, GraphEdge, GraphNode } from "../util/graph";
import { choice, type Judge, type Questions } from "./judge";

export type { Judge } from "./judge";

export const LAYERS = {
  api_surface:
    "Receives requests from outside the process: HTTP route handlers, controllers, " +
    "GraphQL resolvers, RPC/gRPC services, CLI command entry points, MCP tool handlers, " +
    "message-queue consumers, webhook receivers.",
  ui:
    "Renders a user interface: React/Vue/Svelte components, views, templates, pages, " +
    "styling, client-side state hooks.",
  business_logic:
    "Domain rules and core behaviour: services, use cases, workflows, validation of " +
    "domain invariants, algorithms specific to what the product does.",
  data_access:
    "Reads and writes persistent state: database queries, repositories, ORM models and " +
    "schemas, migrations, cache clients, file or blob storage adapters.",
  infrastructure:
    "Wires the application together or talks to the platform: server bootstrap, " +
    "dependency injection, middleware, logging, telemetry, HTTP/SDK clients for external " +
    "services, build and deployment scripts.",
  configuration:
    "Declares settings rather than behaviour: config schemas, environment variable " +
    "loading, constants, feature flags, type-only declaration files.",
  utilities:
    "Generic helpers with no domain meaning that could be lifted into any project: " +
    "string, date, collection, math, path or formatting helpers.",
  tests:
    "Exercises other code rather than shipping behaviour: test cases, fixtures, mocks, " +
    "factories, test setup.",
  unclear:
    "The evidence does not support any of the above with reasonable confidence.",
} as const;

export type LayerId = keyof typeof LAYERS;

export const LAYER_IDS = Object.keys(LAYERS) as LayerId[];

/** What the model sees for one file. Every field is derived from the graph or disk. */
export interface FileEvidence {
  path: string;
  language: string;
  isTest: boolean;
  /** Module specifiers that resolved to nothing in the repo — third-party packages. */
  externalImports: string[];
  /** Repo files this file imports, relative to the repo root. */
  importsFiles: string[];
  /** `METHOD /route` for handler functions defined in this file. */
  routes: string[];
  /**
   * Declarations ranked by how connected they are in the graph — exported,
   * called from other files, calling many things — so the symbols that define
   * what the file is for come first and survive the budget cut. Methods are
   * indented under their class. Anonymous functions are dropped.
   */
  symbols: string[];
  /** First lines of the source (file comment, imports), bounded by `HEAD_MAX_CHARS`. */
  head: string;
}

export interface TagLayersOptions {
  /** Absolute repo root; evidence paths are made relative to it. */
  repoPath: string;
  /** Restrict tagging to these File node ids (incremental runs). */
  only?: Set<string>;
  /** Picks below this confidence are counted as low-confidence in the report. Default 0.6. */
  minConfidence?: number;
  /**
   * Character budget for one request's state. Default 15 000 (~6 files).
   * Measured on this repo: 60k chars (~25 files/request) more than doubled
   * the low-confidence count and flipped whole neighbourhoods of picks
   * (language configs split between `configuration` and `business_logic`);
   * 4k gave no further gain for 4× the requests.
   */
  maxStateChars?: number;
  /** Requests in flight at once. Default 4. */
  concurrency?: number;
  /** Progress callback, called after each request completes. */
  onProgress?: (done: number, total: number) => void;
}

export interface TagLayersReport {
  tagged: number;
  lowConfidence: number;
  requests: number;
  failed: number;
  byLayer: Record<LayerId, number>;
}

const HEAD_MAX_CHARS = 1500;
const HEAD_MAX_LINES = 30;
const SYMBOLS_MAX_CHARS = 1600;
const SIGNATURE_MAX_CHARS = 140;
const MAX_IMPORTS = 15;

/** Call edges whose target was a confident binding. Ambiguous name matches
 *  (`walk`, `Run`, `Close`) would otherwise inflate a symbol's caller count
 *  with dozens of unrelated call sites. */
const CONFIDENT_SOURCES = new Set(["static", "via_imports", "via_reexport", "name_only"]);
const DEFAULT_MAX_STATE_CHARS = 15_000;

export function buildFileEvidence(
  graph: CodeGraph,
  file: GraphNode,
  repoPath: string,
): FileEvidence {
  const rel = (p: string): string => path.relative(repoPath, p).split(path.sep).join("/");
  const idx = indexGraph(graph);

  const externalImports: string[] = [];
  const importsFiles: string[] = [];
  const routes: string[] = [];
  const defined: GraphNode[] = [];

  for (const e of idx.outEdges.get(file.id) ?? []) {
    if (e.kind === "IMPORTS") {
      if (e.unresolved) externalImports.push(e.unresolved);
      else {
        const target = idx.nodeById.get(e.to);
        if (target?.path) importsFiles.push(rel(target.path));
      }
    } else if (e.kind === "DEFINES") {
      const d = idx.nodeById.get(e.to);
      if (!d) continue;
      if (d.httpMethod) routes.push(`${d.httpMethod} ${d.route ?? "?"}`);
      defined.push(d);
    }
  }

  return {
    path: rel(file.path!),
    language: file.language ?? "unknown",
    isTest: !!file.isTest,
    externalImports: dedupe(externalImports).slice(0, MAX_IMPORTS),
    importsFiles: dedupe(importsFiles).slice(0, MAX_IMPORTS),
    routes: dedupe(routes),
    symbols: rankedSymbols(defined, file, idx),
    head: readHead(file.path!),
  };
}

// ─── Symbol ranking ────────────────────────────────────────────────────────

interface GraphIndex {
  nodeById: Map<string, GraphNode>;
  outEdges: Map<string, GraphEdge[]>;
  inCalls: Map<string, GraphEdge[]>;
  exported: Set<string>;
}

/** Built once per `buildFileEvidence` call set; see `tagFileLayers` for reuse. */
let cachedIndex: { graph: CodeGraph; index: GraphIndex } | null = null;

function indexGraph(graph: CodeGraph): GraphIndex {
  if (cachedIndex?.graph === graph) return cachedIndex.index;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outEdges = new Map<string, GraphEdge[]>();
  const inCalls = new Map<string, GraphEdge[]>();
  const exported = new Set<string>();
  for (const e of graph.edges) {
    push(outEdges, e.from, e);
    if (e.kind === "CALLS" && e.source && CONFIDENT_SOURCES.has(e.source)) push(inCalls, e.to, e);
    if (e.kind === "EXPORTS") exported.add(e.to);
  }
  const index = { nodeById, outEdges, inCalls, exported };
  cachedIndex = { graph, index };
  return index;
}

interface RankedSymbol {
  node: GraphNode;
  score: number;
  exported: boolean;
  callerFiles: number;
  localCallers: number;
  callees: number;
  order: number;
}

function rankedSymbols(defined: GraphNode[], file: GraphNode, idx: GraphIndex): string[] {
  const ranked = defined
    .filter((d) => !isAnonymous(d))
    .map((d, order) => scoreSymbol(d, file, idx, order))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const lines: string[] = [];
  let used = 0;
  for (const r of ranked) {
    const line = describeSymbol(r, "");
    const members = memberLines(r.node, file, idx);
    const cost = line.length + members.reduce((n, m) => n + m.length + 1, 0) + 1;
    if (used + cost > SYMBOLS_MAX_CHARS && lines.length > 0) break;
    lines.push(line, ...members);
    used += cost;
  }
  return lines;
}

function scoreSymbol(node: GraphNode, file: GraphNode, idx: GraphIndex, order: number): RankedSymbol {
  const callers = idx.inCalls.get(node.id) ?? [];
  const callerFiles = new Set(
    callers
      .map((e) => idx.nodeById.get(e.from)?.path)
      .filter((p): p is string => !!p && p !== file.path),
  ).size;
  const localCallers = callers.filter((e) => idx.nodeById.get(e.from)?.path === file.path).length;
  const callees = (idx.outEdges.get(node.id) ?? []).filter((e) => e.kind === "CALLS").length;
  const exported = idx.exported.has(node.id);
  // Being used from elsewhere says most about a file's role; being exported
  // is intent to be used; calling out shows the symbol does real work.
  const score =
    (exported ? 3 : 0) +
    Math.min(callerFiles, 10) * 2 +
    Math.min(localCallers, 5) * 0.3 +
    Math.min(callees, 10) * 0.3;
  return { node, score, exported, callerFiles, localCallers, callees, order };
}

function describeSymbol(r: RankedSymbol, indent: string): string {
  const sig = firstLine(r.node.signature) ?? r.node.name;
  const tags: string[] = [];
  if (r.exported) tags.push("exported");
  if (r.callerFiles > 0) tags.push(`called from ${r.callerFiles} file${r.callerFiles === 1 ? "" : "s"}`);
  if (r.localCallers > 0) tags.push(`${r.localCallers} local caller${r.localCallers === 1 ? "" : "s"}`);
  if (r.callees > 0) tags.push(`calls ${r.callees}`);
  if (r.node.builder) tags.push(`built by ${r.node.builder}`);
  const suffix = tags.length ? ` [${tags.join("; ")}]` : "";
  return `${indent}${r.node.kind} ${r.node.name} — ${sig}${suffix}`;
}

/** Methods and properties of a class, in declaration order, indented. */
function memberLines(cls: GraphNode, file: GraphNode, idx: GraphIndex): string[] {
  if (cls.kind !== "Class" && cls.kind !== "Interface") return [];
  const members = (idx.outEdges.get(cls.id) ?? [])
    .filter((e) => e.kind === "HAS_METHOD" || e.kind === "HAS_PROPERTY")
    .map((e) => idx.nodeById.get(e.to))
    .filter((m): m is GraphNode => !!m && !isAnonymous(m));
  return members.map((m, i) => describeSymbol(scoreSymbol(m, file, idx, i), "  "));
}

function isAnonymous(node: GraphNode): boolean {
  return node.name === "<anonymous>" || node.name.startsWith("<");
}

/** Whole signature on one line — multi-line parameter lists would otherwise cut at `(`. */
function firstLine(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, SIGNATURE_MAX_CHARS) : undefined;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

export async function tagFileLayers(
  graph: CodeGraph,
  judge: Judge,
  opts: TagLayersOptions,
): Promise<TagLayersReport> {
  const minConfidence = opts.minConfidence ?? 0.6;
  const maxStateChars = opts.maxStateChars ?? DEFAULT_MAX_STATE_CHARS;
  const concurrency = opts.concurrency ?? 4;

  const files = graph.nodes.filter(
    (n) => n.kind === "File" && n.path && (!opts.only || opts.only.has(n.id)),
  );
  const evidence = files.map((f) => ({ file: f, ev: buildFileEvidence(graph, f, opts.repoPath) }));
  const batches = packBatches(evidence, maxStateChars);

  const report: TagLayersReport = {
    tagged: 0,
    lowConfidence: 0,
    requests: batches.length,
    failed: 0,
    byLayer: Object.fromEntries(LAYER_IDS.map((id) => [id, 0])) as Record<LayerId, number>,
  };

  let done = 0;
  const runBatch = async (batch: typeof evidence): Promise<void> => {
    const state = { files: batch.map((b) => b.ev) };
    const questions = layerQuestions(batch.length);
    try {
      const answers = await judge.ask(state, questions);
      batch.forEach((b, i) => {
        const answer = answers[`file_${i}`];
        if (answer?.type !== "choice") return;
        const layer = isLayerId(answer.choice) ? answer.choice : "unclear";
        b.file.layer = layer;
        b.file.layerConfidence = round(answer.confidence);
        report.tagged++;
        report.byLayer[layer]++;
        if (answer.confidence < minConfidence) report.lowConfidence++;
      });
    } catch (error) {
      // One failed request costs its batch, not the run. Files stay untagged
      // and a later run picks them up.
      report.failed += batch.length;
      console.error(`[layers] request failed for ${batch.length} files: ${(error as Error).message}`);
    } finally {
      done++;
      opts.onProgress?.(done, batches.length);
    }
  };

  await runWithConcurrency(batches, concurrency, runBatch);
  return report;
}

/**
 * One Choice per file, all against the same state. Every question sees every
 * file, so each must point at its own entry by path.
 */
function layerQuestions(count: number): Questions {
  const questions: Questions = {};
  for (let i = 0; i < count; i++) {
    questions[`file_${i}`] = choice(
      {
        question: `Which architectural layer does the source file described at \`files[${i}]\` belong to?`,
        guidance: [
          "Judge the file's primary role in the application, not every line in it.",
          "`files[" + i + "].externalImports` names the third-party packages it uses; " +
            "`routes` lists HTTP endpoints it defines; `symbols` lists its declarations, most-connected first, " +
            "with class members indented and tags for export status and call traffic; " +
            "`head` is the start of the source.",
          "When `isTest` is true the indexer already found test cases in it.",
          "Pick `unclear` when nothing in the evidence points to one layer.",
        ],
      },
      LAYERS,
    );
  }
  return questions;
}

/** Greedy first-fit by serialized size. A single oversized file still gets its own batch. */
function packBatches<T extends { ev: FileEvidence }>(items: T[], maxChars: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;
  for (const item of items) {
    const size = JSON.stringify(item.ev).length + 2;
    if (current.length > 0 && currentChars + size > maxChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function readHead(absPath: string): string {
  try {
    const text = fs.readFileSync(absPath, "utf8");
    const lines = text.split("\n").slice(0, HEAD_MAX_LINES).join("\n");
    return lines.slice(0, HEAD_MAX_CHARS);
  } catch {
    return "";
  }
}

function isLayerId(value: string): value is LayerId {
  return Object.prototype.hasOwnProperty.call(LAYERS, value);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
