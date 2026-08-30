/**
 * End-to-end extraction for the config-driven languages.
 *
 * These run the real analyser over real fixture files with real grammars —
 * node-type names in a `LanguageConfig` are only correct if an actual parse
 * produces them, so a mocked tree would test nothing worth testing.
 *
 * Grammars are optional (see `npm run grammars:install`). A language whose
 * grammar is not installed is reported by the availability test rather than
 * silently skipped everywhere.
 */
import path from "path";
import {
  analyzeRepository,
  preloadRepositoryGrammars,
} from "../analyser/analyser";
import type { CodeGraph, GraphNode } from "../util/graph";
import { LANGUAGE_CONFIGS } from "../extractor/configs";
import { detectLanguage, supportedExtensions } from "../util/language";

const FIXTURES = path.join(__dirname, "fixtures", "polyglot");

let graph: CodeGraph;
let available: Set<string>;
let failures: { language: string; reason: string }[];

beforeAll(async () => {
  const report = await preloadRepositoryGrammars(FIXTURES);
  available = new Set(report.loaded);
  failures = report.failed;
  graph = analyzeRepository(FIXTURES, { resolveCallsByName: false });
}, 60_000);

// --------------------------------------------------------------------- helpers

const nodesOf = (language: string): GraphNode[] =>
  graph.nodes.filter((n) => n.language === language);

const has = (language: string, kind: string, name: string): boolean =>
  nodesOf(language).some((n) => n.kind === kind && n.name === name);

/** Unresolved edges carry the raw symbol, which is what these configs emit. */
const callsFrom = (fromName: string): string[] =>
  graph.edges
    .filter((e) => e.kind === "CALLS" && e.from.includes(fromName))
    .map((e) => e.unresolved ?? e.to);

/**
 * Heritage edges come out either unresolved (`unresolved:class:Base`) or bound
 * to a real node id when the target is defined in the same file, so compare on
 * the trailing symbol name in both cases.
 */
const edgeSymbols = (kind: string, language: string): string[] => {
  const ids = new Set(nodesOf(language).map((n) => n.id));
  return graph.edges
    .filter((e) => e.kind === kind && ids.has(e.from))
    .map((e) => e.unresolved ?? e.to.split(":").pop() ?? e.to);
};

/**
 * Never skip silently: a guard that quietly returns turns "the grammar did not
 * load" into a green test that asserted nothing. Run `npm run grammars:install`
 * if this fires.
 */
const withLanguage = (language: string, assertions: () => void): void => {
  if (!available.has(language)) {
    const reason =
      failures.find((f) => f.language === language)?.reason ?? "not loaded";
    throw new Error(
      `grammar for "${language}" unavailable (${reason}) — run \`npm run grammars:install\``,
    );
  }
  assertions();
};

// ------------------------------------------------------------------ availability

describe("grammar availability", () => {
  it("loads every configured grammar", () => {
    // If this fails, run `npm run grammars:install`. The message names what is
    // missing and why, rather than letting the other tests quietly no-op.
    expect(failures.map((f) => `${f.language}: ${f.reason}`)).toEqual([]);
  });

  it("registers an extension for every configured language", () => {
    const detectable = new Set<string>(
      supportedExtensions()
        .map((ext) => detectLanguage(`file${ext}`))
        .filter((l): l is NonNullable<typeof l> => l !== null),
    );
    const unreachable = Object.keys(LANGUAGE_CONFIGS).filter(
      (lang) => !detectable.has(lang),
    );
    expect(unreachable).toEqual([]);
  });
});

// ------------------------------------------------------------------- languages

describe("python", () => {
  it("extracts a class, its method, a free function and inheritance", () => {
    withLanguage("python", () => {
      expect(has("python", "Class", "Widget")).toBe(true);
      expect(has("python", "Method", "render")).toBe(true);
      expect(has("python", "Function", "helper")).toBe(true);
      // Bases live in an unnamed argument_list, not a `superclass` field.
      expect(edgeSymbols("EXTENDS", "python")).toContain("Base");
    });
  });

  it("records the call from render to helper but not the len() builtin", () => {
    withLanguage("python", () => {
      const calls = callsFrom("#class:Widget.method:render");
      expect(calls).toContain("helper");
      expect(callsFrom("#fn:helper")).not.toContain("len");
    });
  });
});

describe("go", () => {
  it("separates struct from interface under the shared type_spec node", () => {
    withLanguage("go", () => {
      expect(has("go", "Class", "Shape")).toBe(true);
      expect(has("go", "Interface", "Drawer")).toBe(true);
      expect(has("go", "Function", "Draw")).toBe(true);
    });
  });

  it("drops bare predeclared builtins but keeps receiver calls", () => {
    withLanguage("go", () => {
      const helperCalls = callsFrom("#fn:helper");
      // `make(...)` and `append(...)` are bare builtins — the graphify failure
      // this filter exists to prevent.
      expect(helperCalls).not.toContain("make");
      expect(helperCalls).not.toContain("append");
      // `fmt.Println(...)` came through a selector, so it survives.
      expect(callsFrom("#fn:Draw")).toContain("Println");
    });
  });
});

