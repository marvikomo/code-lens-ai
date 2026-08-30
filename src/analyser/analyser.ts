import fs from "fs";
import path from "path";
import {
  GraphBuilder,
  GraphNode,
  CodeGraph,
  NodeKind,
  EdgeSource,
} from "../util/graph";
import { detectLanguage, SupportedLanguage } from "../util/language";
import {
  getParser,
  GrammarUnavailableError,
  preloadGrammars,
} from "./../util/parserFactory";
import { ExtractContext, LanguageExtractor } from "../extractor/base";
import { JsTsExtractor } from "../extractor/jsts";
import { JavaExtractor } from "../extractor/java";
import { GenericExtractor } from "../extractor/generic";
import { LANGUAGE_CONFIGS } from "../extractor/configs";
import { sha256OfFile } from "../util/hash";

export interface AnalyzeOptions {
  /** Folder/file names to ignore. Defaults to common build artefacts. */
  ignore?: string[];
  /** Whether to attempt to resolve unresolved CALLS to local Function/Method nodes by name. */
  resolveCallsByName?: boolean;
}

export interface ScanEntry {
  absPath: string;
  language: SupportedLanguage;
  /** sha256 hex; only populated when `withHashes` is true. */
  hash?: string;
}

export interface RepoScan {
  absRepo: string;
  files: ScanEntry[];
}

export interface IncrementalAnalyzeOptions extends AnalyzeOptions {
  /** File paths to actually parse + extract. Other files exist as path-only references. */
  extractOnly: Set<string>;
  /** Pre-computed sha256 hashes by absolute path (only stamped on extracted files). */
  hashes?: Map<string, string>;
  /** ISO timestamp to stamp on extracted File nodes' `lastIndexed`. */
  indexedAt: string;
}

const DEFAULT_IGNORES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  ".next",
  "coverage",
]);

/**
 * Load the grammars a repository actually needs, before the (synchronous)
 * analysis walk starts.
 *
 * Two grammars are ESM-only, so they can only be loaded by an async dynamic
 * import — hence a separate preload step rather than lazy loading inside the
 * walk. Only the languages present in the tree are loaded, so indexing a pure
 * TypeScript repo does not pay for twenty native addons.
 */
export async function preloadRepositoryGrammars(
  repoPath: string,
  opts: AnalyzeOptions = {},
): Promise<{
  loaded: SupportedLanguage[];
  failed: { language: SupportedLanguage; reason: string }[];
}> {
  const scan = scanRepository(repoPath, { ignore: opts.ignore });
  const languages = Array.from(new Set(scan.files.map((f) => f.language)));
  return preloadGrammars(languages);
}

