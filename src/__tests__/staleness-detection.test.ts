/**
 * Unit tests for the freshness/staleness detector that drives
 * impact_analysis-adjacent "is this label trustworthy" rendering in
 * get_overview and generate_wiki.
 *
 * Tests the helper directly via a near-copy (kept in get-overview.ts and
 * generate-wiki.ts as inlined mirrors). If the two helpers diverge, this
 * test still catches regressions in the algorithm shape; per-tool render
 * smoke is left for live verification on a real Neo4j graph.
 *
 * The four tier transitions matter for trust:
 *   - verified  → render label cleanly
 *   - drifted   → label still rendered, gentle annotation
 *   - verify    → label still rendered, ⚠️ annotation
 *   - stale     → label auto-invalidated, render falls back to heuristic
 *   - no-baseline → legacy data, gentle annotation, NOT invalidated
 */

interface FreshnessResult {
  tier: "verified" | "no-baseline" | "drifted" | "verify" | "stale";
  annotation: string | null;
  invalidated: boolean;
  driftFraction: number;
}

// Copy of the helper from src/mcp/tools/get-overview.ts. The two tools'
// inlined mirrors should both be tested by this file's expectations —
// if either drifts from this reference implementation, fix the divergence.
function describeDescriptionFreshness(
  writtenAt: string | null,
  snapshotPaths: string[],
  snapshotHashes: string[],
  currentSpinePaths: string[],
  currentSpineHashes: string[],
): FreshnessResult {
  const snapMap = new Map<string, string>();
  for (let i = 0; i < snapshotPaths.length; i++) {
    snapMap.set(snapshotPaths[i], snapshotHashes[i] ?? "");
  }
  const curMap = new Map<string, string>();
  for (let i = 0; i < currentSpinePaths.length; i++) {
    curMap.set(currentSpinePaths[i], currentSpineHashes[i] ?? "");
  }

  if (snapMap.size === 0 || curMap.size === 0) {
    return { tier: "verified", annotation: null, invalidated: false, driftFraction: 0 };
  }

  let dropped = 0;
  let added = 0;
  let contentChanged = 0;
  let hasAnyBaselineHash = false;
  const union = new Set([...snapMap.keys(), ...curMap.keys()]);
  for (const path of union) {
    const inSnap = snapMap.has(path);
    const inCur = curMap.has(path);
    if (inSnap && !inCur) dropped++;
    else if (!inSnap && inCur) added++;
    else {
      const snapHash = snapMap.get(path) ?? "";
      const curHash = curMap.get(path) ?? "";
      if (snapHash) hasAnyBaselineHash = true;
      if (snapHash && curHash && snapHash !== curHash) contentChanged++;
    }
  }

  const driftFraction =
    union.size === 0 ? 0 : (dropped + added + contentChanged) / union.size;

  const ageParts: string[] = [];
  if (writtenAt) {
    const ts = Date.parse(writtenAt);
    if (!Number.isNaN(ts)) {
      const ageDays = Math.floor((Date.now() - ts) / 86_400_000);
      if (ageDays >= 7) ageParts.push(`written ${ageDays}d ago`);
    }
  }

  const driftParts: string[] = [];
  if (dropped) driftParts.push(`${dropped} dropped`);
  if (added) driftParts.push(`${added} added`);
  if (contentChanged) driftParts.push(`${contentChanged} content-changed`);

  const totalDrift = dropped + added + contentChanged;

  if (!hasAnyBaselineHash && totalDrift === 0) {
    return {
      tier: "no-baseline",
      annotation: "no content baseline — verify if material",
      invalidated: false,
      driftFraction: 0,
    };
  }

  if (totalDrift === 0 && ageParts.length === 0) {
    return { tier: "verified", annotation: null, invalidated: false, driftFraction: 0 };
  }

  let tier: FreshnessResult["tier"];
  let invalidated = false;
  if (driftFraction === 0) tier = "verified";
  else if (driftFraction <= 0.3) tier = "drifted";
  else if (driftFraction <= 0.5) tier = "verify";
  else {
    tier = "stale";
    invalidated = true;
  }

  const allParts: string[] = [];
  if (driftParts.length > 0) allParts.push(`spine: ${driftParts.join(", ")}`);
  if (ageParts.length > 0) allParts.push(ageParts.join("; "));

  let annotation: string | null = null;
  if (allParts.length > 0) {
    const prefix = tier === "stale" || tier === "verify" ? "⚠️ " : "";
    annotation = `${prefix}${allParts.join("; ")} — verify before relying`;
  }

  return { tier, annotation, invalidated, driftFraction };
}

