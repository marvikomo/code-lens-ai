"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { GitHubPr } from "@/lib/github";

interface State {
  prs: GitHubPr[];
  error: string | null;
  loading: boolean;
}

export function PrList({ owner, repo }: { owner: string; repo: string }) {
  const [state, setState] = useState<State>({
    prs: [],
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/github/prs/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { prs: GitHubPr[] };
        if (!cancelled) {
          setState({ prs: data.prs, error: null, loading: false });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          prs: [],
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  return (
    <div className="repo-page">
      <header className="repo-page-head">
        <Link href="/" className="back-link">
          ← back to dashboard
        </Link>
        <h1 className="repo-title">
          {owner}/{repo}
        </h1>
        <p className="repo-sub">
          {state.loading
            ? "Loading PRs…"
            : state.error
              ? "Couldn't load PRs"
              : `${state.prs.length} open pull request${state.prs.length === 1 ? "" : "s"}`}
        </p>
      </header>

      {state.error && (
        <div className="error-card">
          <strong>GitHub API error</strong>
          <code>{state.error}</code>
          <p>
            Check that GITHUB_TOKEN has `repo` scope and that the repo
            actually exists / is accessible to this token.
          </p>
        </div>
      )}

      {!state.loading && !state.error && state.prs.length === 0 && (
        <div className="empty">
          <p>No open pull requests.</p>
        </div>
      )}

      {state.prs.length > 0 && (
        <ul className="pr-list">
          {state.prs.map((pr) => (
            <PrRow key={pr.number} owner={owner} repo={repo} pr={pr} />
          ))}
        </ul>
      )}
    </div>
  );
}

function PrRow({
  owner,
  repo,
  pr,
}: {
  owner: string;
  repo: string;
  pr: GitHubPr;
}) {
  return (
    <li className="pr-row">
      <Link
        href={`/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pr.number}`}
        className="pr-row-link"
      >
        <div className="pr-row-main">
          <div className="pr-title-line">
            <span className="pr-number">#{pr.number}</span>
            <span className="pr-title-text">{pr.title}</span>
            {pr.draft && <span className="pr-draft">draft</span>}
          </div>
          <div className="pr-meta-line">
            <span>by @{pr.user}</span>
            <span className="dot">·</span>
            <span>updated {relativeTime(pr.updatedAt)}</span>
            {pr.changedFiles > 0 && (
              <>
                <span className="dot">·</span>
                <span>{pr.changedFiles} files</span>
              </>
            )}
            {(pr.additions > 0 || pr.deletions > 0) && (
              <>
                <span className="dot">·</span>
                <span className="diff-add">+{pr.additions}</span>
                <span className="diff-rm">−{pr.deletions}</span>
              </>
            )}
          </div>
        </div>
        <div className="pr-row-cta">Review →</div>
      </Link>
    </li>
  );
}

function relativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}