export function analyzeRepository(
  repoPath: string,
  opts: AnalyzeOptions = {},
): CodeGraph {
  const absRepo = path.resolve(repoPath);
  const stat = fs.statSync(absRepo);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${absRepo}`);
  }

  const ignores = new Set([...DEFAULT_IGNORES, ...(opts.ignore ?? [])]);
  const builder = new GraphBuilder();

  // Repository node. lastIndexed stamped at extract time so the standard
  // (`--neo4j-clear --cluster`) flow surfaces a freshness signal, not just
  // the incremental flow. Incremental's setRepositoryMeta will overwrite
  // with a fractionally-newer write-time timestamp — also fine.
  const repoName = path.basename(absRepo);
  const repoNode = builder.addNode({
    id: `repo:${absRepo}`,
    kind: "Repository",
    name: repoName,
    path: absRepo,
    lastIndexed: new Date().toISOString(),
  });

  // Walk filesystem.  Track folder→nodeId map so we can wire CONTAINS edges.
  const pendingImports: ExtractContext["pendingImports"] = [];
  const fileNodesByAbsPath = new Map<string, GraphNode>();

  const walkDir = (dir: string, parentNode: GraphNode): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignores.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const folder = builder.addNode({
          id: `folder:${full}`,
          kind: "Folder",
          name: entry.name,
          path: full,
        });
        builder.addEdge({
          kind: "CONTAINS",
          from: parentNode.id,
          to: folder.id,
        });
        walkDir(full, folder);
      } else if (entry.isFile()) {
        const lang = detectLanguage(full);
        if (!lang) continue;
        // Stamp contentHash on every File regardless of indexing path
        // (incremental computes hashes for its own purposes; non-incremental
        // didn't until now, leaving the freshness/staleness checks blind).
        // Cheap — one sha256 per file at index time.
        let contentHash: string | undefined;
        try { contentHash = sha256OfFile(full); } catch { /* unreadable; skip */ }
        const fileNode = builder.addNode({
          id: `file:${full}`,
          kind: "File",
          name: entry.name,
          path: full,
          language: lang,
          contentHash,
        });
        builder.addEdge({
          kind: "CONTAINS",
          from: parentNode.id,
          to: fileNode.id,
        });
        fileNodesByAbsPath.set(full, fileNode);
        analyzeFile(full, lang, fileNode, builder, pendingImports);
      }
    }
  };

  walkDir(absRepo, repoNode);

  // Resolve imports → File nodes when possible.
  resolveImports(pendingImports, fileNodesByAbsPath, builder);

  // Cross-file class/interface inheritance: bind unresolved EXTENDS/IMPLEMENTS
  // edges to real Class/Interface nodes by name lookup, disambiguated via
  // the IMPORTS edges we just resolved.
  resolveTypeRefsByName(builder);

  // Optional: collapse unresolved CALLS that match a Function/Method name in the same file or repo.
  if (opts.resolveCallsByName !== false) {
    resolveCallsByName(builder);
  }

  return builder.build();
}

/**
 * Walk the repo and enumerate every supported source file. No parsing — this
 * is the cheap pre-flight pass used by the incremental indexer to compute
 * the dirty set vs. stored hashes.
 */
export function scanRepository(
  repoPath: string,
  opts: { ignore?: string[]; withHashes?: boolean } = {},
): RepoScan {
  const absRepo = path.resolve(repoPath);
  const stat = fs.statSync(absRepo);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${absRepo}`);

  const ignores = new Set([...DEFAULT_IGNORES, ...(opts.ignore ?? [])]);
  const files: ScanEntry[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignores.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const lang = detectLanguage(full);
        if (!lang) continue;
        const e: ScanEntry = { absPath: full, language: lang };
        if (opts.withHashes) {
          try {
            e.hash = sha256OfFile(full);
          } catch {
            // Unreadable file — skip silently; it'll still be tracked by path.
          }
        }
        files.push(e);
      }
    }
  };

  walk(absRepo);
  return { absRepo, files };
}

/**
 * Incremental version of `analyzeRepository`: parses + extracts ONLY the
 * files in `opts.extractOnly`, while still emitting Repository + Folder
 * skeletons so CONTAINS edges resolve. Cross-file IMPORTS are resolvable
 * because we feed the resolver every File path in the repo (extracted
 * files own real builder nodes; unchanged files appear as phantom path-only
 * entries that map to Neo4j IDs which already exist from prior runs).
 */
