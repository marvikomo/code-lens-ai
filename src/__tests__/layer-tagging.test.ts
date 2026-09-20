/**
 * Semantic layer tagging.
 *
 * Leiden communities group files by who imports whom, which says nothing
 * about what a file *is*. An agent asking "show me the persistence layer"
 * needs a second axis. `tagFileLayers` asks a System One model one Choice
 * question per file — "which architectural layer is this?" — over evidence
 * the graph already has (path, imports, declarations, routes), and stores
 * the answer and its confidence on the File node. Code owns the vocabulary
 * and the thresholds; the model only picks.
 *
 * The judge is injected so these tests run offline against a fake.
 */
import path from "path";
import { analyzeRepository } from "../analyser/analyser";
import type { CodeGraph, GraphNode } from "../util/graph";
import {
  LAYERS,
  buildFileEvidence,
  tagFileLayers,
  type Judge,
  type LayerId,
} from "../ai/layers";
import { createJudge } from "../ai/judge";

const FIXTURES = path.join(__dirname, "fixtures", "layers");

let graph: CodeGraph;

beforeAll(() => {
  graph = analyzeRepository(FIXTURES, { resolveCallsByName: true });
});

const fileNode = (suffix: string): GraphNode => {
  const n = graph.nodes.find(
    (n) => n.kind === "File" && n.path!.endsWith(suffix),
  );
  if (!n) throw new Error(`no File node ending in ${suffix}`);
  return n;
};

/** A judge that answers from a path-suffix → layer table. */
function fakeJudge(
  table: Record<string, { layer: LayerId; confidence: number }>,
): Judge & { calls: number; stateSizes: number[] } {
  const judge = {
    calls: 0,
    stateSizes: [] as number[],
    // Typed loosely: the fake returns plain objects shaped like ChoiceResponse.
    async ask(state: unknown, questions: Record<string, unknown>): Promise<any> {
      judge.calls++;
      judge.stateSizes.push(JSON.stringify(state).length);
      const files = (state as { files: Array<{ path: string }> }).files;
      const answers: Record<string, unknown> = {};
      for (const qid of Object.keys(questions)) {
        const idx = Number(qid.replace(/^file_/, ""));
        const p = files[idx].path;
        const hit = Object.entries(table).find(([k]) => p.endsWith(k));
        const layer = hit?.[1].layer ?? "unclear";
        const confidence = hit?.[1].confidence ?? 0.2;
        const probabilities: Record<string, number> = {};
        for (const id of Object.keys(LAYERS)) probabilities[id] = 0;
        probabilities[layer] = confidence;
        answers[qid] = { type: "choice", choice: layer, confidence, probabilities };
      }
      return answers;
    },
  };
  return judge;
}

describe("buildFileEvidence", () => {
  it("collects path, language, declarations, external imports and routes", () => {
    const ev = buildFileEvidence(graph, fileNode("routes/users.ts"), FIXTURES);
    expect(ev.path).toBe("src/routes/users.ts");
    expect(ev.language).toBe("typescript");
    expect(ev.externalImports).toEqual(["express"]);
    expect(ev.importsFiles).toEqual(["src/db/users.ts"]);
    expect(ev.routes).toEqual(["GET /users/:id"]);
    expect(ev.symbols.some((d) => d.includes("router"))).toBe(true);
  });

  it("marks AST-detected test files so the model need not re-derive it", () => {
    const ev = buildFileEvidence(graph, fileNode("util.spec.ts"), FIXTURES);
    expect(ev.isTest).toBe(true);
    expect(ev.externalImports).toEqual(["vitest"]);
  });

  it("includes a bounded head excerpt of the source", () => {
    const ev = buildFileEvidence(graph, fileNode("db/users.ts"), FIXTURES);
    expect(ev.head).toContain("PrismaClient");
    expect(ev.head.length).toBeLessThanOrEqual(1500);
  });

  it("ranks symbols by graph connectivity, not by position in the file", () => {
    const ev = buildFileEvidence(graph, fileNode("db/users.ts"), FIXTURES);
    // findUser is exported and called from two other files; normalizeId is
    // declared first but private and only called locally.
    expect(ev.symbols[0]).toMatch(/^Function findUser/);
    expect(ev.symbols[0]).toContain("exported");
    expect(ev.symbols[0]).toMatch(/called from 2 files?/);
    const normalizeIdx = ev.symbols.findIndex((s) => s.startsWith("Function normalizeId"));
    expect(normalizeIdx).toBeGreaterThan(0);
  });

  it("nests methods under their class and drops anonymous functions", () => {
    const ev = buildFileEvidence(graph, fileNode("services/UserService.ts"), FIXTURES);
    const cls = ev.symbols.findIndex((s) => s.startsWith("Class UserService"));
    expect(cls).toBeGreaterThanOrEqual(0);
    expect(ev.symbols[cls + 1]).toMatch(/^ {2}Method profile/);
    expect(ev.symbols[cls + 2]).toMatch(/^ {2}Method redact/);
    expect(ev.symbols.some((s) => s.includes("<anonymous>") || /<.*@\d+>/.test(s))).toBe(false);
  });

  it("caps the symbol list by a character budget", () => {
    const ev = buildFileEvidence(graph, fileNode("db/users.ts"), FIXTURES);
    expect(ev.symbols.join("\n").length).toBeLessThanOrEqual(1600);
  });
});

