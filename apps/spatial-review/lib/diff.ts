/**
 * Tiny unified-diff parser. Just enough to render the green/red gutter UI
 * we want — not a full diff parser.
 *
 * GitHub's `patch` field is a unified-diff string with hunk headers like:
 *   @@ -10,5 +10,7 @@
 *   context line
 *   -removed line
 *   +added line
 *   context line
 *
 * We split into lines, classify each, drop the @@ headers (we don't render
 * line numbers — too narrow in the card to be useful), and return a flat
 * array. Multiple hunks are concatenated with a "hunk separator" pseudo-line
 * so the UI can show a gap between non-contiguous changes.
 */

export type DiffLineKind = "context" | "added" | "removed" | "hunk-separator";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line content, sans the leading +/-/space prefix. Empty for separators. */
  text: string;
}

export function parsePatch(patch: string | undefined | null): DiffLine[] {
  if (!patch) return [];
  const out: DiffLine[] = [];
  const lines = patch.split("\n");
  let inHunk = false;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      if (inHunk && out.length > 0) {
        out.push({ kind: "hunk-separator", text: "" });
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      out.push({ kind: "added", text: raw.slice(1) });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      out.push({ kind: "removed", text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      out.push({ kind: "context", text: raw.slice(1) });
    } else if (raw === "") {
      // Blank context line (some diff producers emit them without leading space)
      out.push({ kind: "context", text: "" });
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file" marker — skip
      continue;
    } else {
      // Defensive: anything else is treated as context (rare).
      out.push({ kind: "context", text: raw });
    }
  }
  // Trim trailing hunk-separator if any.
  while (out.length > 0 && out[out.length - 1].kind === "hunk-separator") {
    out.pop();
  }
  return out;
}