export function analyzeIncremental(
  repoPath: string,
  opts: IncrementalAnalyzeOptions,
): CodeGraph {
  const absRepo = path.resolve(repoPath);
  const stat = fs.statSync(absRepo);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${absRepo}`);

  const ignores = new Set([...DEFAULT_IGNORES, ...(opts.ignore ?? [])]);
  const builder = new GraphBuilder();

  const repoNode = builder.addNode({
    id: `repo:${absRepo}`,
    kind: "Repository",
    name: path.basename(absRepo),
    path: absRepo,
    // analyzeIncremental's caller (cli.runIncremental) overrides this via
    // setRepositoryMeta after the write — so the eventual stored timestamp
    // matches write time. Setting here ensures cold/non-incremental flows
    // also get a usable freshness signal.
    lastIndexed: opts.indexedAt,
  });

  const pendingImports: ExtractContext["pendingImports"] = [];
  const fileNodesByAbsPath = new Map<string, GraphNode>();

  // Walk the tree. For files in `extractOnly`: real File nodes + analyseFile.
  // For other files: phantom GraphNode (id+path only) for import resolution —
  // never added to the builder so they don't get re-written to Neo4j.
  const walk = (dir: string, parentNode: GraphNode): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignores.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const folder = builder.addNode({
          id: `folder:${full}`,
          kind: "Folder",
          name: entry.name,
          path: full,
        });
        builder.addEdge({
          kind: "CONTAINS",
          from: parentNode.id,
          to: folder.id,
        });
        walk(full, folder);
      } else if (entry.isFile()) {
        const lang = detectLanguage(full);
        if (!lang) continue;

        if (opts.extractOnly.has(full)) {
          const fileNode = builder.addNode({
            id: `file:${full}`,
            kind: "File",
            name: entry.name,
            path: full,
            language: lang,
            contentHash: opts.hashes?.get(full),
            lastIndexed: opts.indexedAt,
          });
          builder.addEdge({
            kind: "CONTAINS",
            from: parentNode.id,
            to: fileNode.id,
          });
          fileNodesByAbsPath.set(full, fileNode);
          analyzeFile(full, lang, fileNode, builder, pendingImports);
        } else {
          // Phantom — used for resolution lookups only.
          fileNodesByAbsPath.set(full, {
            id: `file:${full}`,
            kind: "File",
            name: entry.name,
            path: full,
            language: lang,
          });
        }
      }
    }
  };

  walk(absRepo, repoNode);

  resolveImports(pendingImports, fileNodesByAbsPath, builder);
  resolveTypeRefsByName(builder);
  if (opts.resolveCallsByName !== false) resolveCallsByName(builder);

  return builder.build();
}

function analyzeFile(
  filePath: string,
  language: SupportedLanguage,
  fileNode: GraphNode,
  builder: GraphBuilder,
  pendingImports: ExtractContext["pendingImports"],
): void {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  let parser;
  try {
    parser = getParser(language);
  } catch (err) {
    // A grammar that is missing, unbuilt, or ABI-incompatible costs us that
    // language, not the run. Reported once per language.
    if (err instanceof GrammarUnavailableError) {
      warnLanguageOnce(
        language,
        `[codelens] skipping ${language} files: ${err.message}`,
      );
      return;
    }
    throw err;
  }

  let tree;
  try {
    // node-tree-sitter's default internal buffer is 32 KiB; pass an explicit
    // bufferSize so files larger than that still parse cleanly.
    tree = parser.parse(source, undefined, {
      bufferSize: Math.max(source.length + 1024, 32 * 1024),
    });
  } catch (err) {
    console.warn(`[codelens] parse failed for ${filePath}: ${(err as Error).message}`);
    return;
  }

  const extractor = pickExtractor(language);
  if (!extractor) {
    warnLanguageOnce(
      language,
      `[codelens] no extractor registered for ${language}; files skipped`,
    );
    return;
  }
  const ctx: ExtractContext = {
    builder,
    fileNode,
    filePath,
    language,
    pendingImports,
  };
  extractor.extract(tree.rootNode, ctx);
}

/**
 * Bespoke extractors for the four languages that have one, the config-driven
 * generic walker for everything else.
 *
 * Extractors are stateless, so instances are cached per language rather than
 * rebuilt for every file.
 */
const extractorCache = new Map<SupportedLanguage, LanguageExtractor>();

function pickExtractor(language: SupportedLanguage): LanguageExtractor | null {
  const cached = extractorCache.get(language);
  if (cached) return cached;

  let extractor: LanguageExtractor | null = null;
  switch (language) {
    case "java":
      extractor = new JavaExtractor();
      break;
    case "javascript":
    case "typescript":
    case "tsx":
      extractor = new JsTsExtractor();
      break;
    default: {
      const config = LANGUAGE_CONFIGS[language];
      extractor = config ? new GenericExtractor(config) : null;
    }
  }

  if (extractor) extractorCache.set(language, extractor);
  return extractor;
}

/**
 * Languages already reported as unparseable, so a repo with 400 .rs files and
 * no rust grammar produces one warning rather than 400.
 */
const warnedLanguages = new Set<SupportedLanguage>();

function warnLanguageOnce(language: SupportedLanguage, message: string): void {
  if (warnedLanguages.has(language)) return;
  warnedLanguages.add(language);
  console.warn(message);
}

const JS_EXT_PRIORITY = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
  "/index.jsx",
];

// TS NodeNext / "bundler" resolution: imports are written with the runtime
// extension (`.js`) but the on-disk file is `.ts`. Swap before falling back
// to extension-append candidates.
const JS_TO_TS_EXT_MAP: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx", ".ts"],
  ".mjs": [".mts", ".ts"],
  ".cjs": [".cts", ".ts"],
};

function resolveImports(
  pending: ExtractContext["pendingImports"],
  fileNodes: Map<string, GraphNode>,
  builder: GraphBuilder,
): void {
  const moduleIndex = buildModuleIndex(fileNodes);

  for (const imp of pending) {
    const fromNode = builder.getNode(imp.from);
    if (!fromNode || !fromNode.path) continue;

    const targetFile = resolveSpec(fromNode, imp.spec, fileNodes);

    // Non-relative module specifiers (`go.k6.io/k6/lib/netext`,
    // `graphify.extractors.base`) never look like a relative path, so the
    // JS-shaped resolver above returns nothing for them. Without this the
    // file-import graph is empty for most non-JS languages — k6 produced 6
    // IMPORTS edges across 3,482 files, which makes community detection and
    // spine selection meaningless there.
    if (!targetFile) {
      const moduleTargets = resolveModuleSpec(imp.spec, moduleIndex);
      if (moduleTargets.length > 0) {
        for (const target of moduleTargets) {
          if (target.id === fromNode.id) continue;
          builder.addEdge({
            kind: "IMPORTS",
            from: fromNode.id,
            to: target.id,
          });
        }
        continue;
      }
    }

    if (targetFile) {
      builder.addEdge({
        kind: "IMPORTS",
        from: fromNode.id,
        to: targetFile.id,
      });
      if (imp.reexport?.kind === "named") {
        builder.addEdge({
          kind: "REEXPORTS",
          from: fromNode.id,
          to: targetFile.id,
          meta: {
            localName: imp.reexport.localName,
            exportedName: imp.reexport.exportedName,
          },
        });
      } else if (imp.reexport?.kind === "all") {
        builder.addEdge({
          kind: "REEXPORTS_ALL",
          from: fromNode.id,
          to: targetFile.id,
        });
      }
    } else {
      builder.addEdge({
        kind: "IMPORTS",
        from: fromNode.id,
        to: `unresolved:module:${imp.spec}`,
        unresolved: imp.spec,
      });
      if (imp.reexport?.kind === "named") {
        builder.addEdge({
          kind: "REEXPORTS",
          from: fromNode.id,
          to: `unresolved:module:${imp.spec}`,
          unresolved: imp.spec,
          meta: {
            localName: imp.reexport.localName,
            exportedName: imp.reexport.exportedName,
          },
        });
      } else if (imp.reexport?.kind === "all") {
        builder.addEdge({
          kind: "REEXPORTS_ALL",
          from: fromNode.id,
          to: `unresolved:module:${imp.spec}`,
          unresolved: imp.spec,
        });
      }
    }
  }
}

/**
 * Path-suffix index over indexed files, used to bind non-relative module
 * specifiers to files.
 *
 * Keyed by every trailing path fragment up to `MODULE_SUFFIX_DEPTH` segments,
 * both for files (extension stripped) and for their directories — a Go import
 * names a package directory, while a Python or Java one names a module file.
 */
interface ModuleIndex {
  readonly byFileSuffix: Map<string, GraphNode[]>;
  readonly byDirSuffix: Map<string, GraphNode[]>;
}

const MODULE_SUFFIX_DEPTH = 8;

/**
 * A suffix must be at least this many segments to bind.
 *
 * Single-segment specifiers are overwhelmingly standard library (`fmt`, `os`,
 * `strings`, `sys`), and binding those to a same-named repo file would invent
 * dependencies. The cost is missing a genuine single-module local import; the
 * conservative direction is the right one here.
 */
const MODULE_MIN_SEGMENTS = 2;

function buildModuleIndex(fileNodes: Map<string, GraphNode>): ModuleIndex {
  const byFileSuffix = new Map<string, GraphNode[]>();
  const byDirSuffix = new Map<string, GraphNode[]>();

  const push = (
    map: Map<string, GraphNode[]>,
    key: string,
    node: GraphNode,
  ): void => {
    const bucket = map.get(key);
    if (bucket) bucket.push(node);
    else map.set(key, [node]);
  };

  for (const [filePath, node] of fileNodes) {
    const ext = path.extname(filePath);
    const withoutExt = ext ? filePath.slice(0, -ext.length) : filePath;
    const segments = withoutExt.split(/[/\\]/).filter(Boolean);
    if (segments.length === 0) continue;

    const start = Math.max(0, segments.length - MODULE_SUFFIX_DEPTH);
    for (let i = start; i < segments.length; i++) {
      push(byFileSuffix, segments.slice(i).join("/"), node);
    }

    const dirSegments = segments.slice(0, -1);
    const dirStart = Math.max(0, dirSegments.length - MODULE_SUFFIX_DEPTH);
    for (let i = dirStart; i < dirSegments.length; i++) {
      push(byDirSuffix, dirSegments.slice(i).join("/"), node);
    }
  }

  return { byFileSuffix, byDirSuffix };
}

/**
 * Resolve a non-relative module specifier to the file(s) it names.
 *
 * Longest suffix wins, so `go.k6.io/k6/lib/netext` prefers the deepest
 * matching path before falling back to `lib/netext` and then `netext`.
 * A file match must be unique; a directory match must resolve to exactly one
 * directory, in which case every file in that package is a target — importing
 * a Go package does depend on all of it.
 *
 * Ambiguity yields nothing rather than a guess, matching how the type-reference
 * resolver treats competing candidates.
 */
function resolveModuleSpec(spec: string, index: ModuleIndex): GraphNode[] {
  const cleaned = spec.trim().replace(/\.\*$/, "").replace(/^["'`]|["'`]$/g, "");
  if (!cleaned) return [];

  // Path-shaped specifiers (Go, and anything quoting a path) keep their
  // slashes; dotted ones (Python, Java, Kotlin, Scala) split on the dot. A Go
  // specifier's leading domain segment contains dots, so splitting on both
  // would shred it.
  const segments = (cleaned.includes("/") ? cleaned.split("/") : cleaned.split("."))
    .map((seg) => seg.trim())
    .filter(Boolean);
  if (segments.length < MODULE_MIN_SEGMENTS) return [];

  for (let i = 0; i + MODULE_MIN_SEGMENTS <= segments.length; i++) {
    const key = segments.slice(i).join("/");

    const fileMatches = index.byFileSuffix.get(key);
    if (fileMatches && fileMatches.length === 1) return fileMatches;

    const dirMatches = index.byDirSuffix.get(key);
    if (dirMatches && dirMatches.length > 0) {
      const dirs = new Set(
        dirMatches.map((n) => (n.path ? path.dirname(n.path) : "")),
      );
      if (dirs.size === 1) return dirMatches;
    }
  }

  return [];
}

