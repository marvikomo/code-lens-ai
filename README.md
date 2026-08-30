# code-lens-aI

**A code-intelligence MCP server for AI agents.** Index a codebase once, then ask Claude / Cursor / any MCP client to understand it — with answers grounded in the real call graph, real architectural subsystems, and real source code, not hallucinated guesses.

Built on Tree-sitter + Neo4j + Leiden community detection. **24 languages**, with JS / TS / TSX / Java parsed out of the box.

> **From a real session on a ~2,000-file TypeScript monorepo (73 detected subsystems):**
> *"This is exactly the right tool — it collapses what would be a long exploration into a handful of focused calls, and the community detection produces architectural insight you'd struggle to get from grep."*
> 4 tool calls produced both a complete codebase tour AND a deep mental-model explanation. A naive grep/find/read exploration of the same repo: ~25–40 calls.

---

## 🌟 The three killer features

### `get_overview` — Instant architectural map (the workhorse)

Without it: agent opens an unfamiliar 2,000-file monorepo and burns 10–20 `grep`/`find`/`ls` calls just to figure out what's there.

With it: **one call** returns the full architectural shape of the codebase — counts, languages, and the **top architectural subsystems detected by Leiden community detection**. For each subsystem, you get:

- Its **semantic label** (set by an agent in a prior session, persists across re-runs) — e.g. `auth-pipeline`, `request-routing`, `data-access`
- Its **size** (how many files belong to it)
- Its **spine files** (the most central by PageRank — "of these 196 files, read these 6 first")
- A one-sentence **summary** of what it does, with a **freshness signal** if the description has drifted
- A **heuristic-label fallback** (folder-name) for any subsystem an agent hasn't manually labeled — so you never see a bare `community-43`

The PageRank-ranked spine files are the single most useful pedagogical signal. On real production codebases, PageRank correctly surfaces the foundational files in each subsystem — typically 2× more central than anything else in that community, which lines up with what an experienced contributor would point you to.

When an agent has labeled a community, the `summary:` line carries it across sessions. Drifted descriptions get auto-flagged: `↳ written 14d ago; spine has shifted (3 dropped, 6 added since) — verify before relying`.

**Real result:** on a ~2,000-file TypeScript monorepo, `get_overview` + 3 targeted `cypher` lookups produced the entire architectural mental model an experienced contributor would need. Without `get_overview`, you'd reverse-engineer the same layout from `package.json` files plus folder spelunking.

### `generate_wiki` — Wiki skeleton in one MCP call

Without it: Claude in your IDE opens an unfamiliar codebase and burns ~30 tool calls (`cat`, `ls`, `grep`, repeated reads) just to gather the structural facts it needs to write a wiki.

With it: **one call** returns a structured markdown skeleton with all the facts pre-computed:

- Per-community **spine files** (top-PageRank in each architectural subsystem)
- **Top functions** in each subsystem (most-called, with signatures)
- **HTTP routes** table extracted from Express / Koa / etc. handlers
- **Entry points** (files no other file imports — likely application starts)
- **Test inventory** (files where AST patterns matched `describe`/`it`/`@Test`)
- **Cross-community import edges** as a data-flow hint
- **Glossary** of the top-50 most-called symbols with file:line refs

Plus explicit `[AGENT FILLS]` placeholders for the prose the agent should write (per-subsystem purpose, codebase narrative). The structural 80% comes free; the agent does the synthesis 20%.

**Real result:** on a 123-file LangGraph backend, tool call count to produce a wiki dropped from ~30 to ~5-8.

### `impact_analysis` — Decision-support, not a data dump

Without it: "What breaks if I change `verifyJWT`?" gets you a flat list of 47 callers with no signal about which matter.

With it, the **first three lines** answer the actual question:

```
## Verdict
⚠️ Risky change. 11 direct production callers across 3 communities,
   8 spine callers, target is itself a spine file.

> Based on visible callers in the indexed graph. May miss callers via
> re-exports, factory wrappers, or dynamic dispatch.
```

