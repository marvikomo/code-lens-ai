import { NextResponse } from "next/server";
import { listIndexedRepos } from "@/lib/neo4j";

export async function GET() {
  try {
    const repos = await listIndexedRepos();
    return NextResponse.json({ repos });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