function resolveSpec(
  fromFile: GraphNode,
  spec: string,
  fileNodes: Map<string, GraphNode>,
): GraphNode | null {
  if (!fromFile.path) return null;

  // Relative JS/TS specifier
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const base = path.resolve(path.dirname(fromFile.path), spec);
    if (fileNodes.has(base)) return fileNodes.get(base)!;

    // NodeNext / bundler resolution: `./foo.js` → `./foo.ts` (or `.tsx`, …).
    const ext = path.extname(base);
    const swaps = JS_TO_TS_EXT_MAP[ext];
    if (swaps) {
      const stem = base.slice(0, -ext.length);
      for (const swap of swaps) {
        const candidate = stem + swap;
        if (fileNodes.has(candidate)) return fileNodes.get(candidate)!;
      }
    }

    for (const e of JS_EXT_PRIORITY) {
      const candidate = base + e;
      if (fileNodes.has(candidate)) return fileNodes.get(candidate)!;
    }
    return null;
  }

  // Java: dotted spec like `com.foo.Bar` -> look for a file path ending with `com/foo/Bar.java`
  if (fromFile.language === "java") {
    const cleaned = spec.replace(/\.\*$/, "");
    const sub = cleaned.split(".").join(path.sep) + ".java";
    for (const [p, node] of fileNodes) {
      if (p.endsWith(path.sep + sub) || p.endsWith(sub)) return node;
    }
  }

  return null;
}

