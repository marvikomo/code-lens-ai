#!/usr/bin/env node
import "dotenv/config";
import fs from "fs";
import path from "path";
import neo4j from "neo4j-driver";
import {
  analyzeRepository,
  preloadRepositoryGrammars,
  scanRepository,
  analyzeIncremental,
} from "./analyser/analyser";
import { indexToNeo4j } from "./indexers/neo4j";
import {
  deleteFilesByPath,
  getDependents,
  getFileHashes,
  getRepositoryMeta,
  setRepositoryMeta,
  type IncrementalCtx,
} from "./indexers/neo4j-incremental";
import { clusterInNeo4j } from "./clustering/neo4j-leiden";
import { runNeo4jSubcommand } from "./cli-commands/neo4j";
import { runMcpInstall } from "./cli-commands/mcp-install";
import { runHooksSubcommand } from "./cli-commands/hooks";
import { computeAndStoreEmbeddings } from "./embeddings/pipeline";
import { search, type SearchMode } from "./search";
import { startMcpServer } from "./mcp/server";
import { resolveSource } from "./util/repo-source";
import {
  gitCommitDelta,
  gitHeadCommit,
  gitIsAncestor,
  gitWorkingTreeClean,
  gitWorkingTreeDelta,
  isGitRepo,
  mergeDeltas,
  type GitDelta,
} from "./util/git";

interface CliArgs {
  repo: string;
  out?: string;
  ignore: string[];
  pretty: boolean;
  noResolveCalls: boolean;
  stats: boolean;
  noJson: boolean;
  // Neo4j
  neo4jUri?: string;
  neo4jUser?: string;
  neo4jPassword?: string;
  neo4jDatabase?: string;
  neo4jClear: boolean;
  neo4jSkipUnresolved: boolean;
  // Incremental indexing
  incremental: boolean;
  // Clustering
  cluster: boolean;
  clusterOnly: boolean;
  clusterClear: boolean;
  clusterSpinePagerank?: number;
  clusterSpineBoundary?: number;
  clusterMinSize?: number;
  // Embeddings
  embed: boolean;
  embedModel?: string;
  embedBatch?: number;
  // Search
  searchQuery?: string;
  searchMode?: SearchMode;
  searchLimit?: number;
  // MCP server
  mcp: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    repo: "",
    ignore: [],
    pretty: true,
    noResolveCalls: false,
    stats: false,
    noJson: false,
    neo4jClear: false,
    neo4jSkipUnresolved: false,
    incremental: false,
    cluster: false,
    clusterOnly: false,
    clusterClear: false,
    embed: false,
    mcp: false,
  };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-o":
      case "--out":
        args.out = argv[++i];
        break;
      case "--ignore":
        args.ignore.push(...(argv[++i] ?? "").split(",").filter(Boolean));
        break;
      case "--no-pretty":
        args.pretty = false;
        break;
      case "--no-resolve-calls":
        args.noResolveCalls = true;
        break;
      case "--stats":
        args.stats = true;
        break;
      case "--no-json":
        args.noJson = true;
        break;
      case "--neo4j-uri":
        args.neo4jUri = argv[++i];
        break;
      case "--neo4j-user":
        args.neo4jUser = argv[++i];
        break;
      case "--neo4j-password":
        args.neo4jPassword = argv[++i];
        break;
      case "--neo4j-database":
        args.neo4jDatabase = argv[++i];
        break;
      case "--neo4j-clear":
        args.neo4jClear = true;
        break;
      case "--neo4j-skip-unresolved":
        args.neo4jSkipUnresolved = true;
        break;
      case "--incremental":
        args.incremental = true;
        break;
      case "--cluster":
        args.cluster = true;
        break;
      case "--cluster-only":
        // Implies --cluster (the dispatch logic uses cluster=true).
        args.cluster = true;
        args.clusterOnly = true;
        break;
      case "--cluster-clear":
        args.clusterClear = true;
        break;
      case "--cluster-spine-pagerank":
        args.clusterSpinePagerank = Number(argv[++i]);
        break;
      case "--cluster-spine-boundary":
        args.clusterSpineBoundary = Number(argv[++i]);
        break;
      case "--cluster-min-size":
        args.clusterMinSize = Number(argv[++i]);
        break;
      case "--embed":
        args.embed = true;
        break;
      case "--embed-model":
        args.embedModel = argv[++i];
        break;
      case "--embed-batch":
        args.embedBatch = Number(argv[++i]);
        break;
      case "--search":
        args.searchQuery = argv[++i];
        break;
      case "--search-mode": {
        const v = argv[++i];
        if (v !== "fts" && v !== "vector" && v !== "hybrid") {
          console.error(
            `[codelens] --search-mode must be one of: fts, vector, hybrid (got "${v}")`,
          );
          process.exit(2);
        }
        args.searchMode = v;
        break;
      }
      case "--search-limit":
        args.searchLimit = Number(argv[++i]);
        break;
      case "--mcp":
        args.mcp = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        rest.push(a);
    }
  }
  // Default to "." only when no --search is given. With --search but no
  // positional, leave repo empty so the search-only branch fires.
  if (rest[0]) {
    args.repo = rest[0];
  } else if (!args.searchQuery) {
    args.repo = ".";
  }

  // Env-var fallbacks for credentials.
  args.neo4jUri ??= process.env.NEO4J_URI;
  args.neo4jUser ??= process.env.NEO4J_USER;
  args.neo4jPassword ??= process.env.NEO4J_PASSWORD;
  args.neo4jDatabase ??= process.env.NEO4J_DATABASE;
  return args;
}