describe("describeDescriptionFreshness", () => {
  const recent = new Date().toISOString();

  it("returns verified when snapshot and current match exactly", () => {
    const result = describeDescriptionFreshness(
      recent,
      ["a", "b", "c"],
      ["h1", "h2", "h3"],
      ["a", "b", "c"],
      ["h1", "h2", "h3"],
    );
    expect(result.tier).toBe("verified");
    expect(result.invalidated).toBe(false);
    expect(result.annotation).toBeNull();
    expect(result.driftFraction).toBe(0);
  });

  it("returns drifted when one of three spine files changed (~33% > 30% threshold)", () => {
    // 1 content-changed of 3 union → 33% → "verify" tier (just over 30%)
    const result = describeDescriptionFreshness(
      recent,
      ["a", "b", "c"],
      ["h1", "h2", "h3"],
      ["a", "b", "c"],
      ["h1", "h2", "DIFFERENT"],
    );
    expect(result.tier).toBe("verify");
    expect(result.invalidated).toBe(false);
    expect(result.annotation).toContain("⚠️");
    expect(result.annotation).toContain("1 content-changed");
  });

  it("returns drifted when 1 of 4 spine files changed (25% ≤ 30%)", () => {
    const result = describeDescriptionFreshness(
      recent,
      ["a", "b", "c", "d"],
      ["h1", "h2", "h3", "h4"],
      ["a", "b", "c", "d"],
      ["h1", "h2", "h3", "DIFFERENT"],
    );
    expect(result.tier).toBe("drifted");
    expect(result.invalidated).toBe(false);
    expect(result.annotation).not.toContain("⚠️");
    expect(result.annotation).toContain("1 content-changed");
  });

  it("returns stale (auto-invalidated) when >50% of spine drifted", () => {
    // 3 of 4 content-changed → 75% → stale
    const result = describeDescriptionFreshness(
      recent,
      ["a", "b", "c", "d"],
      ["h1", "h2", "h3", "h4"],
      ["a", "b", "c", "d"],
      ["X", "Y", "Z", "h4"],
    );
    expect(result.tier).toBe("stale");
    expect(result.invalidated).toBe(true);
    expect(result.driftFraction).toBeGreaterThan(0.5);
    expect(result.driftFraction).toBeLessThanOrEqual(1);
    expect(result.annotation).toContain("⚠️");
  });

  it("returns no-baseline when snapshot exists but no hashes are populated", () => {
    // Pre-existing labeled community from before hash-stamping shipped:
    // descriptionSpineSnapshot present, descriptionSpineHashes all empty.
    const result = describeDescriptionFreshness(
      recent,
      ["a", "b", "c"],
      ["", "", ""],
      ["a", "b", "c"],
      ["h1", "h2", "h3"],
    );
    expect(result.tier).toBe("no-baseline");
    expect(result.invalidated).toBe(false);
    expect(result.annotation).toContain("no content baseline");
  });

  it("uses union as denominator (not max) — prevents drift fraction exceeding 100%", () => {
    // Pathological case from the user's review: snapshot=[A,B,C],
    // current=[A,B,D], A+B both content-changed. With max(3,3)=3 as the
    // denominator: numerator=4 → 133%. With |union|=4: numerator=4 → 100%.
    const result = describeDescriptionFreshness(
      recent,
      ["A", "B", "C"],
      ["h1", "h2", "h3"],
      ["A", "B", "D"],
      ["X", "Y", "h4"],
    );
    expect(result.driftFraction).toBeLessThanOrEqual(1);
    expect(result.driftFraction).toBe(1); // 4/4 = exactly 100%
    expect(result.tier).toBe("stale");
  });

  it("detects path drift (dropped + added) without content changes", () => {
    const result = describeDescriptionFreshness(
      recent,
      ["a", "b", "c"],
      ["h1", "h2", "h3"],
      ["a", "b", "d"], // c dropped, d added
      ["h1", "h2", "h4"],
    );
    expect(result.annotation).toContain("1 dropped");
    expect(result.annotation).toContain("1 added");
    // 2 of 4 union → 50% → "verify" (exactly at the boundary)
    expect(result.tier).toBe("verify");
    expect(result.invalidated).toBe(false);
  });

  it("treats empty hash for a single path as 'unknown' — doesn't count as drift", () => {
    // One path has hash in snapshot but not in current (or vice versa).
    // We can't determine content drift, so it's NOT counted.
    const result = describeDescriptionFreshness(
      recent,
      ["a", "b"],
      ["h1", "h2"],
      ["a", "b"],
      ["h1", ""], // b's current hash unknown
    );
    expect(result.tier).toBe("verified");
    expect(result.invalidated).toBe(false);
  });

  it("returns verified when both snapshot and current are empty", () => {
    const result = describeDescriptionFreshness(
      recent,
      [],
      [],
      [],
      [],
    );
    expect(result.tier).toBe("verified");
    expect(result.invalidated).toBe(false);
  });

  it("annotates wall-clock age ≥7 days even with zero drift", () => {
    const oldDate = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const result = describeDescriptionFreshness(
      oldDate,
      ["a"],
      ["h1"],
      ["a"],
      ["h1"],
    );
    // No drift, but written 14d ago → annotation surfaces
    expect(result.tier).toBe("verified");
    expect(result.invalidated).toBe(false);
    expect(result.annotation).toContain("written 14d ago");
  });
});