/**
 * Pre-built lookup index for the IMPORTS→EXPORTS resolution algorithm
 * described in the symbol-aliasing problem brief (Phase 1).
 *
 * - `fileImports`: callerFileId → set of imported fileIds (file-level deps)
 * - `exportsByFileAndName`: "fileId|exportedName" → exported declaration node
 *
 * Built once per analyser pass and reused across resolveCallsByName +
 * resolveTypeRefsByName.
 */
interface ImportExportIndex {
  fileImports: Map<string, Set<string>>;
  exportsByFileAndName: Map<string, GraphNode>;
  reexportsByFileAndName: Map<string, { fileId: string; localName: string }[]>;
  reexportAllByFile: Map<string, Set<string>>;
}

function buildImportExportIndex(builder: GraphBuilder): ImportExportIndex {
  const graph = builder.build();
  const fileImports = new Map<string, Set<string>>();
  const exportsByFileAndName = new Map<string, GraphNode>();
  const reexportsByFileAndName = new Map<
    string,
    { fileId: string; localName: string }[]
  >();
  const reexportAllByFile = new Map<string, Set<string>>();

  for (const e of graph.edges) {
    if (e.kind === "IMPORTS") {
      const fromNode = builder.getNode(e.from);
      const toNode = builder.getNode(e.to);
      if (
        fromNode?.kind === "File" &&
        toNode?.kind === "File"
      ) {
        const set = fileImports.get(e.from) ?? new Set<string>();
        set.add(e.to);
        fileImports.set(e.from, set);
      }
    } else if (e.kind === "EXPORTS") {
      const exportedName = e.meta?.exportedName as string | undefined;
      if (!exportedName) continue;
      const target = builder.getNode(e.to);
      if (!target) continue;
      exportsByFileAndName.set(`${e.from}|${exportedName}`, target);
    } else if (e.kind === "REEXPORTS") {
      const targetFile = builder.getNode(e.to);
      if (targetFile?.kind !== "File") continue;
      const localName = e.meta?.localName as string | undefined;
      const exportedName = e.meta?.exportedName as string | undefined;
      if (!localName || !exportedName) continue;
      const key = `${e.from}|${exportedName}`;
      const arr = reexportsByFileAndName.get(key) ?? [];
      arr.push({ fileId: e.to, localName });
      reexportsByFileAndName.set(key, arr);
    } else if (e.kind === "REEXPORTS_ALL") {
      const targetFile = builder.getNode(e.to);
      if (targetFile?.kind !== "File") continue;
      const set = reexportAllByFile.get(e.from) ?? new Set<string>();
      set.add(e.to);
      reexportAllByFile.set(e.from, set);
    }
  }

  return {
    fileImports,
    exportsByFileAndName,
    reexportsByFileAndName,
    reexportAllByFile,
  };
}

