/**
 * Builds a "full file view" with the diff overlaid: every line in the HEAD
 * file is emitted, and removed lines from the patch are inserted as
 * "removed-ghost" lines at their original positions so the reviewer sees
 * what was there without doing a mental diff.
 *
 * Algorithm:
 *   1. Walk the HEAD file line-by-line.
 *   2. When we hit a hunk's headStartLine, switch to emitting the hunk's
 *      interleaved lines (context + added + removed-ghost). Skip ahead in
 *      the HEAD file by the hunk's headCount.
 *   3. Continue with HEAD file lines until the next hunk.
 *
 * The hunk's `context` lines duplicate what's in the HEAD file at that range,
 * which is what we want — we use the hunk's content for the in-hunk region
 * (so we can also emit the removed-ghost lines), and the HEAD file lines for
 * everything outside hunks.
 */
import type { Hunk } from "./diff";

export type FileViewLineKind = "context" | "added" | "removed-ghost";

export interface FileViewLine {
  kind: FileViewLineKind;
  text: string;
  /** Line number in the HEAD file. null for removed-ghost (not present in HEAD). */
  headLine: number | null;
  /** Line number in the base file. null for added lines (not present in base). */
  baseLine: number | null;
  /** True if this line is part of a change region (added, removed-ghost,
   *  or context inside a hunk that touches changes). Used to compute
   *  changeLineIndices for "jump to first change". */
  isChange: boolean;
}

export function buildFileView(
  headContent: string,
  hunks: Hunk[],
): { view: FileViewLine[]; changeLineIndices: number[] } {
  const headLines = headContent.split("\n");
  // Remove a trailing empty line that comes from a trailing newline in the
  // file content — common, and would render as an empty line at the end.
  if (headLines.length > 0 && headLines[headLines.length - 1] === "") {
    headLines.pop();
  }

  // Sort hunks by head start, defensive.
  const sortedHunks = [...hunks].sort(
    (a, b) => a.headStartLine - b.headStartLine,
  );

  const view: FileViewLine[] = [];
  const changeLineIndices: number[] = [];
  let cursor = 0; // 0-indexed into headLines (next line to emit)

  for (const hunk of sortedHunks) {
    // Emit head lines BEFORE this hunk (plain context, not part of a change).
    const hunkStartIdx = hunk.headStartLine - 1; // 0-indexed
    while (cursor < hunkStartIdx && cursor < headLines.length) {
      view.push({
        kind: "context",
        text: headLines[cursor],
        headLine: cursor + 1,
        baseLine: null, // not strictly true but we don't track base for non-hunk regions
        isChange: false,
      });
      cursor++;
    }

    // Emit the hunk's interleaved lines.
    let hunkHeadLineNum = hunk.headStartLine;
    let hunkBaseLineNum = hunk.baseStartLine;
    for (const hl of hunk.lines) {
      if (hl.kind === "context") {
        view.push({
          kind: "context",
          text: hl.text,
          headLine: hunkHeadLineNum,
          baseLine: hunkBaseLineNum,
          isChange: false,
        });
        hunkHeadLineNum++;
        hunkBaseLineNum++;
      } else if (hl.kind === "added") {
        view.push({
          kind: "added",
          text: hl.text,
          headLine: hunkHeadLineNum,
          baseLine: null,
          isChange: true,
        });
        changeLineIndices.push(view.length - 1);
        hunkHeadLineNum++;
      } else if (hl.kind === "removed") {
        view.push({
          kind: "removed-ghost",
          text: hl.text,
          headLine: null,
          baseLine: hunkBaseLineNum,
          isChange: true,
        });
        changeLineIndices.push(view.length - 1);
        hunkBaseLineNum++;
      }
      // hunk-separator can't appear inside a Hunk; skip
    }
    // Skip ahead in HEAD file past the lines this hunk consumed.
    cursor = hunkStartIdx + hunk.headCount;
  }

  // Emit remaining HEAD lines after the last hunk.
  while (cursor < headLines.length) {
    view.push({
      kind: "context",
      text: headLines[cursor],
      headLine: cursor + 1,
      baseLine: null,
      isChange: false,
    });
    cursor++;
  }

  return { view, changeLineIndices };
}

/**
 * Special case: an "added" file has no HEAD baseline OR base content. The
 * patch IS the entire file. Emit all the patch's added lines (and any context
 * that happens to be there, though normally there's none for added files).
 */
export function buildAddedFileView(hunks: Hunk[]): {
  view: FileViewLine[];
  changeLineIndices: number[];
} {
  const view: FileViewLine[] = [];
  const changeLineIndices: number[] = [];
  for (const hunk of hunks) {
    let lineNum = hunk.headStartLine;
    for (const hl of hunk.lines) {
      if (hl.kind === "added" || hl.kind === "context") {
        view.push({
          kind: hl.kind === "added" ? "added" : "context",
          text: hl.text,
          headLine: lineNum,
          baseLine: null,
          isChange: hl.kind === "added",
        });
        if (hl.kind === "added") changeLineIndices.push(view.length - 1);
        lineNum++;
      }
      // No "removed" lines on an added file.
    }
  }
  return { view, changeLineIndices };
}
