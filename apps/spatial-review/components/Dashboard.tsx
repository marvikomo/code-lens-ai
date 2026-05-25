"use client";

import { useEffect, useState } from "react";
import type { GitHubRepo } from "@/lib/github";
import type { IndexedRepo } from "@/lib/neo4j";

interface DashboardState {
  githubRepos: GitHubRepo[];
  indexedRepos: IndexedRepo[];
  githubError: string | null;
  neo4jError: string | null;
  loading: boolean;
}

const INITIAL: DashboardState = {
  githubRepos: [],
  indexedRepos: [],
  githubError: null,
  neo4jError: null,
  loading: true,
};

export function Dashboard() {
  const [state, setState] = useState<DashboardState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [githubRes, neo4jRes] = await Promise.allSettled([
        fetch("/api/github/repos").then(asJson),
        fetch("/api/neo4j/repos").then(asJson),
      ]);
      if (cancelled) return;
      setState({
        githubRepos: pluck(githubRes, "repos") ?? [],
        indexedRepos: pluck(neo4jRes, "repos") ?? [],
        githubError: pluckError(githubRes),
        neo4jError: pluckError(neo4jRes),
        loading: false,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Match GitHub repos to indexed repos by full_name OR by path basename
  // OR by sourceUrl. The matching is fuzzy because indexed repos may have
  // been indexed from a local clone (path-only) without a sourceUrl.
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

  // Orphan-indexed: repos in Neo4j we couldn't match to any GitHub repo (e.g.
  // indexed from a local clone that doesn't correspond to a GitHub repo, or
  // a repo from an org the PAT doesn't have access to). Surface these so the
  // user knows they exist.
  const matchedNames = new Set<string>([
    ...indexed.map((r) => r.fullName),
    ...indexed.map((r) => r.name),
  ]);
  const orphanIndexed = state.indexedRepos.filter(
    (r) => !matchedNames.has(r.name),
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
          hint="Check that NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD are set in .env.local, and that Neo4j is running (`codelens neo4j start` or `docker compose up neo4j` in the parent CLI project)."
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
          subtitle="These were indexed locally but we couldn't match them to any GitHub repo your token has access to. You can still browse them — PR features won't be available."
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
          subtitle={`${available.length} GitHub repo${available.length === 1 ? "" : "s"} not yet indexed. Indexing UI ships in Day 2; for now use the CLI: \`codelens index /path/to/local/clone --cluster\``}
        >
          <div className="repo-grid">
            {available.slice(0, 30).map((r) => (
              <RepoCard key={r.fullName} repo={r} indexed={false} />
            ))}
          </div>
          {available.length > 30 && (
            <p className="dash-status">
              … {available.length - 30} more not shown.
            </p>
          )}
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
              Either your GitHub token has no accessible repos, or Neo4j has
              no indexed repos yet. Run{" "}
              <code>codelens index /path/to/repo --cluster</code> in the parent
              CLI project to get started.
            </p>
          </div>
        )}
    </div>
  );
}

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
}: {
  repo: GitHubRepo;
  indexed: boolean;
  indexedMeta?: IndexedRepo;
}) {
  // Click target only meaningful when indexed — non-indexed cards are
  // placeholders for the "Index" button that ships in Day 2.
  const Tag = indexed ? "a" : "div";
  const href = indexed
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
      {!indexed && (
        <button className="index-btn" disabled title="Day 2 wiring">
          Index (Day 2)
        </button>
      )}
    </Tag>
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
  // Fulfilled but server returned { error }
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