interface FollowResult {
  target: GraphNode;
  source: EdgeSource;
}

function followExportFromFile(
  index: ImportExportIndex,
  fileId: string,
  name: string,
  kindFilter: ReadonlySet<NodeKind>,
  visited = new Set<string>(),
): FollowResult | null {
  const visitKey = `${fileId}|${name}`;
  if (visited.has(visitKey)) return null;
  visited.add(visitKey);

  const direct = index.exportsByFileAndName.get(`${fileId}|${name}`);
  if (direct && kindFilter.has(direct.kind)) {
    return { target: direct, source: "via_imports" };
  }

  const named = index.reexportsByFileAndName.get(`${fileId}|${name}`) ?? [];
  const matches: FollowResult[] = [];
  for (const reexport of named) {
    const result = followExportFromFile(
      index,
      reexport.fileId,
      reexport.localName,
      kindFilter,
      new Set(visited),
    );
    if (result) matches.push({ target: result.target, source: "via_reexport" });
  }

  const starFiles = index.reexportAllByFile.get(fileId);
  if (starFiles) {
    for (const reexportedFileId of starFiles) {
      const result = followExportFromFile(
        index,
        reexportedFileId,
        name,
        kindFilter,
        new Set(visited),
      );
      if (result) matches.push({ target: result.target, source: "via_reexport" });
    }
  }

  const unique = new Map<string, FollowResult>();
  for (const match of matches) keepBestFollowResult(unique, match);
  return unique.size === 1 ? [...unique.values()][0] : null;
}

/**
 * The Phase-1 `follow()` core: given a caller's file and a name, walk the
 * caller's IMPORTS edges and check each imported file's EXPORTS for a
 * matching name. Returns the unique matching declaration if found,
 * otherwise null. Phase 2/3 will extend this to follow REEXPORTS and
 * REEXPORTS_ALL chains transitively; for now it's a single-hop lookup.
 *
 * `kindFilter` restricts results to specific node kinds (e.g. Function/Method
 * for CALLS resolution, Class/Interface for inheritance). Caller passes the
 * set of acceptable kinds; the lookup ignores exports of other kinds.
 */
function followViaImports(
  index: ImportExportIndex,
  callerFileId: string,
  name: string,
  kindFilter: ReadonlySet<NodeKind>,
): FollowResult | null {
  const importedFiles = index.fileImports.get(callerFileId);
  if (!importedFiles) return null;
  const matches: FollowResult[] = [];
  for (const importedFileId of importedFiles) {
    const result = followExportFromFile(
      index,
      importedFileId,
      name,
      kindFilter,
    );
    if (result) matches.push(result);
  }
  // Single unique match wins. Multiple matches → ambiguous, fall back to
  // caller's other heuristics rather than guessing here.
  const unique = new Map<string, FollowResult>();
  for (const match of matches) keepBestFollowResult(unique, match);
  return unique.size === 1 ? [...unique.values()][0] : null;
}