Then the breakdown:

- **Cross-community impact** — "✅ Contained" vs "⚠️ Crosses N boundaries"
- **Spine callers** — dedicated section listing callers that are themselves load-bearing files (their changes ripple)
- **Test files to update** — copy-paste-friendly path list
- **Production callers** grouped by architectural community, with truncation that always preserves at least one entry per community
- Risk score in metadata (sortable for tooling, never headlining the prose)

The verdict is honest: it always includes a caveat that callers via DI / re-export / dynamic dispatch may be missed. **No silent confidently-wrong answers.**

---

## 🔧 How it works

```
Source code
    │
    ▼ Tree-sitter parse
    │
Graph extraction (functions, classes, calls, imports, routes,
                  state objects, anonymous handlers, test files)
    │
    ▼ stored in
    │
Neo4j (with FTS index + vector index for hybrid search)
    │
    ▼ Leiden clustering
    │
Communities + PageRank + boundary degree → spine files
    │
    ▼ exposed via
    │
MCP server (10 tools, stdio transport)
    │
    ▼
Claude Code, Cursor, Codex, any MCP client
```

### What makes it sharper than `grep` + `Read`

| Capability | Native tools | code-lens-aI |
|---|---|---|
| "Find code by exact name" | `grep` | `search_code` (also semantic search if `--embed`) |
| "Show me this function's body" | `cat`/`Read` | `get_definition` (no filesystem access required) |
| "What calls X?" | `grep -r` (false positives) | `get_callers` (real CALLS edges) |
| "What does X depend on?" | manual import-tracing | `get_callees` |
| "What breaks if I change X?" | educated guess | `impact_analysis` with verdict + cross-community + spine |
| "What architectural subsystems are here?" | manual reading | `get_overview` (Leiden communities + spine files) |
| "Write me a wiki" | full-day exploration | `generate_wiki` skeleton in 1 call |

---

## 🌍 Languages

24 languages. Four have hand-written extractors; the other twenty run through a
config-driven walker (`src/extractor/generic.ts`) fed by one `LanguageConfig`
per language, so adding a language is normally a config object rather than a new
extractor.

**Built in — no extra install:**

| Language | Extras beyond the common shape |
|---|---|
| JavaScript, TypeScript, TSX | HTTP routes, exports/re-exports, anonymous handlers, state objects |
| Java | Annotations-based test detection, inner classes |

**Config-driven — install the grammars once:**

```bash
npm run grammars:install
```

Python, Go, Rust, Ruby, C#, PHP, Scala, Groovy, C, C++, Objective-C, Kotlin,
Swift, Elixir, Julia, PowerShell, OCaml, Common Lisp, DreamMaker (DM), Bash.

These extract the shape every language shares: types, interfaces, enums,
functions, methods, properties, imports, calls, and inheritance.

### Why the grammars are a separate install

Most tree-sitter grammar packages still declare a `tree-sitter@^0.21`/`^0.22`
peer range even though they load correctly against 0.25. Listing them as
dependencies makes a strict npm resolver fail the *entire* install, so they are
opt-in. Anything missing costs you that one language: the indexer logs it once
and carries on.

### Coverage is not uniform — what you actually get

Every language above was verified by parsing real fixtures and asserting on the
resulting graph (`src/__tests__/language-configs.test.ts`), not by assuming node
type names. Known limits, stated rather than papered over:

- **Ruby / Bash** emit no `IMPORTS` edges. `require` and `source` are ordinary
  call nodes in those grammars, so import edges would have to be invented.
- **Common Lisp** extracts `defun` only. The grammar leaves `defclass` and
  `defmethod` as undifferentiated lists and has no call node at all.
- **C#** writes base classes and interfaces in one undifferentiated `base_list`,
  so both are emitted as `EXTENDS`.
- **Python** skips class attributes; they are indistinguishable from
  module-level constants without type inference.
