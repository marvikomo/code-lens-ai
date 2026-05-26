/**
 * Wraps spawning the parent codelens CLI as a child process and yielding
 * log lines as they arrive. Server-side only.
 *
 * For the prototype we invoke the LOCAL built CLI at ../../dist/cli.js.
 * Production (hosted version) would depend on @marvikomo/codelens-ai from
 * npm and invoke via `npx -y @marvikomo/codelens-ai`. The shape is the same
 * either way; only the executable path changes.
 *
 * codelens already supports HTTPS git URLs natively (see src/cli.ts in the
 * parent project — it clones into ~/.code-lens-aI/cache/ and indexes from
 * there). So we just pass the GitHub URL through; no clone management here.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";

const CLI_PATH = path.resolve(process.cwd(), "..", "..", "dist", "cli.js");

export interface IndexEvent {
  type: "log" | "done" | "error";
  /** For "log": the line text. For "done" / "error": a message. */
  data: string;
  /** Only set on "done". */
  exitCode?: number;
  /** Only set on "done" — milliseconds the index took. */
  elapsedMs?: number;
}

export interface IndexParams {
  /** GitHub URL, e.g. https://github.com/owner/repo */
  url: string;
  /** Whether to run Leiden clustering after indexing (recommended). */
  cluster?: boolean;
  /** Embed an access token into the URL for private-repo access. */
  githubToken?: string;
}

/**
 * Spawns `codelens index <url> ...flags` and returns an async iterator of
 * IndexEvents. The iterator completes when the child exits.
 *
 * Neo4j credentials are passed via env (the CLI reads NEO4J_URI/USER/PASSWORD
 * env vars per src/cli.ts:199-202).
 */
export async function* runIndex(
  params: IndexParams,
): AsyncIterable<IndexEvent> {
  const startedAt = Date.now();

  // Embed token into the URL for private repos. The CLI's resolveSource()
  // shells out to `git clone <url>`, so a token-embedded URL works without
  // any CLI changes. URL format: https://x-access-token:TOKEN@github.com/owner/repo
  let url = params.url;
  if (params.githubToken && url.startsWith("https://github.com/")) {
    url = url.replace(
      "https://github.com/",
      `https://x-access-token:${params.githubToken}@github.com/`,
    );
  }

  const args: string[] = [CLI_PATH, url, "--neo4j-clear"];
  if (params.cluster ?? true) args.push("--cluster");

  // Pass Neo4j creds via env (CLI picks them up). Stripping the token from
  // any log output: we replace it in stderr/stdout lines before forwarding.
  const child: ChildProcessWithoutNullStreams = spawn("node", args, {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const queue: IndexEvent[] = [];
  let waiter: (() => void) | null = null;
  let finished = false;
  let exitCode: number | null = null;

  const push = (ev: IndexEvent): void => {
    queue.push(ev);
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };

  const onLine = (line: string): void => {
    if (!line.trim()) return;
    // Defensive scrub: if the token leaks into a log line (e.g. via an
    // error message echoing the URL), redact it before forwarding.
    const scrubbed = params.githubToken
      ? line.replaceAll(params.githubToken, "REDACTED")
      : line;
    push({ type: "log", data: scrubbed });
  };

  const lineBuffer = (stream: NodeJS.ReadableStream): void => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    });
    stream.on("end", () => {
      if (buf.trim()) onLine(buf);
    });
  };

  lineBuffer(child.stdout);
  lineBuffer(child.stderr);

  child.on("error", (err) => {
    push({
      type: "error",
      data: `Failed to spawn CLI: ${err.message}. Verify ${CLI_PATH} exists (run \`npm run build\` in the parent project).`,
    });
    finished = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  });

  child.on("close", (code) => {
    exitCode = code ?? 0;
    push({
      type: "done",
      data: code === 0 ? "indexing complete" : `exited with code ${code}`,
      exitCode: code ?? 0,
      elapsedMs: Date.now() - startedAt,
    });
    finished = true;
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  });

  while (true) {
    if (queue.length === 0) {
      if (finished) return;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
    const ev = queue.shift();
    if (ev) yield ev;
    if (ev?.type === "done" || ev?.type === "error") {
      // Drain any remaining queued events before returning.
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) yield next;
      }
      if (exitCode !== null) return;
    }
  }
}