function keepBestFollowResult(
  byTargetId: Map<string, FollowResult>,
  next: FollowResult,
): void {
  const existing = byTargetId.get(next.target.id);
  if (!existing || confidenceRank(next.source) < confidenceRank(existing.source)) {
    byTargetId.set(next.target.id, next);
  }
}

function confidenceRank(source: EdgeSource): number {
  switch (source) {
    case "static":
      return 0;
    case "via_imports":
      return 1;
    case "via_reexport":
      return 2;
    case "name_only":
      return 3;
    case "name_only_ambiguous":
      return 4;
    case "dynamic":
      return 5;
  }
}

const CALLABLE_KINDS: ReadonlySet<NodeKind> = new Set(["Function", "Method"]);

function resolveCallsByName(builder: GraphBuilder): void {
  const graph = builder.build();
  // index callable nodes by name
  const byName = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (n.kind === "Function" || n.kind === "Method") {
      const arr = byName.get(n.name) ?? [];
      arr.push(n);
      byName.set(n.name, arr);
    }
  }

  // Phase 1: import-aware disambiguation. Built once for this pass.
  const ieIndex = buildImportExportIndex(builder);

  for (const edge of graph.edges) {
    if (edge.kind !== "CALLS") continue;
    if (!edge.unresolved) continue;

    const fromNode = builder.getNode(edge.from);
    const callerFileId = fromNode?.path ? `file:${fromNode.path}` : null;

    // Preference order: (1) IMPORTS→EXPORTS unique match (the new path),
    // (2) candidate defined in the same file as the caller, (3) first
    // candidate. (1) wins because the caller's import statement is the
    // strongest signal of which same-named function it actually meant.
    let target: GraphNode | undefined;
    let source: EdgeSource = "name_only";
    if (callerFileId) {
      const viaImports = followViaImports(
        ieIndex,
        callerFileId,
        edge.unresolved,
        CALLABLE_KINDS,
      );
      if (viaImports) {
        target = viaImports.target;
        source = viaImports.source;
      }
    }
    const candidates = byName.get(edge.unresolved);
    if (!target && (!candidates || candidates.length === 0)) continue;
    if (!target && fromNode?.path) {
      target = candidates!.find((c) => c.path === fromNode.path);
      if (target) source = "static";
    }
    // Last resort: several declarations share this name and nothing above
    // disambiguated. Previously this silently took candidates[0]; the binding
    // is kept (dropping it would hide real callers from blast radius) but is
    // tagged so `impact_analysis` can report it as a guess.
    let ambiguousCandidates: GraphNode[] | null = null;
    if (!target) {
      const pool = candidates!;
      target = pool[0];
      if (pool.length > 1) {
        source = "name_only_ambiguous";
        ambiguousCandidates = pool;
      }
    }

    const oldTo = edge.to;
    edge.to = target.id;
    edge.source = source;
    if (ambiguousCandidates) {
      edge.meta = {
        ...edge.meta,
        candidateCount: ambiguousCandidates.length,
        candidateIds: ambiguousCandidates.slice(0, 5).map((c) => c.id),
      };
    }
    delete edge.unresolved;
    edge.id = `${edge.kind}:${edge.from}->${edge.to}`;
    builder.rekeyEdge(edge.from, oldTo, edge.kind, edge);
  }
}

/**
 * Strip generics + take last `.`-segment so the by-name lookup hits the
 * indexed simple name. Handles both JS/TS forms (`Foo<Bar>`, `module.Foo`)
 * and Java forms (`com.foo.Bar`, `Outer.Inner`, `Bar<T>`).
 */
function normalizeTypeRef(symbol: string): string | null {
  const noGenerics = symbol.split("<")[0].trim();
  if (!noGenerics) return null;
  const parts = noGenerics.split(".");
  return parts[parts.length - 1] || null;
}

