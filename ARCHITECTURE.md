# Architecture

code-lens turns a repository into a queryable code graph and serves it to AI
agents over MCP. This document describes the pipeline and the module
boundaries.

Every symbol named in the module table below is imported by
`src/__tests__/architecture-doc.test.ts`, so this file cannot drift out of
sync with the code without failing the build.

## Pipeline

```
detect language → parse (tree-sitter) → extract → resolve → index → cluster → serve
```

Each stage hands the next a plain data structure. Nothing before `index`
touches a database, so extraction and resolution are testable against fixtures
with no services running.

| Stage | Entry point | Input → output |
|---|---|---|
| **Detect** | `detectLanguage(filePath)`, `supportedExtensions()` — `util/language.ts` | path → `SupportedLanguage \| null`, by extension |
| **Load grammar** | `preloadGrammars(languages)`, `getParser(language)` — `util/parserFactory.ts` | language → a tree-sitter `Parser` |
| **Load grammar (repo)** | `preloadRepositoryGrammars(repo, opts)` — `analyser/analyser.ts` | repo path → only the grammars that repo needs |
| **Extract** | `JsTsExtractor`, `JavaExtractor`, `GenericExtractor` — `extractor/` | CST → nodes and edges in a `GraphBuilder` |
| **Analyse** | `analyzeRepository(repo, opts)` — `analyser/analyser.ts` | repo path → `CodeGraph` (walk, extract, resolve) |
| **Analyse (incremental)** | `analyzeIncremental(repo, opts)` — `analyser/analyser.ts` | repo + changed-file set → partial `CodeGraph` |
| **Tag layers** (optional) | `tagFileLayers(graph, judge, opts)`, `createJudge()` — `ai/layers.ts`, `ai/judge.ts` | `CodeGraph` → `File.layer` / `File.layerConfidence`, via TypeSafe |
| **Metrics** | `computeFileMetrics(files, edges, opts)`, `heuristicLabelFor(paths)` — `clustering/graph-metrics.ts` | file-import graph → `MetricsResult`; member paths → fallback label |
| **Store (local)** | `buildLocalIndex(graph, opts)` — `store/build.ts`; `LocalStore` — `store/local.ts` | `CodeGraph` → `<repo>/.codelens/`; served from memory |
| **Store (Neo4j)** | `indexToNeo4j(graph, opts)` — `indexers/neo4j.ts`; `clusterInNeo4j(opts)` — `clustering/neo4j-leiden.ts`; `Neo4jStore` — `store/neo4j.ts` | `CodeGraph` → Neo4j; metrics written back; served by Cypher |
| **Store (select)** | `openStore(opts)` — `store/index.ts` | flags/env → `GraphStore` |
| **Serve** | `startMcpServer(store)`, `registerTools(server, store)` — `mcp/server.ts` + `mcp/tools/` | agent request → `GraphStore` method → shaped answer |
| **Freshness** | `installHooks`, `uninstallHooks`, `hooksStatus` — `cli-commands/hooks.ts` | repo → git hooks that re-run the incremental path |

## Extraction: two paths

**Bespoke extractors** — JS/TS/TSX (`extractor/jsts.ts`) and Java
(`extractor/java.ts`). These model more than the common shape: HTTP routes,
exports and re-exports, anonymous handler functions, state objects. Their
grammars ship as direct dependencies and always work.

**The config-driven path** — `GenericExtractor` (`extractor/generic.ts`) walks
any language described by a `LanguageConfig` (`extractor/language-config.ts`),
one per language under `extractor/configs/`. It models what every language
shares: types, interfaces, enums, functions, methods, properties, imports,
calls and inheritance. Adding a language is normally a config object.

