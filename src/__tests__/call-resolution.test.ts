/**
 * Call-resolution confidence.
 *
 * `resolveCallsByName` used to fall back to `candidates[0]` whenever several
 * declarations shared a name, tagging the result `name_only` — indistinguishable
 * from a confident single-candidate match. On a real Python corpus 30% of bound
 * edges were name-only, and while most names are unique (so most of those are
 * right), the ambiguous minority were silently guessed.
 */
import path from "path";
import { analyzeRepository } from "../analyser/analyser";
import type { CodeGraph, GraphEdge } from "../util/graph";

const FIXTURES = path.join(__dirname, "fixtures", "ambiguity");

let graph: CodeGraph;

beforeAll(() => {
  graph = analyzeRepository(FIXTURES, { resolveCallsByName: true });
});

const callsFrom = (fnName: string): GraphEdge[] =>
  graph.edges.filter((e) => e.kind === "CALLS" && e.from.includes(`#fn:${fnName}@`));

describe("ambiguous call resolution", () => {
  it("tags a binding chosen among several same-named declarations", () => {
    const edges = callsFrom("runAmbiguous");
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("name_only_ambiguous");
  });

  it("records how many candidates competed, and which", () => {
    const edge = callsFrom("runAmbiguous")[0];
    expect(edge.meta?.candidateCount).toBe(2);
    const ids = edge.meta?.candidateIds as string[];
    expect(ids).toHaveLength(2);
    // Both competing declarations are named, so a consumer can show the choice.
    expect(ids.every((id) => id.includes("#fn:handle@"))).toBe(true);
    expect(ids.some((id) => id.includes("alpha.ts"))).toBe(true);
    expect(ids.some((id) => id.includes("beta.ts"))).toBe(true);
  });

  it("still binds the edge rather than dropping it", () => {
    // Dropping would hide a real caller from blast radius, which is the more
    // dangerous error — so the edge survives, flagged.
    const edge = callsFrom("runAmbiguous")[0];
    expect(edge.unresolved).toBeUndefined();
    expect(edge.to).toContain("#fn:handle@");
  });

  it("leaves an unambiguous by-name binding untagged", () => {
    const edges = callsFrom("runUnique");
    expect(edges).toHaveLength(1);
    expect(edges[0].source).not.toBe("name_only_ambiguous");
    expect(edges[0].meta?.candidateCount).toBeUndefined();
  });
});