function printHelp(): void {
  console.log(
    `codelens - build a code graph from a repository (24 languages)

Usage:
  codelens <subcommand> [args]
  codelens <repo-path-or-git-url> [options]   (shorthand for: codelens index ...)

Subcommands:
  index <path>             Analyze + index a repo (default if no subcommand)
  mcp                      Start the MCP server (stdio)
  mcp install              Register the MCP server with Claude Code
  neo4j start|stop|status|logs    Manage the bundled Neo4j docker container
  hooks install|uninstall|status  Keep the index fresh via git hooks
  help                     Show this help

  When given a git URL (https://, git@, ssh://), the tool clones into
  ~/.code-lens-aI/cache/<host>/<owner>/<name>/ and indexes from there.
  Re-running with the same URL syncs the clone before indexing.

General:
  -o, --out <file>             Write JSON to file (default: stdout)
      --ignore <a,b,c>         Extra folder/file names to ignore
      --no-pretty              Compact JSON output
      --no-resolve-calls       Keep CALLS edges fully unresolved
      --no-json                Do not emit JSON (use with --neo4j-uri)
      --stats                  Print summary stats to stderr

Neo4j (also reads NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD / NEO4J_DATABASE):
      --neo4j-uri <uri>        e.g. bolt://localhost:7687  or  neo4j+s://...
      --neo4j-user <name>
      --neo4j-password <pw>
      --neo4j-database <name>
      --neo4j-clear            DETACH DELETE all :CodeNode before indexing
      --neo4j-skip-unresolved  Skip edges whose target was never resolved
      --incremental            Re-index only changed files (git-aware when
                               target is a git repo; sha256-based otherwise).
                               Cascades to dependents so CALLS edges stay correct.

Clustering (requires Neo4j + GDS plugin; runs after indexing):
      --cluster                Run Leiden community detection on File-IMPORTS
      --cluster-only           Only run clustering against existing graph (skip
                               analyze/index/embed). No <repo-path> needed.
                               Preserves existing embeddings.
      --cluster-clear          Wipe community props + :Community nodes first
      --cluster-spine-pagerank <n>   Per-community top-K by PageRank (default 5)
      --cluster-spine-boundary <n>   Per-community top-K by boundary degree (default 3)
      --cluster-min-size <n>         Min files to materialize a :Community node (default 3)

Embeddings (requires Neo4j; downloads ~161 MB model on first run):
      --embed                  Compute embeddings for all Function/Method/Class nodes
      --embed-model <hf-id>    Override default jinaai/jina-embeddings-v2-base-code
      --embed-batch <n>        Batch size for the embedding model (default 32)

Search (runs against existing graph; can run with no <repo-path>):
      --search "<query>"       Run a search and print top hits
      --search-mode <m>        fts | vector | hybrid (auto if omitted)
      --search-limit <n>       Top-N results (default 20)

MCP server mode (stdio; no <repo-path> needed):
      --mcp                    Start the Model Context Protocol server.
                               Wire into Claude Desktop/Cursor/Codex configs.

  -h, --help                   Show this help`,
  );
}

