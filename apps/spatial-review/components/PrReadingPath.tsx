"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReadingPath, ReadingPathEntry } from "@/lib/reading-path";

interface ApiResponse extends ReadingPath {
  prFileCount: number;
  error?: string;
}

interface State {
  data: ApiResponse | null;
  error: string | null;
  loading: boolean;
}

export function PrReadingPath({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const [state, setState] = useState<State>({
    data: null,
    error: null,
    loading: true,
  });
  const [focusedPath, setFocusedPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/reading-path`,
        );
        const body = (await res.json()) as ApiResponse;
        if (cancelled) return;
        if (!res.ok || body.error) {
          setState({
            data: null,
            error: body.error ?? `HTTP ${res.status}`,
            loading: false,
          });
        } else {
          setState({ data: body, error: null, loading: false });
          if (body.entries.length > 0) {
            setFocusedPath(body.entries[0].matchedPath);
          }
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          data: null,
          error: err instanceof Error ? err.message : String(err),
          loading: false,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number]);

  const focused =
    state.data?.entries.find((e) => e.matchedPath === focusedPath) ?? null;

  return (
    <div className="rp-page">
      <div className="rp-page-head">
        <Link
          href={`/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}
          className="back-link"
        >
          ← back to {owner}/{repo}
        </Link>
        <h1 className="rp-title">
          <span className="rp-num">#{number}</span> · Reading path
        </h1>
        <p className="rp-sub">
          Files in the order a reviewer would naturally traverse them — entry
          points first, dependencies after. Deterministic, derived from the
          import graph in Neo4j.
        </p>
      </div>

      {state.loading && <p className="dash-status">Computing reading path…</p>}

      {state.error && (
        <div className="error-card">
          <strong>Reading-path computation failed</strong>
          <code>{state.error}</code>
          <p>
            Either GitHub didn&rsquo;t return the PR file list, or this repo
            isn&rsquo;t indexed in Neo4j yet. Verify both, then refresh.
          </p>
        </div>
      )}

      {state.data && (
        <div className="rp-layout">
          <aside className="rp-list-pane">
            <div className="rp-meta">
              <span>
                <strong>{state.data.meta.matchedCount}</strong> in graph
              </span>
              <span className="dot">·</span>
              <span>
                <strong>{state.data.meta.unmatchedCount}</strong> new / not yet
                indexed
              </span>
              <span className="dot">·</span>
              <span>
                <strong>{state.data.meta.edgeCount}</strong> import edges
              </span>
              <span className="dot">·</span>
              <span>
                <strong>{state.data.meta.entryCount}</strong> entry point
                {state.data.meta.entryCount === 1 ? "" : "s"}
              </span>
            </div>

            {state.data.entries.length === 0 && (
              <div className="empty">
                <p>No indexed files in this PR.</p>
                <p>
                  Either none of the changed files are in the indexed graph
                  yet (re-index the repo to pick up new files), or the PR only
                  touches removed files.
                </p>
              </div>
            )}

            <ol className="rp-list">
              {state.data.entries.map((e, i) => (
                <li
                  key={e.matchedPath}
                  className={`rp-row ${focusedPath === e.matchedPath ? "active" : ""}`}
                  onClick={() => setFocusedPath(e.matchedPath)}
                >
                  <span className="rp-index">{i + 1}</span>
                  <span className="rp-body">
                    <span className="rp-path">
                      {basename(e.matchedPath)}
                      {e.isEntry && <span className="rp-tag entry">entry</span>}
                      {e.isSpine && <span className="rp-tag spine">spine</span>}
                    </span>
                    <span className="rp-line2">
                      <code className="rp-fullpath">{e.matchedPath}</code>
                    </span>
                    <span className="rp-line3">
                      {e.communityLabel && (
                        <span className="rp-community">
                          {e.communityLabel}
                        </span>
                      )}
                      {e.blastScore > 0 && (
                        <span className="rp-blast">
                          blast {Math.round(e.blastScore)}
                        </span>
                      )}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            {state.data.unmatched.length > 0 && (
              <div className="rp-unmatched">
                <h3>Not in graph yet ({state.data.unmatched.length})</h3>
                <p>
                  These files are in the PR but not yet indexed. Re-index the
                  repo at HEAD to include them.
                </p>
                <ul>
                  {state.data.unmatched.map((p) => (
                    <li key={p}>
                      <code>{p}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>

          <aside className="rp-focus-pane">
            {focused ? <FocusDetail entry={focused} /> : <EmptyFocus />}
          </aside>
        </div>
      )}
    </div>
  );
}

function FocusDetail({ entry }: { entry: ReadingPathEntry }) {
  return (
    <div className="rp-focus-content">
      <div className="rp-focus-head">
        <span className="rp-focus-name">{basename(entry.matchedPath)}</span>
        <div className="rp-focus-tags">
          {entry.isEntry && <span className="rp-tag entry">entry</span>}
          {entry.isSpine && <span className="rp-tag spine">spine</span>}
        </div>
      </div>
      <div className="rp-focus-path">
        <code>{entry.matchedPath}</code>
      </div>
      {entry.communityLabel && (
        <div className="rp-focus-section">
          <label>Community</label>
          <p>{entry.communityLabel}</p>
        </div>
      )}
      <div className="rp-focus-section">
        <label>Blast radius</label>
        <p>
          <strong>{Math.round(entry.blastScore)}</strong> (
          {entry.blastDirect} direct + {entry.blastTransitive} transitive
          importers)
        </p>
        <p className="rp-focus-hint">
          Changes here ripple to {entry.blastDirect + entry.blastTransitive}{" "}
          other file{entry.blastDirect + entry.blastTransitive === 1 ? "" : "s"}
          .
        </p>
      </div>
      <div className="rp-focus-section">
        <label>Status in reading path</label>
        <p>
          {entry.isEntry
            ? "Entry point — no other changed file imports this. Start here."
            : "Reached via BFS from an entry — a dependency of files higher in the list."}
        </p>
      </div>
    </div>
  );
}

function EmptyFocus() {
  return (
    <div className="rp-focus-content empty">
      Click a file in the reading path to focus.
    </div>
  );
}

function basename(p: string): string {
  return p.split("/").slice(-1)[0] ?? p;
}