/**
 * Cross-file resolution for EXTENDS / IMPLEMENTS edges. The extractors emit
 * `unresolved:class:<name>` placeholders when they can't tell at parse time
 * whether the parent type is local or external — same trick we use for CALLS.
 *
 * Strategy:
 *   1. Index all Class + Interface nodes by simple name.
 *   2. Build a file→imported-files map from existing IMPORTS edges so we can
 *      disambiguate when multiple candidates share a name.
 *   3. For each unresolved EXTENDS/IMPLEMENTS edge:
 *        - Normalize the symbol (strip generics, last `.`-segment).
 *        - Look up candidates in the right pool (Interface for IMPLEMENTS,
 *          Class for EXTENDS, with fallback to Interface for TS quirks).
 *        - If multiple candidates and we have IMPORTS info, prefer the one
 *          whose file the source actually imports.
 *        - Bind unique matches; leave ambiguous ones unresolved (better
 *          than silently picking wrong).
 *
 * No extractor changes needed — this just rebinds existing edges. Runs after
 * resolveImports (we need IMPORTS edges) and before resolveCallsByName for
 * deterministic ordering.
 */
const CLASS_OR_INTERFACE: ReadonlySet<NodeKind> = new Set([
  "Class",
  "Interface",
]);
const INTERFACE_ONLY: ReadonlySet<NodeKind> = new Set(["Interface"]);

function resolveTypeRefsByName(builder: GraphBuilder): void {
  const graph = builder.build();

  const classByName = new Map<string, GraphNode[]>();
  const interfaceByName = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (n.kind === "Class") {
      const arr = classByName.get(n.name) ?? [];
      arr.push(n);
      classByName.set(n.name, arr);
    } else if (n.kind === "Interface") {
      const arr = interfaceByName.get(n.name) ?? [];
      arr.push(n);
      interfaceByName.set(n.name, arr);
    }
  }

  // Phase 1: same import-aware index used by resolveCallsByName.
  const ieIndex = buildImportExportIndex(builder);

  for (const edge of graph.edges) {
    if (edge.kind !== "EXTENDS" && edge.kind !== "IMPLEMENTS") continue;
    if (!edge.unresolved) continue;

    const simpleName = normalizeTypeRef(edge.unresolved);
    if (!simpleName) continue;

    const fromNode = builder.getNode(edge.from);
    const sourceFileId = fromNode?.path ? `file:${fromNode.path}` : null;

    // Phase 1 preference: (1) IMPORTS→EXPORTS match wins; (2) any-IMPORTS
    // disambiguation (older heuristic — caller imports from the candidate's
    // file, regardless of whether that file actually exports this name);
    // (3) unique candidate; (4) leave unresolved on ambiguity.
    let target: GraphNode | undefined;
    let source: EdgeSource = "name_only";
    const filterKinds =
      edge.kind === "IMPLEMENTS" ? INTERFACE_ONLY : CLASS_OR_INTERFACE;
    if (sourceFileId) {
      const viaImports = followViaImports(
        ieIndex,
        sourceFileId,
        simpleName,
        filterKinds,
      );
      if (viaImports) {
        target = viaImports.target;
        source = viaImports.source;
      }
    }
    let candidates =
      edge.kind === "IMPLEMENTS"
        ? interfaceByName.get(simpleName)
        : classByName.get(simpleName);
    // TS quirk: `class X extends I` where I is actually an Interface.
    if (
      edge.kind === "EXTENDS" &&
      (!candidates || candidates.length === 0)
    ) {
      candidates = interfaceByName.get(simpleName);
    }
    if (!target && (!candidates || candidates.length === 0)) continue;
    if (!target && fromNode?.path) {
      target = candidates.find((c) => c.path === fromNode.path);
      if (target) source = "static";
    }
    if (!target && sourceFileId && candidates.length > 1) {
      const imports = ieIndex.fileImports.get(sourceFileId);
      if (imports) {
        target = candidates.find(
          (c) => c.path && imports.has(`file:${c.path}`),
        );
        if (target) source = "via_imports";
      }
    }
    if (!target && candidates.length === 1) {
      target = candidates[0];
      if (fromNode?.path && target.path === fromNode.path) source = "static";
    }
    if (!target) continue; // still ambiguous → safer to leave unresolved

    const oldTo = edge.to;
    edge.to = target.id;
    edge.source = source;
    delete edge.unresolved;
    edge.id = `${edge.kind}:${edge.from}->${edge.to}`;
    builder.rekeyEdge(edge.from, oldTo, edge.kind, edge);
  }
}
