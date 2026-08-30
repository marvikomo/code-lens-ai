/**
 * Local graph analytics — the replacement for the `gds.*` calls.
 *
 * Determinism gets the most coverage here on purpose. Community ids are the
 * key that `label_community` writes agent-authored labels against, so an
 * assignment that drifts between identical runs silently re-points those
 * labels at the wrong files. graphify shipped a fix for exactly this failure,
 * caused by a graph library yielding an undirected edge's endpoints in a
 * different order.
 */
import {
  computeFileMetrics,
  FileVertex,
  ImportEdge,
} from "../clustering/graph-metrics";

/** Two triangles joined by a single bridge — an unambiguous 2-community graph. */
const TWO_CLUSTERS: { files: FileVertex[]; edges: ImportEdge[] } = {
  files: ["a", "b", "c", "d", "e", "f"].map((id) => ({ id })),
  edges: [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
    { from: "d", to: "e" },
    { from: "e", to: "f" },
    { from: "f", to: "d" },
    { from: "c", to: "d" },
  ],
};

describe("community detection", () => {
  it("separates two densely-connected groups", () => {
    const { byFile, communityCount } = computeFileMetrics(
      TWO_CLUSTERS.files,
      TWO_CLUSTERS.edges,
    );
    expect(communityCount).toBe(2);
    const c = (id: string) => byFile.get(id)!.community;
    expect(c("a")).toBe(c("b"));
    expect(c("b")).toBe(c("c"));
    expect(c("d")).toBe(c("e"));
    expect(c("e")).toBe(c("f"));
    expect(c("a")).not.toBe(c("d"));
  });

  it("reports modularity so partition quality is observable", () => {
    const { modularity } = computeFileMetrics(
      TWO_CLUSTERS.files,
      TWO_CLUSTERS.edges,
    );
    expect(modularity).toBeGreaterThan(0.3);
  });

  it("produces identical output across repeated runs", () => {
    const runs = Array.from({ length: 5 }, () =>
      JSON.stringify([
        ...computeFileMetrics(TWO_CLUSTERS.files, TWO_CLUSTERS.edges).byFile,
      ]),
    );
    expect(new Set(runs).size).toBe(1);
  });

  it("is unaffected by the order files and edges arrive in", () => {
    const forward = computeFileMetrics(TWO_CLUSTERS.files, TWO_CLUSTERS.edges);
    const reversed = computeFileMetrics(
      [...TWO_CLUSTERS.files].reverse(),
      [...TWO_CLUSTERS.edges].reverse(),
    );
    for (const [id, metrics] of forward.byFile) {
      expect(reversed.byFile.get(id)!.community).toBe(metrics.community);
    }
  });

  it("is unaffected by which way round an undirected edge is written", () => {
    // The canonicalization guard: `c->d` and `d->c` must cluster identically.
    const flipped = TWO_CLUSTERS.edges.map((e) =>
      e.from === "c" && e.to === "d" ? { from: "d", to: "c" } : e,
    );
    const base = computeFileMetrics(TWO_CLUSTERS.files, TWO_CLUSTERS.edges);
    const swapped = computeFileMetrics(TWO_CLUSTERS.files, flipped);
    for (const [id, metrics] of base.byFile) {
      expect(swapped.byFile.get(id)!.community).toBe(metrics.community);
    }
  });
});

