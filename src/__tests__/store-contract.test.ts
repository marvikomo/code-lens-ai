/**
 * The contract every `GraphStore` backend must meet.
 *
 * The MCP tools used to be Cypher strings, so the only way to test them was
 * a live database. With the store seam, this file pins what each method
 * returns over a fixture repo, using the local backend. The Neo4j backend
 * runs the same assertions when `NEO4J_URI` is set — it is skipped otherwise,
 * exactly as the tools were untestable before.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { analyzeRepository } from "../analyser/analyser";
import { LocalStore } from "../store/local";
import { buildLocalIndex } from "../store/build";
import { localDir, readLabels, readLocalIndex } from "../store/persist";
import type { GraphStore } from "../store/types";

const FIXTURE = path.join(__dirname, "fixtures", "layers");

/** Copy the fixture so writing `.codelens/` never touches the checked-in tree. */
function cloneFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codelens-store-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

let repo: string;
let store: GraphStore;

beforeAll(() => {
  repo = cloneFixture();
  const graph = analyzeRepository(repo, { resolveCallsByName: true });
  buildLocalIndex(graph, {
    repoPath: repo,
    indexedAt: "2026-09-20T00:00:00.000Z",
    lastCommit: "abc123",
    minCommunitySize: 1,
  });
  store = LocalStore.open(repo);
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const rel = (p: string) => path.relative(repo, p);

describe("persistence", () => {
  it("writes graph, meta and an empty labels file", () => {
    const dir = localDir(repo);
    expect(fs.existsSync(path.join(dir, "graph.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "meta.json"))).toBe(true);
    expect(readLabels(repo)).toEqual({});
  });

  it("round-trips the graph with metrics on File nodes", () => {
    const index = readLocalIndex(repo);
    const files = index.graph.nodes.filter((n) => n.kind === "File");
    expect(files.length).toBe(5);
    expect(files.every((f) => f.metrics && typeof f.metrics.pagerank === "number")).toBe(true);
    expect(index.meta.repoName).toBe(path.basename(repo));
  });
});

describe("aggregates", () => {
  it("reports repository meta from meta.json", async () => {
    const meta = await store.repositoryMeta();
    expect(meta?.path).toBe(repo);
    expect(meta?.lastCommit).toBe("abc123");
    expect(meta?.lastIndexed).toBe("2026-09-20T00:00:00.000Z");
  });

  it("counts nodes by kind, largest first", async () => {
    const counts = await store.countsByKind();
    const byKind = Object.fromEntries(counts.map((c) => [c.kind, c.count]));
    expect(byKind.File).toBe(5);
    expect(byKind.Function).toBeGreaterThanOrEqual(3);
    expect(counts[0].count).toBeGreaterThanOrEqual(counts[counts.length - 1].count);
  });

  it("counts files per language", async () => {
    expect(await store.languageCounts()).toEqual([{ language: "typescript", count: 5 }]);
  });

  it("returns no layers when the index was built without --layers", async () => {
    expect(await store.layerCounts()).toEqual([]);
  });
});

describe("communities", () => {
  it("materializes communities with spine, size and a heuristic label", async () => {
    const comms = await store.communities();
    expect(comms.length).toBeGreaterThan(0);
    const total = comms.reduce((n, c) => n + c.size, 0);
    expect(total).toBe(5);
    for (const c of comms) {
      expect(c.label).toBeNull();
      expect(c.spine.length).toBeGreaterThan(0);
      expect(c.samplePaths.length).toBeLessThanOrEqual(3);
    }
    // routes/users.ts imports db/users.ts, so they share a community and the
    // folder-name heuristic has something to say.
    const withDb = comms.find((c) => c.samplePaths.some((p) => p.endsWith("db/users.ts")));
    expect(withDb?.heuristicLabel).not.toBeNull();
  });

  it("orders top-blast files by score and names their community", async () => {
    const blast = await store.topBlastFiles(10);
    expect(blast[0].path.endsWith("db/users.ts")).toBe(true);
    expect(blast[0].direct).toBe(2);
    expect(blast[0].community).not.toBe("");
    for (let i = 1; i < blast.length; i++) expect(blast[i - 1].blast).toBeGreaterThanOrEqual(blast[i].blast);
  });

  it("stores a label, snapshots the spine, and persists it to labels.json", async () => {
    const [c] = await store.communities();
    const ok = await store.setCommunityLabel(c.id, {
      label: "user-data",
      description: "Reads and serves users.",
      writtenAt: "2026-09-20T01:00:00.000Z",
    });
    expect(ok).toBe(true);
    const after = (await store.communities()).find((x) => x.id === c.id)!;
    expect(after.label).toBe("user-data");
    expect(after.descriptionSpineSnapshot).toEqual(c.spine.map((s) => s.path));
    expect(after.descriptionSpineHashes.every((h) => h.length === 64)).toBe(true);
    expect(readLabels(repo)[String(c.id)].label).toBe("user-data");
  });

  it("refuses to label a community that does not exist", async () => {
    expect(await store.setCommunityLabel(9999, { label: "x", writtenAt: "now" })).toBe(false);
  });

  it("survives a re-index: labels are re-applied to the fresh graph", async () => {
    const graph = analyzeRepository(repo, { resolveCallsByName: true });
    buildLocalIndex(graph, { repoPath: repo, indexedAt: "later", lastCommit: null, minCommunitySize: 1 });
    const reopened = LocalStore.open(repo);
    expect((await reopened.communities()).some((c) => c.label === "user-data")).toBe(true);
  });
});

describe("symbols and traversals", () => {
  it("finds symbols by name with optional kind and path filters", async () => {
    const all = await store.findSymbols({ name: "findUser" });
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe("Function");
    expect(all[0].body).toContain("prisma.user.findUnique");
    expect(await store.findSymbols({ name: "findUser", kinds: ["Class"] })).toHaveLength(0);
    expect(await store.findSymbols({ name: "findUser", pathContains: "routes" })).toHaveLength(0);
  });

  it("attaches file facts when asked", async () => {
    const [row] = await store.findSymbols({ name: "findUser", withFileFacts: true });
    expect(row.file?.path.endsWith("db/users.ts")).toBe(true);
    expect(row.file?.blastDirect).toBe(2);
    expect(typeof row.file?.communityId).toBe("number");
    expect(row.file?.isTest).toBe(false);
  });

  it("lists direct callers, nearest first", async () => {
    const rows = await store.callers("findUser", 1, 20);
    const names = rows.map((r) => r.caller.name).sort();
    // The route handler is anonymous; the service method is `profile`.
    expect(names).toContain("profile");
    expect(rows.every((r) => r.distance === 1)).toBe(true);
  });

  it("lists callees including unresolved externals", async () => {
    const rows = await store.callees("findUser", { depth: 1, limit: 30 });
    const names = rows.map((r) => r.target.name);
    expect(names).toContain("normalizeId");
    expect(names).toContain("findUnique");
    const external = rows.find((r) => r.target.name === "findUnique")!;
    expect(external.target.kind).toBe("Unresolved");
    expect(external.target.path).toBeUndefined();
  });

  it("computes impact callers with shortest-path sources and file facts", async () => {
    const [target] = await store.findSymbols({ name: "findUser" });
    const rows = await store.impactCallers({ name: "findUser", path: target.path! }, 3, ["CALLS", "EXTENDS", "IMPLEMENTS"]);
    const profile = rows.find((r) => r.name === "profile")!;
    expect(profile.distance).toBe(1);
    expect(profile.rels).toEqual(["CALLS"]);
    expect(profile.sources).toEqual(["via_imports"]);
    expect(profile.path.endsWith("services/UserService.ts")).toBe(true);
    expect(profile.callerIsTest).toBe(false);
    // A method has no DEFINES edge; the local store still knows its file.
    expect(typeof profile.callerCommunityId).toBe("number");
  });

  it("returns nothing for an unknown target", async () => {
    expect(await store.impactCallers({ name: "nope", path: "/x" }, 3, ["CALLS"])).toEqual([]);
  });
});

describe("wiki data", () => {
  it("reports routes, tests, entry points and coverage", async () => {
    expect(await store.routes()).toEqual([
      expect.objectContaining({ method: "GET", route: "/users/:id" }),
    ]);
    const tests = await store.testFiles();
    expect(tests.map((t) => rel(t.path))).toEqual(["src/util.spec.ts"]);
    expect(tests[0].framework).toBe("vitest");
    const entries = (await store.entryPoints()).map(rel);
    expect(entries).toContain("src/routes/users.ts");
    expect(entries).not.toContain("src/db/users.ts");
    const cov = await store.clusterCoverage();
    expect(cov.total).toBe(5);
    expect(cov.clustered + cov.orphans.length).toBe(5);
  });

  it("ranks the glossary and top functions by call count", async () => {
    const glossary = await store.glossary(5);
    expect(glossary[0].name).toBe("findUser");
    expect(glossary[0].callCount).toBe(2);
    const top = await store.topFunctionsByCommunity();
    expect(top.find((t) => t.name === "findUser")?.callCount).toBe(2);
  });

  it("lists third-party imports per community", async () => {
    const ext = await store.externalDepsByCommunity();
    const specs = ext.map((e) => e.spec);
    expect(specs).toEqual(expect.arrayContaining(["express", "@prisma/client", "vitest"]));
  });

  it("does not support Cypher", async () => {
    expect(store.supportsCypher).toBe(false);
    await expect(store.cypher("MATCH (n) RETURN n")).rejects.toThrow(/Neo4j/);
  });
});

describe("search", () => {
  it("finds symbols by keyword, identifier fragments and path", async () => {
    const hits = await store.search("findUser", { mode: "fts", limit: 5 });
    expect(hits[0].name).toBe("findUser");
    expect(hits[0].matchedBy).toEqual(["fts"]);
    const frag = await store.search("normalize", { mode: "fts", limit: 5 });
    expect(frag.map((h) => h.name)).toContain("normalizeId");
    const byPath = await store.search("routes", { mode: "fts", limit: 5 });
    expect(byPath.some((h) => (h.path ?? "").includes("routes"))).toBe(true);
  });

  it("filters by kind and falls back to keyword mode without embeddings", async () => {
    const files = await store.search("users", { mode: "fts", kind: "File", limit: 10 });
    expect(files.every((h) => h.kind === "File")).toBe(true);
    const auto = await store.search("clamp", { limit: 5 });
    expect(auto[0].matchedBy).toEqual(["fts"]);
    await expect(store.search("clamp", { mode: "vector" })).rejects.toThrow(/--embed/);
  });
});
