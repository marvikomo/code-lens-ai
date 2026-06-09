import { NextResponse, type NextRequest } from "next/server";
import { listPrFiles, getFileContent } from "@/lib/github";
import { parseHunks, type Hunk } from "@/lib/diff";
import { buildFileView, buildAddedFileView } from "@/lib/file-view";
import { getPrSubgraph, getOutsidePrCallers } from "@/lib/neo4j";

interface Params {
  params: Promise<{ owner: string; repo: string; number: string }>;
}

/**
 * Returns a "full file view" for one file in a PR. The reader pane uses
 * this to render the entire file at HEAD with diff highlights overlaid.
 *
 * Query: ?path=<repo-relative-filename>
 *
 * Response shape:
 *   {
 *     path, status, headSha,
 *     view: FileViewLine[],
 *     changeLineIndices: number[],
 *     stats: { additions, deletions },
 *   }
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { owner, repo, number: numberStr } = await params;
  const number = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(number) || number <= 0) {
    return NextResponse.json(
      { error: `Invalid PR number: "${numberStr}"` },
      { status: 400 },
    );
  }
  const url = new URL(req.url);
  const path = url.searchParams.get("path");
  if (!path) {
    return NextResponse.json({ error: "Missing ?path=" }, { status: 400 });
  }

  try {
    // Fetch the PR's file list to get the patch + headSha for THIS file.
    // We refetch even though the reading-path endpoint also gets this — the
    // file route is the source of truth for the reader pane and we don't
    // want stale per-PR state cached across separate API calls.
    const prFiles = await listPrFiles(owner, repo, number);
    const target = prFiles.find((f) => f.filename === path);
    if (!target) {
      return NextResponse.json(
        { error: `File "${path}" not in PR #${number}` },
        { status: 404 },
      );
    }

    if (target.status === "removed") {
      return NextResponse.json(
        { error: `File "${path}" was removed; full-file view is N/A` },
        { status: 422 },
      );
    }

    // The PR's head SHA is on the PR endpoint, not on each file. Fetch the
    // PR object to get it.
    // (We could plumb this through listPrFiles, but a single extra call here
    //  keeps the data model clean and the reading-path route fast.)
    const prRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      },
    );
    if (!prRes.ok) {
      const body = await prRes.text().catch(() => "");
      throw new Error(`PR fetch failed: ${prRes.status} — ${body.slice(0, 200)}`);
    }
    const prJson = (await prRes.json()) as { head?: { sha?: string } };
    const headSha = prJson.head?.sha;
    if (!headSha) {
      return NextResponse.json(
        { error: "Could not determine PR head SHA" },
        { status: 500 },
      );
    }

    const hunks = parseHunks(target.patch);

    // For added files there's no base to fetch — the patch IS the file.
    if (target.status === "added") {
      const { view, changeLineIndices } = buildAddedFileView(hunks);
      return NextResponse.json({
        path,
        status: target.status,
        headSha,
        view,
        changeLineIndices,
        stats: { additions: target.additions, deletions: target.deletions },
      });
    }

    // No hunks (binary, too large) → tell the client up-front.
    if (hunks.length === 0) {
      return NextResponse.json(
        {
          error:
            target.patch === undefined
              ? "GitHub returned no patch (file may be binary or exceed the 150KB patch size limit)."
              : "Patch had no parseable hunks.",
          path,
          status: target.status,
        },
        { status: 422 },
      );
    }

    // Modified / renamed: fetch the HEAD content and overlay the diff.
    const headContent = await getFileContent(owner, repo, headSha, path);
    const { view, changeLineIndices } = buildFileView(headContent, hunks);

    // Outside-PR callers — fetch in parallel with the file content, except
    // we already awaited that. Run as a separate awaited call here. Cheap
    // optimization later: cache subgraph by (owner, repo, number) in-process
    // so reader prev/next doesn't re-query.
    const outsideCallers = await loadOutsideCallers({
      filename: path,
      hunks,
      prFiles: prFiles.filter((f) => f.status !== "removed").map((f) => f.filename),
    });

    return NextResponse.json({
      path,
      status: target.status,
      headSha,
      view,
      changeLineIndices,
      stats: { additions: target.additions, deletions: target.deletions },
      outsideCallers,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Resolves this file in Neo4j, computes the changed HEAD line ranges from
 * hunks, and asks Neo4j for callers OUTSIDE the PR's file set. Returns
 * an empty array if the file isn't indexed (the reader still works without
 * the callers section).
 */
async function loadOutsideCallers({
  filename,
  hunks,
  prFiles,
}: {
  filename: string;
  hunks: Hunk[];
  prFiles: string[];
}) {
  try {
    const subgraph = await getPrSubgraph(prFiles);
    const target = subgraph.nodes.find((n) => n.matchedPath === filename);
    if (!target) return []; // file not indexed; can't trace callers
    const prAbsPaths = subgraph.nodes.map((n) => n.absolutePath);
    const changedRanges = changedRangesFromHunks(hunks);
    return await getOutsidePrCallers(
      target.absolutePath,
      changedRanges,
      prAbsPaths,
    );
  } catch (err) {
    // Defensive: don't kill the whole response if Neo4j is unreachable.
    // The reader pane gracefully shows no-callers and the diff still works.
    console.error("[file route] outside-callers query failed:", err);
    return [];
  }
}

/**
 * Convert GitHub unified-diff hunks to 0-indexed ranges in the BASE file.
 *
 * Why BASE not HEAD: the indexed Neo4j graph reflects whatever was indexed
 * (typically main / base). Function startRow/endRow values come from THAT
 * code. The PR's HEAD has shifted line numbers due to added/removed lines,
 * so HEAD line numbers don't match indexed function ranges.
 *
 * Concretely: createTopic at base lines 27-32 with PR adding 10 lines before
 * it → at HEAD it's at lines 37-42. Querying with HEAD range [37, 42] won't
 * match the indexed function (whose range is still [27, 32]).
 *
 * For modified / removed lines this works correctly. For purely added regions
 * (where baseCount = 0), the range collapses to a single line — we won't
 * find matching indexed functions, which is correct: those functions don't
 * exist in base, so they have no pre-existing callers.
 *
 * Uses the full base hunk range (including context lines) — this over-reports
 * slightly when a function only overlaps a context line, but the trade is
 * "false positive: function flagged when not really touched" vs "false
 * negative: missed caller." We prefer the false positive.
 */
function changedRangesFromHunks(
  hunks: Hunk[],
): Array<{ start: number; end: number }> {
  return hunks
    .filter((h) => h.baseCount > 0) // skip pure-add hunks (no base range)
    .map((h) => {
      const start = h.baseStartLine - 1;
      const end = start + h.baseCount - 1;
      return { start, end };
    });
}