describe("pagerank", () => {
  it("ranks a hub above its leaves", () => {
    const files = ["hub", "l1", "l2", "l3", "l4"].map((id) => ({ id }));
    const edges = ["l1", "l2", "l3", "l4"].map((l) => ({ from: l, to: "hub" }));
    const { byFile } = computeFileMetrics(files, edges);
    const hub = byFile.get("hub")!.pagerank;
    for (const leaf of ["l1", "l2", "l3", "l4"]) {
      expect(hub).toBeGreaterThan(byFile.get(leaf)!.pagerank);
    }
  });

  it("keeps the score vector normalized", () => {
    const { byFile } = computeFileMetrics(
      TWO_CLUSTERS.files,
      TWO_CLUSTERS.edges,
    );
    const total = [...byFile.values()].reduce((s, m) => s + m.pagerank, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

describe("blast radius", () => {
  it("counts direct and transitive importers separately", () => {
    // chain: d -> c -> b -> a  (a is imported by b, reached by c and d)
    const files = ["a", "b", "c", "d"].map((id) => ({ id }));
    const edges = [
      { from: "b", to: "a" },
      { from: "c", to: "b" },
      { from: "d", to: "c" },
    ];
    const { byFile } = computeFileMetrics(files, edges);
    const a = byFile.get("a")!;
    expect(a.blastDirect).toBe(1);
    expect(a.blastTransitive).toBe(2);
    expect(a.blastScore).toBe(1 + 0.5 * 2);
  });

  it("respects the hop cap", () => {
    const files = ["n0", "n1", "n2", "n3", "n4"].map((id) => ({ id }));
    const edges = [
      { from: "n1", to: "n0" },
      { from: "n2", to: "n1" },
      { from: "n3", to: "n2" },
      { from: "n4", to: "n3" },
    ];
    const { byFile } = computeFileMetrics(files, edges, { blastMaxHops: 2 });
    // Only n1 (1 hop) and n2 (2 hops) are within the cap.
    expect(byFile.get("n0")!.blastDirect).toBe(1);
    expect(byFile.get("n0")!.blastTransitive).toBe(1);
  });

  it("terminates on an import cycle", () => {
    const files = ["a", "b", "c"].map((id) => ({ id }));
    const edges = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ];
    const { byFile } = computeFileMetrics(files, edges);
    expect(byFile.get("a")!.blastDirect).toBe(1);
    expect(byFile.get("a")!.blastTransitive).toBe(1);
  });
});

describe("spine selection", () => {
  it("tags the top-pagerank file in each community", () => {
    const { byFile } = computeFileMetrics(
      TWO_CLUSTERS.files,
      TWO_CLUSTERS.edges,
      { spinePagerank: 1, spineBoundary: 0 },
    );
    const spineByCommunity = new Map<number, string[]>();
    for (const [id, m] of byFile) {
      if (!m.isCore) continue;
      spineByCommunity.set(m.community, [
        ...(spineByCommunity.get(m.community) ?? []),
        id,
      ]);
    }
    expect(spineByCommunity.size).toBe(2);
    for (const members of spineByCommunity.values()) {
      expect(members).toHaveLength(1);
    }
  });

  it("also tags boundary-spanning files", () => {
    // c and d straddle the bridge, so both have boundary degree 1.
    const { byFile } = computeFileMetrics(
      TWO_CLUSTERS.files,
      TWO_CLUSTERS.edges,
      { spinePagerank: 0, spineBoundary: 1 },
    );
    expect(byFile.get("c")!.boundary).toBe(1);
    expect(byFile.get("d")!.boundary).toBe(1);
    expect(byFile.get("c")!.isCore).toBe(true);
    expect(byFile.get("d")!.isCore).toBe(true);
  });
});

describe("edge cases", () => {
  it("handles an empty graph", () => {
    const result = computeFileMetrics([], []);
    expect(result.byFile.size).toBe(0);
    expect(result.communityCount).toBe(0);
  });

  it("scores isolated files instead of dropping them", () => {
    const { byFile } = computeFileMetrics(
      [{ id: "lonely" }, { id: "a" }, { id: "b" }],
      [{ from: "a", to: "b" }],
    );
    expect(byFile.has("lonely")).toBe(true);
    expect(byFile.get("lonely")!.blastScore).toBe(0);
  });

  it("ignores self-imports and edges to unknown files", () => {
    const { byFile } = computeFileMetrics(
      [{ id: "a" }, { id: "b" }],
      [
        { from: "a", to: "a" },
        { from: "a", to: "ghost" },
        { from: "a", to: "b" },
      ],
    );
    expect(byFile.get("b")!.blastDirect).toBe(1);
    expect(byFile.get("a")!.blastDirect).toBe(0);
  });
});
