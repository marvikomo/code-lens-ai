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
| **Index** | `indexToNeo4j(graph, opts)` — `indexers/neo4j.ts` | `CodeGraph` → nodes and edges in Neo4j |
| **Cluster** | `clusterInNeo4j(opts)` — `clustering/neo4j-leiden.ts` | stored graph → community, pagerank, boundary, blast, spine |
| **Metrics** | `computeFileMetrics(files, edges, opts)` — `clustering/graph-metrics.ts` | file-import graph → `MetricsResult` |
| **Serve** | `mcp/server.ts` + `mcp/tools/` | agent request → Cypher / FTS / vector query → shaped answer |
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

## Storage and serving

The graph is built in memory (`util/graph.ts`, wrapping `graphlib`) and pushed
to Neo4j, which provides the query engine, full-text index and vector index.
The MCP server exposes ten tools that translate agent intent into queries and
shape the results — decision-support prose (`impact_analysis`), structural
facts (`generate_wiki`), or raw rows (`cypher`).

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