Configs carry escape hatches for grammars that do not fit the table model:
`classify` (Go packs structs and interfaces into one `type_spec`; Elixir has no
declaration nodes at all), `resolveName` (C's declarator chains), `resolveCallee`,
`callScope` (Elixir and Julia signatures are themselves call nodes), and
`isExported`.

Grammars for these languages are **optional** (`npm run grammars:install`).
A missing, unbuilt or ABI-incompatible grammar costs that one language: the
loader records it, warns once, and the run continues.

## Resolution

Extractors emit edges to placeholder targets (`unresolved:callable:foo`) because
a parser cannot see across files. `analyser.ts` then binds them, in descending
order of confidence — recorded on each edge as `EdgeSource`:

| Source | Meaning |
|---|---|
| `static` | Target is in the caller's own file |
| `via_imports` | The caller imports a file that exports exactly this name |
| `via_reexport` | Same, through a re-export chain |
| `name_only` | Matched on name, with a single plausible candidate |
| `name_only_ambiguous` | Several declarations share the name; this one was a pick |
| `dynamic` | Heuristic or dynamic dispatch |

`name_only_ambiguous` edges are kept rather than dropped — for blast radius,
hiding a real caller is worse than over-including a flagged one — and carry
`meta.candidateCount` / `meta.candidateIds`.

Import binding handles both relative paths (JS/TS) and non-relative module
specifiers via a path-suffix index: Go package paths, Python and Java dotted
modules. A file match must be unique and a directory match must name exactly
one directory; specifiers under two segments are skipped, since `fmt` and `os`
are almost always standard library.

## Clustering

Community detection, PageRank, boundary degree, blast radius and spine
selection run **in process** (`clustering/graph-metrics.ts`). No Neo4j GDS
plugin is required.

This is cheap because the clustered graph is the **File** graph, not the symbol
graph — a few thousand nodes even on a large monorepo.

Output is deterministic, and that is a correctness requirement rather than a
nicety: community ids are the key `label_community` writes agent-authored
labels against, so assignments that drift between identical runs would
silently re-point those labels at the wrong files. Three guards enforce it —
sorted node insertion, canonicalized and sorted undirected edges, and a seeded
RNG — plus renumbering communities by their lowest member id.

A file is spine (`is_core`) if it is top-K by PageRank or top-M by boundary
degree within its community.

## Semantic layers (optional)

Communities are structural — files grouped by who imports whom. They cannot
answer "where is the persistence layer?", because that is a question about
what a file *is*, not who it talks to. `--layers` adds that second axis.

`tagFileLayers` (`ai/layers.ts`) asks TypeSafe's Jev model — a System One
model that returns a probability distribution over options you supply rather
than generated text — one Choice question per file: which of a fixed
vocabulary (`LAYERS`: `api_surface`, `ui`, `business_logic`, `data_access`,
`infrastructure`, `configuration`, `utilities`, `tests`, `unclear`) the file
belongs to. The evidence is what the graph already holds: relative path,
language, third-party imports (the unresolved `IMPORTS` edges), imported repo
files, declarations, HTTP routes, and the first lines of source.

Division of labour is deliberate. Code owns the vocabulary, the evidence, the
batching (a few files per request, greedy by size — small batches measurably
sharpen the picks) and the thresholds; the
model only picks. Both the pick and its confidence are stored, so
`get_overview`'s low-confidence cut-off is display policy and can change
without re-running inference. `createJudge` (`ai/judge.ts`) is the single
seam to the SDK, and returns null without `TYPESAFE_API_KEY`; tests inject a
fake `Judge`.

## Storage and serving

The graph is built in memory (`util/graph.ts`, wrapping `graphlib`). Where it
goes next is behind one interface, `GraphStore` (`store/types.ts`): one method
per question the MCP tools ask — `communities()`, `impactCallers()`,
`glossary()`, `search()` and so on — returning plain typed rows. Tools render
prose from those rows and never see a driver or a query string.

Two backends implement it:

- **`LocalStore`** (`store/local.ts`) — the default. `codelens index` computes
  file metrics in process, stamps them on the File nodes, and writes
  `<repo>/.codelens/` (`graph.json`, `meta.json`, `labels.json`, optional
  `embeddings.bin`). The server loads that into memory and answers every
  query as a filter or bounded traversal over a few indexes. Keyword search is
  `minisearch`; semantic search is a cosine scan over the stored vectors.
  Community labels live in their own file and survive re-indexing.
- **`Neo4jStore`** (`store/neo4j.ts`) — opt-in with `--neo4j-uri`. The
  original Cypher, moved verbatim, so behaviour is unchanged. It is the only
  backend that offers the free-form `cypher` tool, and the one to choose when
  the graph should outlive the machine that built it.

`openStore` (`store/index.ts`) picks: Neo4j when a URI is given, local
otherwise. Both run the same `computeFileMetrics` and the same
`heuristicLabelFor`, so communities and their fallback names agree.

The store seam is also what made the tools testable: `mcp-tools.test.ts`
drives a real `McpServer` over an in-memory transport against a `LocalStore`
built from a fixture repo, and `store-contract.test.ts` pins what each store
method returns.

## Known boundaries

Stated rather than papered over:

- Clustering quality has not been A/B tested against the GDS Leiden
  implementation it replaced. `ClusterReport.modularity` is reported so the
  partition quality is observable.
- Go method calls resolve poorly: names like `Run` and `Close` repeat across
  receiver types, and there is no receiver-type inference, so a large share of
  Go bindings are `name_only_ambiguous`.
- `impact_analysis` traverses `CALLS`, `EXTENDS` and `IMPLEMENTS`. File-level
  relations are excluded deliberately; file reach is covered by `blastScore`.
- Per-language extraction coverage is uneven. The README documents the limits
  language by language.
