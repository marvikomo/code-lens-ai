"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GitHubRepo } from "@/lib/github";
import type { IndexedRepo } from "@/lib/neo4j";

interface DashboardState {
  githubRepos: GitHubRepo[];
  indexedRepos: IndexedRepo[];
  githubError: string | null;
  neo4jError: string | null;
  loading: boolean;
}

interface IndexingState {
  // Repo full-name → live indexing state. Only one active at a time in v0
  // (the CLI writes to a single Neo4j, so parallel indexes would race), but
  // the data shape supports concurrency for later.
  active: Map<string, IndexingProgress>;
}

interface IndexingProgress {
  lines: string[];
  status: "running" | "done" | "error";
  /** Set when status !== running. */
  finalMessage?: string;
  elapsedMs?: number;
}

const INITIAL: DashboardState = {
  githubRepos: [],
  indexedRepos: [],
  githubError: null,
  neo4jError: null,
  loading: true,
};

const PAGE_SIZE = 30;

export function Dashboard() {
  const [state, setState] = useState<DashboardState>(INITIAL);
  const [indexing, setIndexing] = useState<IndexingState>({ active: new Map() });
  // "Available to index" — paginate + filter. The full list can be hundreds
  // of repos; showing 30 at a time + a name-filter keeps the page usable.
  const [availableLimit, setAvailableLimit] = useState(PAGE_SIZE);
  const [availableFilter, setAvailableFilter] = useState("");

  const refresh = useCallback(async () => {
    const [githubRes, neo4jRes] = await Promise.allSettled([
      fetch("/api/github/repos").then(asJson),
      fetch("/api/neo4j/repos").then(asJson),
    ]);
    setState({
      githubRepos: pluck(githubRes, "repos") ?? [],
      indexedRepos: pluck(neo4jRes, "repos") ?? [],
      githubError: pluckError(githubRes),
      neo4jError: pluckError(neo4jRes),
      loading: false,
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startIndexing = useCallback(
    async (owner: string, name: string) => {
      const key = `${owner}/${name}`;
      // Optimistically place into the indexing map so the UI flips
      // immediately on click. The fetch+stream takes over from there.
      setIndexing((prev) => {
        const next = new Map(prev.active);
        next.set(key, { lines: [`Starting index of ${key}...`], status: "running" });
        return { active: next };
      });

      try {
        const res = await fetch(`/api/index/${owner}/${name}`, {
          method: "POST",
        });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // SSE frames are separated by \n\n.
          let frameEnd = buf.indexOf("\n\n");
          while (frameEnd >= 0) {
            const frame = buf.slice(0, frameEnd);
            buf = buf.slice(frameEnd + 2);
            handleSseFrame(key, frame, setIndexing, refresh);
            frameEnd = buf.indexOf("\n\n");
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setIndexing((prev) => {
          const next = new Map(prev.active);
          const cur = next.get(key) ?? { lines: [], status: "running" as const };
          next.set(key, {
            ...cur,
            lines: [...cur.lines, `error: ${message}`],
            status: "error",
            finalMessage: message,
          });
          return { active: next };
        });
      }
    },
    [refresh],
  );

  const dismissIndexing = useCallback((key: string) => {
    setIndexing((prev) => {
      const next = new Map(prev.active);
      next.delete(key);
      return { active: next };
    });
  }, []);

  // Repo classification.
  const indexedSet = buildIndexedLookup(state.indexedRepos);
  const indexed: GitHubRepo[] = [];
  const available: GitHubRepo[] = [];
  for (const r of state.githubRepos) {
    if (indexedSet.has(r.fullName) || indexedSet.has(r.name)) {
      indexed.push(r);
    } else {
      available.push(r);
    }
  }
  const matchedNames = new Set<string>([
    ...indexed.map((r) => r.fullName),
    ...indexed.map((r) => r.name),
  ]);
  const orphanIndexed = state.indexedRepos.filter(
    (r) => !matchedNames.has(r.name),
  );

  // Is anything currently running? Disables "Index" on other cards (we
  // serialize because parallel indexes against one Neo4j would conflict).
  const anyRunning = [...indexing.active.values()].some(
    (p) => p.status === "running",
  );

  return (
    <div className="dashboard">
      <header className="dash-header">
        <h1>spatial-review</h1>
        <p className="tagline">
          Index a repo. Review its PRs spatially. Trust what the analyzer
          knows; verify what the AI guesses.
        </p>
      </header>

      {state.loading && <p className="dash-status">Loading…</p>}

      {state.githubError && (
        <ErrorCard
          title="GitHub connection failed"
          message={state.githubError}
          hint="Check that GITHUB_TOKEN is set in .env.local with a token that has `repo` scope. See .env.local.example."
        />
      )}

      {state.neo4jError && (
        <ErrorCard
          title="Neo4j connection failed"
          message={state.neo4jError}
          hint="Check that NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD are set in .env.local, and that Neo4j is running (`codelens neo4j start`)."
        />
      )}

      {!state.loading && indexed.length > 0 && (
        <Section
          title="Indexed"
          subtitle={`${indexed.length} repo${indexed.length === 1 ? "" : "s"} ready for spatial review`}
        >
          <div className="repo-grid">
            {indexed.map((r) => (
              <RepoCard
                key={r.fullName}
                repo={r}
                indexed
                indexedMeta={findIndexedMeta(r, state.indexedRepos)}
              />
            ))}
          </div>
        </Section>
      )}

      {!state.loading && orphanIndexed.length > 0 && (
        <Section
          title="Indexed (not matched to a GitHub repo)"
          subtitle="Indexed locally but the token doesn't have access to a matching GitHub repo. Canvas works; PR features won't."
        >
          <div className="repo-grid">
            {orphanIndexed.map((r) => (
              <OrphanCard key={r.path} repo={r} />
            ))}
          </div>
        </Section>
      )}

      {!state.loading && available.length > 0 && (
        <Section
          title="Available to index"
          subtitle={`${available.length} repo${available.length === 1 ? "" : "s"} not yet indexed. Indexing happens in this browser session via the parent CLI — large repos take minutes.`}
        >
          <input
            className="repo-filter"
            type="search"
            placeholder="Filter by name…"
            value={availableFilter}
            onChange={(e) => {
              setAvailableFilter(e.target.value);
              setAvailableLimit(PAGE_SIZE);
            }}
          />
          {(() => {
            const filter = availableFilter.trim().toLowerCase();
            const filtered = filter
              ? available.filter((r) =>
                  r.fullName.toLowerCase().includes(filter),
                )
              : available;
            const shown = filtered.slice(0, availableLimit);
            const remaining = filtered.length - shown.length;
            return (
              <>
                <div className="repo-grid">
                  {shown.map((r) => {
                    const key = r.fullName;
                    const progress = indexing.active.get(key);
                    return (
                      <RepoCard
                        key={key}
                        repo={r}
                        indexed={false}
                        progress={progress}
                        disableIndex={anyRunning && !progress}
                        onIndex={() => startIndexing(r.owner, r.name)}
                        onDismissProgress={() => dismissIndexing(key)}
                      />
                    );
                  })}
                </div>
                {filtered.length === 0 && (
                  <p className="dash-status">
                    No repos match &ldquo;{availableFilter}&rdquo;.
                  </p>
                )}
                {remaining > 0 && (
                  <div className="show-more">
                    <button
                      onClick={() =>
                        setAvailableLimit((l) => l + PAGE_SIZE)
                      }
                    >
                      Show {Math.min(remaining, PAGE_SIZE)} more (
                      {remaining} not shown)
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </Section>
      )}

      {!state.loading &&
        indexed.length === 0 &&
        orphanIndexed.length === 0 &&
        available.length === 0 &&
        !state.githubError &&
        !state.neo4jError && (
          <div className="empty">
            <p>No repos found.</p>
            <p>
              Your GitHub token has no accessible repos and Neo4j has no
              indexed repos yet.
            </p>
          </div>
        )}
    </div>
  );
}

// ---------- SSE frame parser ----------

function handleSseFrame(
  key: string,
  frame: string,
  setIndexing: React.Dispatch<React.SetStateAction<IndexingState>>,
  refresh: () => Promise<void>,
): void {
  // Frame is e.g. "event: log\ndata: some line"
  const lines = frame.split("\n");
  let event = "message";
  let data = "";
  for (const l of lines) {
    if (l.startsWith("event: ")) event = l.slice(7);
    else if (l.startsWith("data: ")) data = l.slice(6);
  }

  setIndexing((prev) => {
    const next = new Map(prev.active);
    const cur = next.get(key) ?? { lines: [], status: "running" as const };
    if (event === "log") {
      next.set(key, { ...cur, lines: [...cur.lines, data].slice(-200) });
    } else if (event === "done") {
      next.set(key, {
        ...cur,
        lines: [...cur.lines, data].slice(-200),
        status: "done",
        finalMessage: data,
      });
      // After a successful index, refresh so it moves to "Indexed" section.
      void refresh();
    } else if (event === "error") {
      next.set(key, {
        ...cur,
        lines: [...cur.lines, `error: ${data}`].slice(-200),
        status: "error",
        finalMessage: data,
      });
    }
    return { active: next };
  });
}

// ---------- Subcomponents ----------

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function RepoCard({
  repo,
  indexed,
  indexedMeta,
  progress,
  disableIndex,
  onIndex,
  onDismissProgress,
}: {
  repo: GitHubRepo;
  indexed: boolean;
  indexedMeta?: IndexedRepo;
  progress?: IndexingProgress;
  disableIndex?: boolean;
  onIndex?: () => void;
  onDismissProgress?: () => void;
}) {
  const showCardLink = indexed && !progress;
  const Tag = showCardLink ? "a" : "div";
  const href = showCardLink
    ? `/repo/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
    : undefined;
  return (
    <Tag className="repo-card" data-indexed={indexed || undefined} href={href}>
      <div className="repo-card-head">
        <span className="repo-name">{repo.fullName}</span>
        {repo.isPrivate && <span className="repo-private">private</span>}
      </div>
      {repo.description && (
        <p className="repo-desc">{truncate(repo.description, 100)}</p>
      )}
      <div className="repo-meta">
        {repo.language && <span>{repo.language}</span>}
        {repo.stargazersCount > 0 && <span>★ {repo.stargazersCount}</span>}
        {indexedMeta && (
          <>
            <span className="dot">·</span>
            <span>{indexedMeta.fileCount} files</span>
            <span>{indexedMeta.communityCount} subsystems</span>
          </>
        )}
      </div>
      {!indexed && !progress && (
        <button
          className="index-btn"
          disabled={disableIndex}
          title={
            disableIndex
              ? "Another index is running — only one at a time"
              : "Clone + index this repo (takes minutes for large repos)"
          }
          onClick={(e) => {
            e.preventDefault();
            onIndex?.();
          }}
        >
          Index
        </button>
      )}
      {progress && (
        <IndexingPanel progress={progress} onDismiss={onDismissProgress} />
      )}
    </Tag>
  );
}

function IndexingPanel({
  progress,
  onDismiss,
}: {
  progress: IndexingProgress;
  onDismiss?: () => void;
}) {
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [progress.lines.length]);

  const statusLabel =
    progress.status === "running"
      ? "Indexing…"
      : progress.status === "done"
        ? "Done"
        : "Error";

  return (
    <div className="indexing-panel" data-status={progress.status}>
      <div className="indexing-head">
        <span>{statusLabel}</span>
        {(progress.status === "done" || progress.status === "error") && (
          <button className="dismiss-btn" onClick={onDismiss}>
            dismiss
          </button>
        )}
      </div>
      <pre ref={logRef} className="indexing-log">
        {progress.lines.join("\n")}
      </pre>
    </div>
  );
}

function OrphanCard({ repo }: { repo: IndexedRepo }) {
  return (
    <div className="repo-card orphan">
      <div className="repo-card-head">
        <span className="repo-name">{repo.name}</span>
        <span className="repo-private">local</span>
      </div>
      <p className="repo-desc">{repo.path}</p>
      <div className="repo-meta">
        <span>{repo.fileCount} files</span>
        <span>{repo.communityCount} subsystems</span>
        {repo.lastIndexed && <span>indexed {shortDate(repo.lastIndexed)}</span>}
      </div>
    </div>
  );
}

function ErrorCard({
  title,
  message,
  hint,
}: {
  title: string;
  message: string;
  hint: string;
}) {
  return (
    <div className="error-card">
      <strong>{title}</strong>
      <code>{message}</code>
      <p>{hint}</p>
    </div>
  );
}

// ---------- helpers ----------

async function asJson(r: Response): Promise<unknown> {
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

function pluck<T>(
  s: PromiseSettledResult<unknown>,
  key: string,
): T | undefined {
  if (s.status !== "fulfilled") return undefined;
  const obj = s.value as Record<string, unknown>;
  return obj?.[key] as T | undefined;
}

function pluckError(s: PromiseSettledResult<unknown>): string | null {
  if (s.status === "rejected") {
    const r = s.reason as unknown;
    return r instanceof Error ? r.message : String(r);
  }
  const obj = s.value as Record<string, unknown> | undefined;
  if (obj && typeof obj.error === "string") return obj.error;
  return null;
}

function buildIndexedLookup(indexed: IndexedRepo[]): Set<string> {
  const set = new Set<string>();
  for (const r of indexed) {
    if (r.name) set.add(r.name);
    if (r.sourceUrl) {
      const m = r.sourceUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/i);
      if (m) set.add(`${m[1]}/${m[2]}`);
    }
  }
  return set;
}

function findIndexedMeta(
  repo: GitHubRepo,
  indexed: IndexedRepo[],
): IndexedRepo | undefined {
  return indexed.find(
    (r) =>
      r.name === repo.name ||
      r.name === repo.fullName ||
      (r.sourceUrl &&
        r.sourceUrl.toLowerCase().includes(repo.fullName.toLowerCase())),
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function shortDate(iso: string): string {
  const d = Date.parse(iso);
  if (Number.isNaN(d)) return iso;
  const days = Math.floor((Date.now() - d) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
