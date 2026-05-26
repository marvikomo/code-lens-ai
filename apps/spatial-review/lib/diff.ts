/**
 * Unified-diff parser.
 *
 * Two exported shapes:
 *   - parsePatch(patch) → DiffLine[]      (flat — for the compact card / hunk-only view)
 *   - parseHunks(patch) → Hunk[]          (structured — for the full-file view that
 *                                          overlays the diff onto the HEAD file)
 *
 * GitHub's `patch` field is a unified-diff string. Hunk headers look like:
 *   @@ -10,5 +10,7 @@
 * Meaning: base file lines 10..14 (5 lines) replaced by HEAD lines 10..16 (7 lines).
 *
 * We don't need a full diff parser — just enough to identify hunks and classify
 * each line.
 */

export type DiffLineKind = "context" | "added" | "removed" | "hunk-separator";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content, sans the leading +/-/space prefix. Empty for separators. */
  text: string;
}

export interface Hunk {
  /** 1-indexed line in the base file where the hunk starts. */
  baseStartLine: number;
  /** Number of base-file lines consumed by this hunk (context + removed). */
  baseCount: number;
  /** 1-indexed line in the HEAD file where the hunk starts. */
  headStartLine: number;
  /** Number of HEAD-file lines consumed by this hunk (context + added). */
  headCount: number;
  /** The hunk's content lines in order (context / added / removed). */
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Returns structured hunks. Use this for the full-file view. Each hunk's
 * `lines` array is interleaved (the order in which they appear in the patch),
 * which preserves the spatial relationship between added and removed lines
 * within a hunk.
 */
export function parseHunks(patch: string | undefined | null): Hunk[] {
  if (!patch) return [];
  const out: Hunk[] = [];
  const lines = patch.split("\n");
  let current: Hunk | null = null;
  for (const raw of lines) {
    const m = raw.match(HUNK_HEADER);
    if (m) {
      if (current) out.push(current);
      current = {
        baseStartLine: Number(m[1]),
        baseCount: m[2] ? Number(m[2]) : 1,
        headStartLine: Number(m[3]),
        headCount: m[4] ? Number(m[4]) : 1,
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.lines.push({ kind: "added", text: raw.slice(1) });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      current.lines.push({ kind: "removed", text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      current.lines.push({ kind: "context", text: raw.slice(1) });
    } else if (raw === "") {
      current.lines.push({ kind: "context", text: "" });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" — skip
      continue;
    } else {
      current.lines.push({ kind: "context", text: raw });
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Flat parser used by the (legacy) compact diff view. Delegates to parseHunks
 * and inserts a "hunk-separator" pseudo-line between hunks so the UI can
 * render the gap between non-contiguous changes.
 */
export function parsePatch(patch: string | undefined | null): DiffLine[] {
  const hunks = parseHunks(patch);
  if (hunks.length === 0) return [];
  const out: DiffLine[] = [];
  hunks.forEach((h, i) => {
    if (i > 0) out.push({ kind: "hunk-separator", text: "" });
    out.push(...h.lines);
  });
  return out;
}
