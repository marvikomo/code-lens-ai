"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ReadingPath, ReadingPathEntry } from "@/lib/reading-path";
import { PrCanvas } from "./PrCanvas";
import { ReaderPane } from "./ReaderPane";

interface ApiResponse extends ReadingPath {
  prFileCount: number;
  error?: string;
}

interface State {
  data: ApiResponse | null;
  error: string | null;
  loading: boolean;
}

export function PrReview({
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
  const [readerOpen, setReaderOpen] = useState(false);

  // Open the reader on any click — sidebar row or canvas node. Esc / X
  // closes; focusedPath persists so the right pane still shows context
  // until the next click.
  const openReader = useCallback((path: string) => {
    setFocusedPath(path);
    setReaderOpen(true);
  }, []);
  const closeReader = useCallback(() => setReaderOpen(false), []);

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
    <div className="review-page">
      <header className="review-head">
        <Link
          href={`/repo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}
          className="back-link"
        >
          ← back to {owner}/{repo}
        </Link>
        <h1 className="rp-title">
          <span className="rp-num">#{number}</span> · Spatial review
        </h1>
        <p className="rp-sub">
          Files in the order a reviewer would naturally read them, laid out
          spatially by import dependency. Click a file to focus.
        </p>
      </header>

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
        <>
          <div className="review-meta">
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
            <span className="dot">·</span>
            <span>
              <strong>{state.data.meta.maxLevel + 1}</strong> dep layer
              {state.data.meta.maxLevel === 0 ? "" : "s"}
            </span>
          </div>

          {state.data.entries.length === 0 ? (
            <div className="empty">
              <p>No indexed files in this PR.</p>
              <p>
                Either none of the changed files are in the indexed graph
                yet (re-index the repo to pick up new files), or the PR only
                touches removed files.
              </p>
            </div>
          ) : (
            <div className="review-body">
              <aside className="rp-sidebar">
                <div className="rp-sidebar-head">Reading path</div>
                <ol className="rp-list dense">
                  {state.data.entries.map((e, i) => (
                    <ReadingPathRow
                      key={e.matchedPath}
                      entry={e}
                      index={i}
                      active={focusedPath === e.matchedPath}
                      onClick={() => setFocusedPath(e.matchedPath)}
                    />
                  ))}
                </ol>
                {state.data.unmatched.length > 0 && (
                  <div className="rp-unmatched compact">
                    <h3>Not in graph ({state.data.unmatched.length})</h3>
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

              <PrCanvas
                entries={state.data.entries}
                edges={state.data.edges}
                focusedPath={focusedPath}
                onFocus={openReader}
              />

              <aside className="rp-focus-pane">
                {focused ? (
                  <FocusDetail
                    entry={focused}
                    inEdges={state.data.edges.filter(
                      (x) => x.to === focused.matchedPath,
                    )}
                    outEdges={state.data.edges.filter(
                      (x) => x.from === focused.matchedPath,
                    )}
                    onFocusPath={setFocusedPath}
                  />
                ) : (
                  <div className="rp-focus-content empty">
                    Click any file to open the reader.
                  </div>
                )}
              </aside>
            </div>
          )}
          {readerOpen && focused && state.data && (
            <ReaderPane
              owner={owner}
              repo={repo}
              number={number}
              entries={state.data.entries}
              edges={state.data.edges}
              focusedPath={focused.matchedPath}
              onClose={closeReader}
              onNavigate={(p) => setFocusedPath(p)}
            />
          )}
        </>
      )}
    </div>
  );
}

function ReadingPathRow({
  entry,
  index,
  active,
  onClick,
}: {
  entry: ReadingPathEntry;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  // Auto-scroll into view when activated by an external click (canvas).
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active && ref.current) {
      ref.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [active]);

  return (
    <li
      ref={ref}
      className={`rp-row ${active ? "active" : ""}`}
      onClick={onClick}
    >
      <span className="rp-index">{index + 1}</span>
      <span className="rp-body">
        <span className="rp-path">
          {basename(entry.matchedPath)}
          {entry.isEntry && <span className="rp-tag entry">entry</span>}
          {entry.isSpine && <span className="rp-tag spine">spine</span>}
        </span>
        <span className="rp-line3">
          {entry.communityLabel && (
            <span className="rp-community">{entry.communityLabel}</span>
          )}
          {entry.blastScore > 0 && (
            <span className="rp-blast">
              blast {Math.round(entry.blastScore)}
            </span>
          )}
        </span>
      </span>
    </li>
  );
}

function FocusDetail({
  entry,
  inEdges,
  outEdges,
  onFocusPath,
}: {
  entry: ReadingPathEntry;
  inEdges: Array<{ from: string; to: string }>;
  outEdges: Array<{ from: string; to: string }>;
  onFocusPath: (path: string) => void;
}) {
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
      </div>
      <div className="rp-focus-section">
        <label>BFS level</label>
        <p>
          {entry.level === 0
            ? "Entry point (level 0) — no other changed file imports this."
            : `Level ${entry.level} — reached via ${entry.level} hop${entry.level === 1 ? "" : "s"} from an entry.`}
        </p>
      </div>
      {(inEdges.length > 0 || outEdges.length > 0) && (
        <div className="rp-focus-section">
          <label>In this PR</label>
          {outEdges.length > 0 && (
            <div className="focus-edges">
              <span className="edges-label">Imports:</span>
              <ul>
                {outEdges.map((e) => (
                  <li key={e.to}>
                    <button onClick={() => onFocusPath(e.to)}>
                      {basename(e.to)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {inEdges.length > 0 && (
            <div className="focus-edges">
              <span className="edges-label">Imported by:</span>
              <ul>
                {inEdges.map((e) => (
                  <li key={e.from}>
                    <button onClick={() => onFocusPath(e.from)}>
                      {basename(e.from)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function basename(p: string): string {
  return p.split("/").slice(-1)[0] ?? p;
}
