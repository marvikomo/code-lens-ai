import { NextResponse, type NextRequest } from "next/server";
import { listPrFiles, getFileContent } from "@/lib/github";
import { parseHunks } from "@/lib/diff";
import { buildFileView, buildAddedFileView } from "@/lib/file-view";

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

    return NextResponse.json({
      path,
      status: target.status,
      headSha,
      view,
      changeLineIndices,
      stats: { additions: target.additions, deletions: target.deletions },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
