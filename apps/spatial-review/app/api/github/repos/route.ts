import { NextResponse } from "next/server";
import { listMyRepos } from "@/lib/github";

export async function GET() {
  try {
    const repos = await listMyRepos();
    return NextResponse.json({ repos });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
