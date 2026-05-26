import { NextResponse, type NextRequest } from "next/server";
import { listOpenPrs } from "@/lib/github";

interface Params {
  params: Promise<{ owner: string; repo: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { owner, repo } = await params;
  try {
    const prs = await listOpenPrs(owner, repo);
    return NextResponse.json({ prs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