- **PowerShell** does not model inheritance — a class and its base are sibling
  nodes with nothing to tell them apart.
- **Kotlin** has no distinct interface node, so `interface Foo` appears as a
  `Class`.

### Languages deliberately absent

Lua, Zig, Verilog, Dart, SQL and Vue have npm grammars that **do not load**
against tree-sitter 0.25 — they are NAN-era builds that fail with "Invalid
language object". Svelte and Pascal fail to compile at all, and there is no npm
grammar for Fortran, Terraform, Astro or Apex. Configs exist for none of them,
because a config for a grammar that cannot load is a language claimed but not
delivered.

---

## 🚀 Quick start

### Prerequisites

- Node.js 18+
- Docker (for the bundled Neo4j container)

### Install + index + wire up

```bash
# Install the CLI globally
npm install -g @marvikomo/codelens-ai

# Start the bundled Neo4j (image: neo4j:5.15 with the APOC plugin)
codelens neo4j start

# Index a repo + run Leiden clustering
codelens index /path/to/your/repo \
  --neo4j-uri bolt://localhost:7687 --neo4j-user neo4j --neo4j-password password \
  --neo4j-clear --cluster

# (Optional) semantic + hybrid search (downloads ~161 MB embedding model)
codelens index /path/to/your/repo \
  --neo4j-uri bolt://localhost:7687 --neo4j-user neo4j --neo4j-password password \
  --embed

# Register the MCP server with Claude Code (one-time)
codelens mcp install --scope user \
  --neo4j-uri bolt://localhost:7687 --neo4j-user neo4j --neo4j-password password
```

Then in any Claude Code session:

```
Use codelens to give me an overview of this codebase.
```

The agent will see 10 tools (`search_code`, `get_definition`, `read_code`, `get_callers`, `get_callees`, `impact_analysis`, `get_overview`, `label_community`, `generate_wiki`, `cypher`) and decide which to use.

### Day-to-day

```bash
codelens index /path/to/repo --incremental    # only re-index changed files
codelens neo4j status                          # is the DB up?
codelens neo4j logs                            # tail container logs
codelens neo4j stop                            # shut down (data persists in docker volume)
```

### Development (from source)

```bash
git clone https://github.com/marvikomo/code-lens-aI.git
cd code-lens-aI
npm install
npm link                       # makes `codelens` resolve to this checkout
npm run dev -- index .         # or: ts-node src/cli.ts ...
```

---

## 📋 The 10 MCP tools

Every tool's description tells the agent **exactly when to use it** — explicit `"use this FIRST when…"` nudges keep agents from reaching for `cypher` when a higher-level tool is the right answer. Real session feedback called this out as a design that "kept me from reaching for cypher when get_overview was correct."

| Tool | What it answers | When agents reach for it |
|---|---|---|
| `get_overview` | "What is this codebase?" — counts, languages, top communities, spine files, label freshness | **Call this FIRST** on any unfamiliar repo |
| `generate_wiki` | "Write a wiki" — structural skeleton with [AGENT FILLS] markers | When asked to document or write architectural docs |
| `impact_analysis` | "Is it safe to change X?" — verdict-first with spine + test/prod + cross-community | Before recommending a refactor or non-trivial change |
| `search_code` | "Find code that does X" — keyword (FTS), semantic (vector), or hybrid (RRF fusion) | Locate symbols by name OR concept |
| `get_definition` | "Show me X's full body and signature" — **returns the body, not just a signature**, saving a `read_code` round-trip | When you know the symbol name |
| `read_code` | "Read lines N-M of file Y" — direct, capped at 2000 lines | Verify a claim or read context around a known location |
| `get_callers` | "Who calls X?" — graph traversal over real CALLS edges, depth-configurable | Understand reach of a function before changing it |
| `get_callees` | "What does X call?" — outbound graph traversal | Trace what a function depends on |
| `label_community` | "Give this architectural subsystem a name" — agent-driven labeling, stamps freshness metadata | Once per community, on first encounter |
| `cypher` | Read-only Cypher escape hatch — **schema cheat-sheet inlined in the tool description** so agents query the right props on the right node kinds | When the canned tools fall short of an exact query |

