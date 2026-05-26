import { NextResponse, type NextRequest } from "next/server";
import { listPrFiles } from "@/lib/github";
import { getPrSubgraph } from "@/lib/neo4j";
import { computeReadingPath } from "@/lib/reading-path";

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
    const filenames = prFiles
      .filter((f) => f.status !== "removed")
      .map((f) => f.filename);

    if (filenames.length === 0) {
      return NextResponse.json({
        entries: [],
        unmatched: [],
        meta: { matchedCount: 0, unmatchedCount: 0, edgeCount: 0, entryCount: 0 },
        prFileCount: prFiles.length,
      });
    }

    // 2. Resolve file nodes + IMPORTS edges in Neo4j.
    const subgraph = await getPrSubgraph(filenames);

    // 3. Run BFS to produce the deterministic reading path.
    const path = computeReadingPath(subgraph);

    return NextResponse.json({
      ...path,
      prFileCount: prFiles.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
