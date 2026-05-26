import { NextResponse, type NextRequest } from "next/server";
import { listPrFiles } from "@/lib/github";
import { getPrSubgraph } from "@/lib/neo4j";
import { computeReadingPath, type PrFileMeta } from "@/lib/reading-path";
import { parsePatch } from "@/lib/diff";

interface Params {
  params: Promise<{ owner: string; repo: string; number: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { owner, repo, number: numberStr } = await params;
  const number = Number.parseInt(numberStr, 10);
  if (!Number.isFinite(number) || number <= 0) {
    return NextResponse.json(
      { error: `Invalid PR number: "${numberStr}"` },
      { status: 400 },
    );
  }

  try {
    // 1. PR's changed file list from GitHub. Ignore removed files — there's
    //    nothing to spatially review on a deleted file (it might still appear
    //    as a caller in Neo4j but that's a different concern).
    const prFiles = await listPrFiles(owner, repo, number);
    const relevant = prFiles.filter((f) => f.status !== "removed");
    const filenames = relevant.map((f) => f.filename);

    // Build the per-filename metadata map: PR stats + parsed diff hunks.
    // computeReadingPath joins this onto each entry.
    const fileMeta = new Map<string, PrFileMeta>();
    for (const f of relevant) {
      fileMeta.set(f.filename, {
        additions: f.additions,
        deletions: f.deletions,
        status: f.status,
        diff: parsePatch(f.patch),
      });
    }

    if (filenames.length === 0) {
      return NextResponse.json({
        entries: [],
        unmatched: [],
        edges: [],
        meta: {
          matchedCount: 0,
          unmatchedCount: 0,
          edgeCount: 0,
          entryCount: 0,
          maxLevel: 0,
        },
        prFileCount: prFiles.length,
      });
    }

    // 2. Resolve file nodes + IMPORTS edges in Neo4j.
    const subgraph = await getPrSubgraph(filenames);

    // 3. Run BFS, joining in the PR file metadata per entry.
    const path = computeReadingPath(subgraph, fileMeta);

    return NextResponse.json({
      ...path,
      prFileCount: prFiles.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
