/**
 * Non-relative module specifiers.
 *
 * The original resolver only understood relative JS/TS paths plus a Java
 * special case, so Go package paths and Python dotted modules bound to
 * nothing. That left the File-import graph almost empty outside JS/TS — k6
 * produced 6 IMPORTS edges across 3,482 files — and community detection and
 * spine selection are computed from exactly that graph, so `get_overview` was
 * meaningless for those repos.
 */
import path from "path";
import {
  analyzeRepository,
  preloadRepositoryGrammars,
} from "../analyser/analyser";
import type { CodeGraph } from "../util/graph";

const FIXTURES = path.join(__dirname, "fixtures", "modules");

let graph: CodeGraph;

beforeAll(async () => {
  await preloadRepositoryGrammars(FIXTURES);
  // Call resolution on: the last assertions check that imports feed the
  // import-aware binding path, not just that IMPORTS edges exist.
  graph = analyzeRepository(FIXTURES, { resolveCallsByName: true });
}, 60_000);

/** Resolved IMPORTS edges out of a file, as target basenames. */
const importsFrom = (basename: string): string[] =>
  graph.edges
    .filter(
      (e) =>
        e.kind === "IMPORTS" &&
        e.from.endsWith(basename) &&
        !e.unresolved,
    )
    .map((e) => path.basename(e.to));

const unresolvedFrom = (basename: string): string[] =>
  graph.edges
    .filter(
      (e) => e.kind === "IMPORTS" && e.from.endsWith(basename) && !!e.unresolved,
    )
    .map((e) => e.unresolved!);

describe("go package imports", () => {
  it("binds a package path to every file in that package", () => {
    // `example.com/proj/lib/netext` names a directory, and importing a Go
    // package depends on all of it.
    const targets = importsFrom("main.go");
    expect(targets).toContain("dialer.go");
    expect(targets).toContain("resolver.go");
  });

  it("leaves a stdlib import unresolved", () => {
    // Single-segment specifiers are almost always stdlib; binding `fmt` to a
    // same-named repo file would invent a dependency.
    expect(unresolvedFrom("main.go")).toContain("fmt");
    expect(importsFrom("main.go")).not.toContain("fmt.go");
  });
});

describe("python dotted imports", () => {
  it("binds a dotted module path to its file", () => {
    expect(importsFrom("importer.py")).toContain("base.py");
  });

  it("leaves a stdlib module unresolved", () => {
    expect(unresolvedFrom("importer.py")).toContain("os");
  });
});

describe("ambiguity", () => {
  it("refuses to bind when a suffix matches two directories", () => {
    // `shared` exists under both dupe_a/ and dupe_b/, so there is no unique
    // package to point at — no edge beats a guessed one.
    const targets = importsFrom("ambiguous.go");
    expect(targets).not.toContain("thing.go");
    expect(unresolvedFrom("ambiguous.go")).toContain("example.com/proj/shared");
  });
});

describe("EXPORTS edges and import-aware call resolution", () => {
  const exportsOf = (basename: string): string[] =>
    graph.edges
      .filter((e) => e.kind === "EXPORTS" && e.from.endsWith(basename))
      .map((e) => String(e.meta?.exportedName ?? ""));

  it("records file-level declarations as exports", () => {
    // Without EXPORTS the resolver's import-aware path cannot fire at all,
    // which is why every non-JS language resolved purely by bare name.
    expect(exportsOf("base.py")).toEqual(
      expect.arrayContaining(["Base", "make_base"]),
    );
  });

  it("respects Go capitalisation when deciding what is importable", () => {
    const exported = exportsOf("dialer.go");
    expect(exported).toContain("Dial");
    // `prepare` is package-private; advertising it would let the resolver bind
    // cross-package calls the Go compiler would reject.
    expect(exported).not.toContain("prepare");
  });

  it("does not export methods, only file-level declarations", () => {
    // A method is reached through its owner, not imported by name.
    expect(exportsOf("base.py")).not.toContain("__init__");
  });

  it("binds a cross-file call through the caller's imports", () => {
    const edge = graph.edges.find(
      (e) =>
        e.kind === "CALLS" &&
        e.from.includes("importer.py") &&
        e.to.includes("base.py") &&
        e.to.includes("make_base"),
    );
    expect(edge).toBeDefined();
    // The whole point: import-verified rather than a name guess.
    expect(edge!.source).toBe("via_imports");
  });
});
