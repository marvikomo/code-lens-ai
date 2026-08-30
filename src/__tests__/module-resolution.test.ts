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
  graph = analyzeRepository(FIXTURES, { resolveCallsByName: false });
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