describe("tagFileLayers", () => {
  it("stamps layer and confidence on every File node", async () => {
    const judge = fakeJudge({
      "routes/users.ts": { layer: "api_surface", confidence: 0.93 },
      "db/users.ts": { layer: "data_access", confidence: 0.88 },
      "util.ts": { layer: "utilities", confidence: 0.7 },
      "util.spec.ts": { layer: "tests", confidence: 0.99 },
    });
    const report = await tagFileLayers(graph, judge, { repoPath: FIXTURES });

    expect(fileNode("routes/users.ts").layer).toBe("api_surface");
    expect(fileNode("routes/users.ts").layerConfidence).toBeCloseTo(0.93);
    expect(fileNode("db/users.ts").layer).toBe("data_access");
    expect(fileNode("util.spec.ts").layer).toBe("tests");
    expect(report.tagged).toBe(5);
    expect(report.byLayer.api_surface).toBe(1);
    expect(report.byLayer.data_access).toBe(1);
  });

  it("keeps the raw pick but counts it as low-confidence below the threshold", async () => {
    const judge = fakeJudge({
      "util.ts": { layer: "business_logic", confidence: 0.35 },
    });
    const report = await tagFileLayers(graph, judge, {
      repoPath: FIXTURES,
      minConfidence: 0.6,
    });
    // The pick is stored — thresholds are display policy, not inference —
    // and the report says how many fell under the bar.
    expect(fileNode("util.ts").layer).toBe("business_logic");
    expect(fileNode("util.ts").layerConfidence).toBeCloseTo(0.35);
    expect(report.lowConfidence).toBeGreaterThanOrEqual(1);
  });

  it("batches several files into one request", async () => {
    const judge = fakeJudge({});
    await tagFileLayers(graph, judge, { repoPath: FIXTURES });
    // Five files, one request: fan-out, not one round trip per file.
    expect(judge.calls).toBe(1);
  });

  it("splits batches when the state would exceed the character budget", async () => {
    const judge = fakeJudge({});
    await tagFileLayers(graph, judge, { repoPath: FIXTURES, maxStateChars: 600 });
    expect(judge.calls).toBeGreaterThan(1);
    for (const size of judge.stateSizes) expect(size).toBeLessThanOrEqual(600 * 1.5);
  });

  it("only tags files in `only` when given (incremental runs)", async () => {
    const judge = fakeJudge({ "util.ts": { layer: "utilities", confidence: 0.9 } });
    const target = fileNode("util.ts");
    const other = fileNode("db/users.ts");
    delete target.layer;
    delete other.layer;
    await tagFileLayers(graph, judge, {
      repoPath: FIXTURES,
      only: new Set([target.id]),
    });
    expect(target.layer).toBe("utilities");
    expect(other.layer).toBeUndefined();
  });
});

describe("createJudge", () => {
  it("returns null when no API key is configured", () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      expect(createJudge()).toBeNull();
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  it("returns a judge when a key is supplied explicitly", () => {
    expect(createJudge({ apiKey: "test-key" })).not.toBeNull();
  });
});