// Subcommand dispatcher. Inspects argv[0]; falls through to legacy
// bare-path/flags behavior (treated as `index`) when no known subcommand
// is given. Keeps `--mcp` flag and bare-path forms working as aliases.
const KNOWN_SUBCOMMANDS = new Set(["index", "mcp", "neo4j", "hooks", "help"]);

async function runMcpServerFromArgs(args: CliArgs): Promise<void> {
  if (!args.neo4jUri || !args.neo4jUser || !args.neo4jPassword) {
    console.error(
      "[codelens] mcp requires Neo4j credentials (--neo4j-uri / --neo4j-user / --neo4j-password " +
        "or NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD env vars)",
    );
    process.exit(2);
  }
  await startMcpServer({
    neo4jUri: args.neo4jUri,
    neo4jUser: args.neo4jUser,
    neo4jPassword: args.neo4jPassword,
    neo4jDatabase: args.neo4jDatabase,
  });
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const head = rawArgv[0];
  const subcommand =
    head && KNOWN_SUBCOMMANDS.has(head) ? head : null;
  const tail = subcommand ? rawArgv.slice(1) : rawArgv;

  if (subcommand === "help") {
    printHelp();
    process.exit(0);
  }

  if (subcommand === "hooks") {
    await runHooksSubcommand(tail);
    return;
  }

  if (subcommand === "neo4j") {
    await runNeo4jSubcommand(tail);
    return;
  }

  if (subcommand === "mcp") {
    if (tail[0] === "install") {
      await runMcpInstall(tail.slice(1));
      return;
    }
    // `codelens mcp [--neo4j-uri ... --neo4j-user ... --neo4j-password ...]`
    const args = parseArgs(tail);
    await runMcpServerFromArgs(args);
    return; // server keeps process alive via stdio + signal handlers
  }

  // No subcommand, or `index`: parse flags and run the legacy pipeline.
  const args = parseArgs(tail);

  // Legacy --mcp flag (still supported as an alias for `codelens mcp`).
  if (args.mcp) {
    await runMcpServerFromArgs(args);
    return;
  }

  // Cluster-only mode: skip analyze/index/embed/search; just re-cluster.
  if (args.clusterOnly) {
    await runClusterOnly(args);
    return;
  }

  // Search-only mode: no repo path needed.
  const searchOnly = !args.repo && !!args.searchQuery;
  if (!args.repo && !searchOnly) {
    printHelp();
    process.exit(1);
  }

  if (searchOnly) {
    await runSearch(args);
    return;
  }

  // Repo source resolution — accepts a path or a git URL. If URL, clones into
  // ~/.code-lens-aI/cache/ and rewrites args.repo to point there.
  const resolved = resolveSource(args.repo);
  args.repo = resolved.localPath;
  const sourceUrl = resolved.sourceUrl;

  // Incremental mode runs its own pipeline: scan, diff, scoped delete, partial
  // re-extract, push, then re-resolve. Returns early so the full-walk path
  // below doesn't run.
  if (args.incremental) {
    await runIncremental(args, sourceUrl);
    return;
  }

  console.error(`[codelens] analysing ${path.resolve(args.repo)} ...`);
  await reportGrammarLoad(args.repo, args.ignore);
  const graph = analyzeRepository(args.repo, {
    ignore: args.ignore,
    resolveCallsByName: !args.noResolveCalls,
  });

  if (args.stats) {
    const counts: Record<string, number> = {};
    for (const n of graph.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
    const eCounts: Record<string, number> = {};
    for (const e of graph.edges) eCounts[e.kind] = (eCounts[e.kind] ?? 0) + 1;
    console.error("[codelens] node counts:", counts);
    console.error("[codelens] edge counts:", eCounts);
    reportCallResolution(graph);
  }

  // ── JSON output ─────────────────────────────────────────────────────
  if (!args.noJson) {
    // Strip the live graphlib reference from the JSON payload.
    const payload = { nodes: graph.nodes, edges: graph.edges };
    const json = args.pretty
      ? JSON.stringify(payload, null, 2)
      : JSON.stringify(payload);

    if (args.out) {
      const outPath = path.resolve(args.out);
      fs.writeFileSync(outPath, json, "utf8");
      console.error(`[codelens] wrote ${outPath}`);
    } else if (!args.neo4jUri) {
      // Only stream to stdout if we're not also writing to neo4j (keeps logs clean).
      process.stdout.write(json + "\n");
    }
  }

  // ── Neo4j indexing ─────────────────────────────────────────────────
  if (args.neo4jUri) {
    if (!args.neo4jUser || !args.neo4jPassword) {
      console.error(
        "[codelens] --neo4j-uri requires --neo4j-user and --neo4j-password (or NEO4J_USER / NEO4J_PASSWORD env vars)",
      );
      process.exit(2);
    }
    console.error(`[codelens] indexing into Neo4j at ${args.neo4jUri} ...`);
    const result = await indexToNeo4j(graph, {
      uri: args.neo4jUri,
      user: args.neo4jUser,
      password: args.neo4jPassword,
      database: args.neo4jDatabase,
      clear: args.neo4jClear,
      skipUnresolved: args.neo4jSkipUnresolved,
    });
    console.error(
      `[codelens] indexed ${result.nodesWritten} nodes, ${result.edgesWritten} edges`,
    );
  }

  // ── Leiden clustering ──────────────────────────────────────────────
  if (args.cluster) {
    if (!args.neo4jUri || !args.neo4jUser || !args.neo4jPassword) {
      console.error(
        "[codelens] --cluster requires Neo4j credentials (--neo4j-uri / --neo4j-user / --neo4j-password)",
      );
      process.exit(2);
    }
    console.error("[codelens] running Leiden clustering ...");
    const report = await clusterInNeo4j({
      uri: args.neo4jUri,
      user: args.neo4jUser,
      password: args.neo4jPassword,
      database: args.neo4jDatabase,
      clear: args.clusterClear,
      spinePagerank: args.clusterSpinePagerank,
      spineBoundary: args.clusterSpineBoundary,
      minSize: args.clusterMinSize,
    });
    console.error(
      `[codelens] clusters: ${report.communities} found, ` +
        `${report.materialized} materialized (size >= ${args.clusterMinSize ?? 3}), ` +
        `${report.spineNodes} spine files (${report.filesScored} files scored)`,
    );
  }

  // ── Embeddings ─────────────────────────────────────────────────────
  if (args.embed) {
    if (!args.neo4jUri || !args.neo4jUser || !args.neo4jPassword) {
      console.error(
        "[codelens] --embed requires Neo4j credentials (--neo4j-uri / --neo4j-user / --neo4j-password)",
      );
      process.exit(2);
    }
    console.error("[codelens] computing embeddings ...");
    const report = await computeAndStoreEmbeddings({
      uri: args.neo4jUri,
      user: args.neo4jUser,
      password: args.neo4jPassword,
      database: args.neo4jDatabase,
      model: args.embedModel,
      batchSize: args.embedBatch,
    });
    console.error(
      `[codelens] embedded ${report.embedded}/${report.totalCandidates} nodes ` +
        `(skipped ${report.skipped}) in ${(report.durationMs / 1000).toFixed(1)}s`,
    );
  }

  // ── Search ─────────────────────────────────────────────────────────
  if (args.searchQuery) {
    await runSearch(args);
  }
}

/**
 * Incremental indexing pipeline. Two change-detection modes:
 *   - Mode A (git): use `git diff` + `git status` to identify dirty files.
 *   - Mode B (hash): sha256 each walked file, compare to stored f.contentHash.
 * After identifying the dirty set, cascade to dependents (importers + callers
 * into the changed files) so CALLS edges from unchanged callers stay correct,
 * scope-delete the affected subgraphs, partially re-extract, then push.
 */
async function runIncremental(
  args: CliArgs,
  sourceUrl: string | undefined,
): Promise<void> {
  if (!args.neo4jUri || !args.neo4jUser || !args.neo4jPassword) {
    console.error(
      "[codelens] --incremental requires Neo4j credentials (--neo4j-uri / --neo4j-user / --neo4j-password)",
    );
    process.exit(2);
  }
  const ctx: IncrementalCtx = {
    uri: args.neo4jUri,
    user: args.neo4jUser,
    password: args.neo4jPassword,
    database: args.neo4jDatabase,
  };
  const absRepo = path.resolve(args.repo);
  const indexedAt = new Date().toISOString();

  // ── Step 1: detect change-detection mode ────────────────────────────
  const repoMeta = await getRepositoryMeta(ctx, absRepo);
  const useGit = isGitRepo(absRepo);
  const headCommit = useGit ? gitHeadCommit(absRepo) : null;

  // Fast path: git repo, prior commit known + reachable, working tree clean.
  if (
    useGit &&
    repoMeta?.lastCommit &&
    headCommit &&
    repoMeta.lastCommit === headCommit &&
    gitWorkingTreeClean(absRepo)
  ) {
    console.error(
      `[codelens] already up to date at ${headCommit.slice(0, 12)} (commit + clean tree)`,
    );
    return;
  }

  // ── Step 2: compute raw delta ───────────────────────────────────────
  let changed: string[] = [];
  let added: string[] = [];
  let deleted: string[] = [];
  let modeUsed: "git" | "hash" | "cold" = "cold";

  const useGitDelta =
    useGit &&
    !!repoMeta?.lastCommit &&
    !!headCommit &&
    gitIsAncestor(absRepo, repoMeta.lastCommit);

  if (useGitDelta) {
    modeUsed = "git";
    const committed = gitCommitDelta(absRepo, repoMeta!.lastCommit!);
    const working: GitDelta = gitWorkingTreeDelta(absRepo);
    const merged = mergeDeltas(committed, working);
    // Keep only files we'd actually index (have a detectable language).
    const scan = scanRepository(absRepo, { ignore: args.ignore });
    const indexable = new Set(scan.files.map((f) => f.absPath));
    changed = merged.changed.filter((p) => indexable.has(p));
    added = merged.added.filter((p) => indexable.has(p));
    deleted = merged.deleted; // may include files not in `indexable` — we still need to clean them up by path
    console.error(
      `[codelens] git delta: ${changed.length} changed, ${added.length} added, ${deleted.length} deleted`,
    );
  } else {
    // Mode B (hash) — also handles cold cache (no prior repo meta).
    const isCold = !repoMeta;
    modeUsed = isCold ? "cold" : "hash";
    const scan = scanRepository(absRepo, { ignore: args.ignore, withHashes: true });
    const onDisk = new Map<string, string>(); // absPath → hash
    const langByPath = new Map<string, string>();
    for (const f of scan.files) {
      if (f.hash) onDisk.set(f.absPath, f.hash);
      langByPath.set(f.absPath, f.language);
    }
    const stored = isCold ? new Map<string, string>() : await getFileHashes(ctx, absRepo);
    for (const [p, h] of onDisk) {
      const prev = stored.get(p);
      if (prev === undefined) added.push(p);
      else if (prev !== h) changed.push(p);
    }
    for (const p of stored.keys()) {
      if (!onDisk.has(p)) deleted.push(p);
    }
    console.error(
      `[codelens] ${modeUsed} delta: ${changed.length} changed, ${added.length} added, ${deleted.length} deleted`,
    );
  }

  if (changed.length + added.length + deleted.length === 0) {
    console.error("[codelens] no changes detected");
    await setRepositoryMeta(ctx, absRepo, {
      indexedAt,
      lastCommit: headCommit,
      sourceUrl,
    });
    return;
  }

  // ── Step 3: dependents cascade ──────────────────────────────────────
  // Look up files that import or call into the changed/deleted set so their
  // stale CALLS edges get re-resolved against the new node IDs.
  const cascadeSeed = [...changed, ...deleted];
  const dependents = await getDependents(ctx, cascadeSeed);
  for (const p of changed) dependents.delete(p);
  for (const p of added) dependents.delete(p);
  console.error(
    `[codelens] cascade: ${dependents.size} dependent file(s) will be re-extracted`,
  );

  // Final dirty set: files we'll re-extract from disk.
  const toExtract = new Set<string>([...changed, ...added, ...dependents]);
  // Files whose graph subtree we'll DETACH DELETE before writing new state.
  const toDelete = new Set<string>([...changed, ...dependents, ...deleted]);

  // ── Step 4: scope-delete old subgraphs ──────────────────────────────
  if (toDelete.size > 0) {
    const { deletedNodes } = await deleteFilesByPath(ctx, [...toDelete]);
    console.error(
      `[codelens] scope-deleted ${deletedNodes} symbol+file node(s) across ${toDelete.size} file(s)`,
    );
  }

  // ── Step 5: re-extract dirty files ──────────────────────────────────
  const hashesForExtract = new Map<string, string>();
  if (modeUsed === "git") {
    // We didn't compute hashes in git mode; compute them now for the extract set
    // so File nodes always carry an up-to-date hash (Mode B fallback works later).
    const { sha256OfFile } = await import("./util/hash");
    for (const p of toExtract) {
      try {
        hashesForExtract.set(p, sha256OfFile(p));
      } catch {
        // missing file — should already be in `deleted` set; skip
      }
    }
  } else {
    // Hash mode already scanned with hashes; re-scan to recover the map.
    const rescan = scanRepository(absRepo, { ignore: args.ignore, withHashes: true });
    for (const f of rescan.files) {
      if (toExtract.has(f.absPath) && f.hash) hashesForExtract.set(f.absPath, f.hash);
    }
  }

  let graphSummary = { nodesWritten: 0, edgesWritten: 0 };
  if (toExtract.size > 0) {
    console.error(
      `[codelens] extracting ${toExtract.size} file(s) ...`,
    );
    await reportGrammarLoad(absRepo, args.ignore);
    const graph = analyzeIncremental(absRepo, {
      ignore: args.ignore,
      resolveCallsByName: !args.noResolveCalls,
      extractOnly: toExtract,
      hashes: hashesForExtract,
      indexedAt,
    });

    if (args.stats) {
      const counts: Record<string, number> = {};
      for (const n of graph.nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
      const eCounts: Record<string, number> = {};
      for (const e of graph.edges) eCounts[e.kind] = (eCounts[e.kind] ?? 0) + 1;
      console.error("[codelens] node counts:", counts);
      console.error("[codelens] edge counts:", eCounts);
      reportCallResolution(graph);
    }

    // Push without --neo4j-clear; MERGE semantics handle the partial graph.
    graphSummary = await indexToNeo4j(graph, {
      uri: args.neo4jUri,
      user: args.neo4jUser,
      password: args.neo4jPassword,
      database: args.neo4jDatabase,
      clear: false,
      skipUnresolved: args.neo4jSkipUnresolved,
    });
    console.error(
      `[codelens] pushed ${graphSummary.nodesWritten} nodes, ${graphSummary.edgesWritten} edges`,
    );
  }

  // ── Step 6: stamp repo meta ─────────────────────────────────────────
  await setRepositoryMeta(ctx, absRepo, {
    indexedAt,
    lastCommit: headCommit,
    sourceUrl,
  });

  // ── Optional clustering / embeddings ────────────────────────────────
  if (args.cluster) {
    console.error("[codelens] running Leiden clustering ...");
    const report = await clusterInNeo4j({
      uri: args.neo4jUri,
      user: args.neo4jUser,
      password: args.neo4jPassword,
      database: args.neo4jDatabase,
      clear: args.clusterClear,
      spinePagerank: args.clusterSpinePagerank,
      spineBoundary: args.clusterSpineBoundary,
      minSize: args.clusterMinSize,
    });
    console.error(
      `[codelens] clusters: ${report.communities} found, ` +
        `${report.materialized} materialized (size >= ${args.clusterMinSize ?? 3}), ` +
        `${report.spineNodes} spine files (${report.filesScored} files scored)`,
    );
  }
  if (args.embed) {
    console.error("[codelens] computing embeddings ...");
    const report = await computeAndStoreEmbeddings({
      uri: args.neo4jUri,
      user: args.neo4jUser,
      password: args.neo4jPassword,
      database: args.neo4jDatabase,
      model: args.embedModel,
      batchSize: args.embedBatch,
    });
    console.error(
      `[codelens] embedded ${report.embedded}/${report.totalCandidates} nodes ` +
        `(skipped ${report.skipped}) in ${(report.durationMs / 1000).toFixed(1)}s`,
    );
  }
}

async function runClusterOnly(args: CliArgs): Promise<void> {
  if (!args.neo4jUri || !args.neo4jUser || !args.neo4jPassword) {
    console.error(
      "[codelens] --cluster-only requires Neo4j credentials (--neo4j-uri / --neo4j-user / --neo4j-password)",
    );
    process.exit(2);
  }
  console.error("[codelens] running Leiden clustering against existing graph ...");
  const report = await clusterInNeo4j({
    uri: args.neo4jUri,
    user: args.neo4jUser,
    password: args.neo4jPassword,
    database: args.neo4jDatabase,
    clear: args.clusterClear,
    spinePagerank: args.clusterSpinePagerank,
    spineBoundary: args.clusterSpineBoundary,
    minSize: args.clusterMinSize,
  });
  console.error(
    `[codelens] clusters: ${report.communities} found, ` +
      `${report.materialized} materialized (size >= ${args.clusterMinSize ?? 3}), ` +
      `${report.spineNodes} spine files (${report.filesScored} files scored)`,
  );
}

async function runSearch(args: CliArgs): Promise<void> {
  if (!args.neo4jUri || !args.neo4jUser || !args.neo4jPassword) {
    console.error(
      "[codelens] --search requires Neo4j credentials (--neo4j-uri / --neo4j-user / --neo4j-password)",
    );
    process.exit(2);
  }
  const driver = neo4j.driver(
    args.neo4jUri,
    neo4j.auth.basic(args.neo4jUser, args.neo4jPassword),
  );
  try {
    console.error(
      `[codelens] search "${args.searchQuery}" ` +
        `(mode=${args.searchMode ?? "auto"}, limit=${args.searchLimit ?? 20})`,
    );
    const hits = await search(driver, args.searchQuery!, {
      mode: args.searchMode,
      limit: args.searchLimit,
      database: args.neo4jDatabase,
    });
    if (hits.length === 0) {
      console.error("[codelens] no hits");
      return;
    }
    for (const hit of hits) {
      const score = hit.score.toFixed(4);
      const matched = hit.matchedBy.join("+");
      const loc = hit.path
        ? `${hit.path}:${(hit.startRow ?? 0) + 1}`
        : "(no path)";
      console.log(`[${matched} ${score}]  ${hit.kind}  ${hit.name}`);
      console.log(`    ${loc}`);
      if (hit.signature) {
        console.log(`    ${hit.signature.split("\n")[0].trim()}`);
      }
    }
  } finally {
    await driver.close();
  }
}

main().catch((err: unknown) => {
  console.error("[codelens] error:", err instanceof Error ? err.stack : err);
  process.exit(1);
});

/**
 * Preload the grammars this repo needs and tell the user which languages could
 * not be loaded, so a missing optional grammar is visible rather than silently
 * shrinking the graph.
 */
async function reportGrammarLoad(
  repoPath: string,
  ignore: string[] | undefined,
): Promise<void> {
  const { loaded, failed } = await preloadRepositoryGrammars(repoPath, { ignore });
  if (loaded.length > 0) {
    console.error(`[codelens] grammars ready: ${loaded.sort().join(", ")}`);
  }
  for (const { language, reason } of failed) {
    console.error(`[codelens] ${language} unavailable — ${reason}`);
  }
}

/**
 * Report how much of the call graph is actually resolved, and how confidently.
 *
 * Every downstream feature — impact analysis, spine selection, the wiki — is
 * only as trustworthy as this number, so it is printed rather than left to be
 * assumed. Unbound calls are mostly calls into external libraries and are
 * expected; the figure worth watching is the ambiguous share, which counts
 * bindings picked from several same-named declarations.
 */
function reportCallResolution(graph: { edges: { kind: string; source?: string; unresolved?: string }[] }): void {
  const calls = graph.edges.filter((e) => e.kind === "CALLS");
  if (calls.length === 0) return;

  const bySource: Record<string, number> = {};
  for (const e of calls) {
    const key = e.unresolved ? "unbound" : (e.source ?? "unknown");
    bySource[key] = (bySource[key] ?? 0) + 1;
  }
  const bound = calls.length - (bySource.unbound ?? 0);
  const high =
    (bySource.static ?? 0) +
    (bySource.via_imports ?? 0) +
    (bySource.via_reexport ?? 0);
  const ambiguous = bySource.name_only_ambiguous ?? 0;
  const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((100 * n) / d));

  console.error(
    `[codelens] call resolution: ${bound}/${calls.length} bound (${pct(bound, calls.length)}%) — ` +
      `${pct(high, bound)}% high-confidence, ${pct(ambiguous, bound)}% ambiguous-name`,
  );
  console.error("[codelens] call confidence:", bySource);
}