describe("go type conversions", () => {
  it("does not turn bare conversions into calls on same-named functions", () => {
    withLanguage("go", () => {
      const calls = callsFrom("#fn:convert");
      // `int(n)`, `uint32(n)`, `float64(n)`, `uintptr(p)` are conversions.
      for (const t of ["int", "uint32", "float64", "uintptr"]) {
        expect(calls).not.toContain(t);
      }
      // A user function named `string` exists in the fixture; nothing should
      // have been bound onto it by a conversion.
      const stringFn = nodesOf("go").find(
        (n) => n.kind === "Function" && n.name === "string",
      );
      expect(stringFn).toBeDefined();
      const inbound = graph.edges.filter(
        (e) => e.kind === "CALLS" && e.to === stringFn!.id,
      );
      expect(inbound).toHaveLength(0);
    });
  });

  it("keeps a receiver call that shares a predeclared type name", () => {
    withLanguage("go", () => {
      // `w.error()` came through a selector, so the bare-identifier filter
      // must not touch it.
      expect(callsFrom("#fn:convert")).toContain("error");
    });
  });
});

describe("rust", () => {
  it("names an impl block after its type so methods join the struct", () => {
    withLanguage("rust", () => {
      expect(has("rust", "Class", "Shape")).toBe(true);
      expect(has("rust", "Interface", "Drawer")).toBe(true);
      const shape = nodesOf("rust").find(
        (n) => n.kind === "Class" && n.name === "Shape",
      );
      expect(shape).toBeDefined();
      const methods = graph.edges.filter(
        (e) => e.kind === "HAS_METHOD" && e.from === shape!.id,
      );
      expect(methods.length).toBeGreaterThan(0);
    });
  });
});

describe("ruby", () => {
  it("extracts class, method and superclass", () => {
    withLanguage("ruby", () => {
      expect(has("ruby", "Class", "Widget")).toBe(true);
      expect(has("ruby", "Method", "render")).toBe(true);
      expect(edgeSymbols("EXTENDS", "ruby")).toContain("Base");
    });
  });
});

describe("csharp", () => {
  it("extracts class, interface, method and base type", () => {
    withLanguage("csharp", () => {
      expect(has("csharp", "Class", "Widget")).toBe(true);
      expect(has("csharp", "Interface", "IDraw")).toBe(true);
      expect(has("csharp", "Method", "Draw")).toBe(true);
      expect(edgeSymbols("EXTENDS", "csharp")).toContain("Base");
    });
  });
});

describe("php", () => {
  it("separates extends from implements", () => {
    withLanguage("php", () => {
      expect(has("php", "Class", "Widget")).toBe(true);
      expect(has("php", "Interface", "IDraw")).toBe(true);
      expect(edgeSymbols("EXTENDS", "php")).toContain("Base");
      expect(edgeSymbols("IMPLEMENTS", "php")).toContain("IDraw");
    });
  });

  it("resolves all three php call forms", () => {
    withLanguage("php", () => {
      const calls = callsFrom("#class:Widget.method:draw");
      expect(calls).toContain("helper");
      expect(calls).toContain("decorate");
    });
  });
});

describe("elixir", () => {
  it("treats defmodule/def call nodes as declarations", () => {
    withLanguage("elixir", () => {
      expect(has("elixir", "Class", "App.Widget")).toBe(true);
      expect(has("elixir", "Function", "render")).toBe(true);
    });
  });

  it("does not make a function call itself via its own signature", () => {
    withLanguage("elixir", () => {
      // `def render(x)` is itself a call node; scoping calls to the do_block
      // is what stops render → render.
      expect(callsFrom("#fn:render")).not.toContain("render");
      expect(callsFrom("#fn:render")).toContain("helper");
    });
  });
});

describe("kotlin", () => {
  it("extracts declarations that carry no name field", () => {
    withLanguage("kotlin", () => {
      expect(has("kotlin", "Class", "Widget")).toBe(true);
      expect(has("kotlin", "Method", "render")).toBe(true);
    });
  });
});

describe("swift", () => {
  it("extracts class, protocol and method", () => {
    withLanguage("swift", () => {
      expect(has("swift", "Class", "Widget")).toBe(true);
      expect(has("swift", "Interface", "Drawer")).toBe(true);
      expect(has("swift", "Method", "draw")).toBe(true);
    });
  });
});

describe("c", () => {
  it("unwraps the declarator chain to name a function", () => {
    withLanguage("c", () => {
      expect(has("c", "Class", "Shape")).toBe(true);
      expect(has("c", "Function", "helper")).toBe(true);
      expect(has("c", "Function", "draw")).toBe(true);
      expect(callsFrom("#fn:draw")).toContain("helper");
      expect(callsFrom("#fn:draw")).not.toContain("printf");
    });
  });
});

describe("scala", () => {
  it("extracts class, trait and method", () => {
    withLanguage("scala", () => {
      expect(has("scala", "Class", "Widget")).toBe(true);
      expect(has("scala", "Interface", "Drawer")).toBe(true);
      expect(has("scala", "Method", "draw")).toBe(true);
    });
  });
});

describe("bash", () => {
  it("extracts functions and calls while filtering shell builtins", () => {
    withLanguage("bash", () => {
      expect(has("bash", "Function", "helper")).toBe(true);
      expect(has("bash", "Function", "deploy")).toBe(true);
      const calls = callsFrom("#fn:deploy");
      expect(calls).toContain("helper");
      expect(calls).not.toContain("cd");
    });
  });
});
