import { NextResponse, type NextRequest } from "next/server";
import { runIndex } from "@/lib/codelens";

interface Params {
  params: Promise<{ owner: string; repo: string }>;
}

/**
 * Server-Sent Events stream of indexing progress.
 *
 * Client side: use EventSource('/api/index/owner/repo') and listen for
 * 'log', 'done', 'error' events.
 *
 * Why POST: the action has side effects (clones, writes Neo4j). EventSource
 * doesn't support POST natively — the client should use fetch() with a
 * ReadableStream reader instead (or upgrade to WebSocket later). For Day 2
 * prototype, we accept GET too as a convenience.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  return handle(params);
}

export async function POST(_req: NextRequest, { params }: Params) {
  return handle(params);
}

async function handle(params: Params["params"]) {
  const { owner, repo } = await params;

  if (!process.env.GITHUB_TOKEN) {
    return NextResponse.json(
      { error: "GITHUB_TOKEN not set in .env.local" },
      { status: 400 },
    );
  }

  const url = `https://github.com/${owner}/${repo}`;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: string): void => {
        // Standard SSE framing: event line + data line + blank line.
        const frame = `event: ${event}\ndata: ${data}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      send("log", `Starting index of ${owner}/${repo}...`);

      try {
        for await (const ev of runIndex({
          url,
          cluster: true,
          githubToken: process.env.GITHUB_TOKEN,
        })) {
          // SSE data cannot contain newlines in a single data: line.
          // We're already line-buffered upstream, so each ev.data is one
          // line — but be defensive and split on any stray newlines.
          const safe = ev.data.replaceAll("\n", " ");
          send(ev.type, safe);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send("error", msg);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Next.js / proxy buffering so events flush immediately.
      "X-Accel-Buffering": "no",
    },
  });
}
