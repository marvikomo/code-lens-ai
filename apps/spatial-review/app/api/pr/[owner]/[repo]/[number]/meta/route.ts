import { NextResponse, type NextRequest } from "next/server";
import { getPr, listPrCommits } from "@/lib/github";

interface Params {
  params: Promise<{ owner: string; repo: string; number: string }>;
}

/**
 * Returns the PR's metadata: title, description, author, dates, SHAs, plus
 * the list of commits in the PR. Used by the reading-path page header so
 * the reviewer sees the author's intent without having to flip to GitHub.
 *
 * Cache: no-store. PRs change (titles edited, commits added) and we want
 * the freshest read on each canvas load.
 */
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
    // Fetch PR + commits in parallel — two independent GitHub calls.
    const [pr, commits] = await Promise.all([
      getPr(owner, repo, number),
      listPrCommits(owner, repo, number),
    ]);
    return NextResponse.json({ pr, commits });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
