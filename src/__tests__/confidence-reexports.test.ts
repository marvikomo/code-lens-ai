import fs from "fs";
import os from "os";
import path from "path";
import { analyzeRepository } from "../analyser/analyser";
import type { CodeGraph, GraphEdge } from "../util/graph";

function write(root: string, rel: string, source: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-lens-confidence-"));
  for (const [rel, source] of Object.entries(files)) write(root, rel, source);
  return root;
}

function callEdge(graph: CodeGraph, callerName: string): GraphEdge {
  const caller = graph.nodes.find(
    (n) => n.kind === "Function" && n.name === callerName,
  );
  expect(caller).toBeTruthy();
  const edge = graph.edges.find(
    (e) => e.kind === "CALLS" && e.from === caller!.id,
  );
  expect(edge).toBeTruthy();
  return edge!;
}

describe("confidence-tagged call resolution", () => {
  it("tags same-file, import, named re-export, star re-export, and name-only calls", () => {
    const root = makeRepo({
      "direct.ts": `
        export function direct() {}
        export function leaf() {}
      `,
      "star-target.ts": `
        export function starLeaf() {}
      `,
      "barrel.ts": `
        export { leaf as load } from "./direct";
      `,
      "star.ts": `
        export * from "./star-target";
      `,
      "caller.ts": `
        import { direct } from "./direct";
        import { load } from "./barrel";
        import { starLeaf } from "./star";

        function local() {}
        function directCaller() { direct(); }
        function reexportCaller() { load(); }
        function starCaller() { starLeaf(); }
        function localCaller() { local(); }
      `,
      "name-only.ts": `
        function nameOnlyCaller() { orphan(); }
      `,
      "orphan.ts": `
        function orphan() {}
      `,
    });

    const graph = analyzeRepository(root);

    expect(callEdge(graph, "directCaller").source).toBe("via_imports");
    expect(callEdge(graph, "reexportCaller").source).toBe("via_reexport");
    expect(callEdge(graph, "starCaller").source).toBe("via_reexport");
    expect(callEdge(graph, "localCaller").source).toBe("static");
    expect(callEdge(graph, "nameOnlyCaller").source).toBe("name_only");

    expect(
      graph.edges.some(
        (e) =>
          e.kind === "REEXPORTS" &&
          e.meta?.localName === "leaf" &&
          e.meta?.exportedName === "load",
      ),
    ).toBe(true);
    expect(graph.edges.some((e) => e.kind === "REEXPORTS_ALL")).toBe(true);
  });
});