---

## 🧠 Why agents actually reach for it

Four design choices that came directly from real-session feedback and now define the product:

**1. Spine files turn "200-file subsystem" into "read these 6 first."**
PageRank + boundary-degree centrality picks out the load-bearing files in each community. The agent doesn't have to guess where to start — code-lens-aI tells it which 5–6 files every other file in the subsystem ultimately leans on. That's a pedagogical signal nothing else in the agent-coding space currently provides.

**2. Persistent semantic labels — set once by an agent, used forever.**
After `label_community` is called, the label rides along on every subsequent `get_overview` and `generate_wiki` call across all future sessions. A community labeled `auth-pipeline` once stays that way until the graph genuinely shifts (and we'll tell the agent when it has). No re-labeling on every session.

**3. Heuristic fallback so you never see "UNLABELED."**
When no agent has labeled a community yet, code-lens-aI derives a folder-name heuristic (e.g. `auth`, `api`, `services`) and marks it `(heuristic)`. Agents get a useful name immediately AND a clear signal that they could upgrade it to a semantic label.

**4. Description freshness signals — no silent staleness.**
Every agent-written description is timestamped + the spine snapshot is captured. Subsequent reads compute drift and flag stale descriptions: `↳ written 14d ago; spine has shifted (3 dropped, 6 added since) — verify before relying`. Agents never propagate stale claims confidently.

---

## 🛠️ CLI reference

```bash
codelens <subcommand> [args]
codelens <repo-path> [options]                  # shorthand for: codelens index <path>
```

### Subcommands

```bash
codelens index <path> [options]                 # analyze + index a repo
codelens mcp                                    # run MCP server (stdio)
codelens mcp install [options]                  # register MCP with Claude Code
codelens neo4j start|stop|status|logs           # manage bundled Neo4j container
codelens help                                   # show top-level help
```

### `codelens index` options

```bash
# Output
--no-json              # don't emit graph JSON to stdout
-o file.json           # write JSON to file
--ignore foo,bar       # extra directory/file names to skip
--stats                # print summary stats to stderr

# Neo4j (also reads NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD / NEO4J_DATABASE env vars)
--neo4j-uri <uri>
--neo4j-user <name>
--neo4j-password <pw>
--neo4j-clear          # DETACH DELETE all :CodeNode before re-indexing
--incremental          # re-index only changed files (git-aware), cascading to dependents

# Clustering (no plugin required — computed in process)
--cluster              # run Leiden + PageRank + spine selection
--cluster-only         # skip indexing; just re-cluster
--cluster-clear        # wipe community props + labels first
--cluster-min-size <n> # min files to materialize a :Community node (default 3)

# Embeddings (opt-in; ~161MB model on first run)
--embed                # compute embeddings for Function/Method/Class nodes
--embed-model <hf-id>  # override default jinaai/jina-embeddings-v2-base-code

# Search-only mode (no <repo-path> needed)
--search "<query>"
--search-mode <m>      # fts | vector | hybrid (auto if omitted)
--search-limit <n>
```

### `codelens mcp install` options

```bash
--scope <local|user|project>   # where to register (default: local)
                               #   local   = this directory only
                               #   user    = available in all your projects
                               #   project = shared via .mcp.json in repo
--neo4j-uri <uri>              # e.g. bolt://localhost:7687
--neo4j-user <name>
--neo4j-password <pw>
--neo4j-database <name>        # (optional)
```

If `--neo4j-*` flags are omitted, falls back to `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` env vars.

---

## 🎯 What's actually in the graph

Every indexed codebase gets:

**Node kinds:** `Repository`, `Folder`, `File`, `Class`, `Interface`, `TypeAlias`, `Enum`, `Function`, `Method`, `Property`, `Variable`, `Community`, `Unresolved`

**Edge types:** `CONTAINS`, `DEFINES`, `HAS_METHOD`, `HAS_PROPERTY`, `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, `IN_COMMUNITY`

**Properties on nodes:**
- Source code: `body`, `signature`, `bodyTruncated`
- Location: `path`, `startRow`, `endRow`, `startColumn`, `endColumn`, `language`
- HTTP handlers: `httpMethod`, `route`, `routerObject` (for `router.post(...)` patterns)
- State/factory: `builder` (for `Annotation.Root({...})`, `z.object({...})`, etc.)
- Tests: `isTest`, `testFramework` (jest / vitest / bun / junit / pytest detection)
- Communities: `community` int, `pagerank` float, `boundary` int, `is_core` boolean
- Embeddings: `embedding` float[768] (when `--embed` was run)
- FTS: indexed on `name`, `signature`, `body`, `path`

**What gets uniquely captured that other indexers miss:**

- **Anonymous route handlers** — `router.post("/users", async (req, res) => {...})` becomes a first-class `Function` node with `httpMethod: "POST"`, `route: "/users"`, and the handler body indexed for search
- **State objects** — `export const PlanAgentState = Annotation.Root({...})` becomes a `Variable` node with `builder: "Annotation.Root"` so you can find every state schema in one query
- **Test files** — detected via AST pattern matching (not just file path), with framework name (`jest` / `vitest` / `bun`)
- **Architectural communities** — Leiden detection on the file-import subgraph reveals real subsystems with ~80% accuracy on production codebases

---

## 🏗️ Architecture (one paragraph)

The CLI walks a repo, parses each file with **Tree-sitter** (24 languages), runs language-specific extractors that emit nodes (functions, classes, etc.) and edges (calls, imports) into an in-memory `graphlib` graph. The graph is bulk-pushed to **Neo4j** with a uniqueness constraint on `:CodeNode(id)`. After indexing, community detection (Louvain), PageRank, boundary degree and blast radius run **in process** over the file-IMPORTS subgraph — a few thousand nodes even on a large monorepo — and per-community spine selection writes `is_core: true` on the most-central files. No Neo4j GDS plugin is required. Optionally, **`@xenova/transformers`** computes 768-dim vector embeddings for Function/Method/Class bodies (jina-base-code model, in-process, ~161 MB). At query time, the **MCP server** exposes 10 tools that translate agent intent into Cypher / FTS / vector queries against this graph and shape the results into either decision-support prose (impact_analysis), structural facts (generate_wiki), or raw data (cypher).

---

## 📁 Project structure

```
src/
├── analyser/         # repo-walking + per-file extraction orchestration
├── extractor/        # per-language tree-sitter walkers (jsts.ts, java.ts, base.ts)
├── util/             # graph data model, language detection, parser factory
├── indexers/         # Neo4j bulk-write
├── clustering/       # In-process Louvain + PageRank + blast + spine
├── embeddings/       # @xenova/transformers wrapper + batch pipeline
├── search/           # FTS, vector, hybrid (RRF) implementations
├── mcp/              # MCP server + 10 tool implementations
├── cli-commands/     # subcommand handlers (neo4j docker wrapper, mcp install)
└── cli.ts            # entry point + subcommand dispatcher
scripts/
├── mcp-smoke.ts          # end-to-end MCP smoke test (10 tools)
├── mcp-impact-test.ts    # impact_analysis manual harness
├── mcp-wiki-test.ts      # generate_wiki manual harness
└── mcp-label-test.ts     # label_community manual harness
```

---

## 🤝 Contributing

The project is iterating fast. Real product feedback drives the roadmap — recent shipped features (Verdict-first impact_analysis, agent-driven community labeling, generate_wiki) all came from real-use sessions in Claude Code where gaps surfaced and got planned + shipped within hours.

If you find a gap: open an issue with the actual prompt + expected output. The plan files in `~/.claude/plans/` document the design rationale for each shipped capability.

---

## 📄 License

MIT
