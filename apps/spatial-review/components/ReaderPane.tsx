"use client";

import { useEffect, useMemo } from "react";
import type { ReadingPathEntry } from "@/lib/reading-path";

interface ReaderPaneProps {
  entries: ReadingPathEntry[];
  edges: Array<{ from: string; to: string }>;
  /** Currently focused path. Must match one of entries[].matchedPath. */
  focusedPath: string;
  onClose: () => void;
  onNavigate: (matchedPath: string) => void;
}

export function ReaderPane({
  entries,
  edges,
  focusedPath,
  onClose,
  onNavigate,
}: ReaderPaneProps) {
  const index = entries.findIndex((e) => e.matchedPath === focusedPath);
  const entry = index >= 0 ? entries[index] : null;
  const prev = index > 0 ? entries[index - 1] : null;
  const next = index >= 0 && index < entries.length - 1 ? entries[index + 1] : null;

  const inEdges = useMemo(
    () => edges.filter((e) => e.to === focusedPath),
    [edges, focusedPath],
  );
  const outEdges = useMemo(
    () => edges.filter((e) => e.from === focusedPath),
    [edges, focusedPath],
  );

  // Keyboard: Esc closes, ←/→ or j/k navigate. Mounted on window so the
  // shortcuts work even if focus isn't on the pane itself.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore when typing in an input/textarea (defensive — none in this
      // pane currently, but reviewer-notes textarea may land later).
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if ((e.key === "ArrowRight" || e.key === "j") && next) {
        e.preventDefault();
        onNavigate(next.matchedPath);
      } else if ((e.key === "ArrowLeft" || e.key === "k") && prev) {
        e.preventDefault();
        onNavigate(prev.matchedPath);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, onNavigate, prev, next]);

  if (!entry) return null;

  const basename =
    entry.matchedPath.split("/").slice(-1)[0] ?? entry.matchedPath;

  return (
    <div className="reader-overlay" onClick={onClose} role="dialog">
      <div className="reader-pane" onClick={(e) => e.stopPropagation()}>
        <header className="reader-head">
          <div className="reader-head-main">
            <div className="reader-title-line">
              <span className="reader-step">
                {index + 1} of {entries.length}
              </span>
              <span className="reader-basename">{basename}</span>
              <div className="reader-tags">
                {entry.isEntry && <span className="rp-tag entry">entry</span>}
                {entry.isSpine && <span className="rp-tag spine">spine</span>}
              </div>
            </div>
            <div className="reader-path">
              <code>{entry.matchedPath}</code>
            </div>
          </div>
          <button
            className="reader-close"
            onClick={onClose}
            aria-label="Close reader"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div className="reader-body">
          <main className="reader-diff-wrap">
            {entry.diff.length > 0 ? (
              <pre className="reader-diff">
                {entry.diff.map((line, i) => (
                  <div
                    key={i}
                    className={`reader-line reader-line-${line.kind}`}
                  >
                    <span className="reader-gutter">
                      {line.kind === "added"
                        ? "+"
                        : line.kind === "removed"
                          ? "−"
                          : line.kind === "hunk-separator"
                            ? "⋯"
                            : " "}
                    </span>
                    <code>{line.text || " "}</code>
                  </div>
                ))}
              </pre>
            ) : (
              <div className="reader-no-diff">
                No diff available — file is binary, exceeds GitHub&rsquo;s
                patch size limit, or has status:{" "}
                <code>{entry.status}</code>.
              </div>
            )}
          </main>

          <aside className="reader-meta-pane">
            <div className="reader-meta-section">
              <label>Diff</label>
              <p>
                <span className="fc-add">+{entry.additions}</span>{" "}
                <span className="fc-rm">−{entry.deletions}</span>
              </p>
            </div>
            {entry.communityLabel && (
              <div className="reader-meta-section">
                <label>Subsystem</label>
                <p>{entry.communityLabel}</p>
              </div>
            )}
            <div className="reader-meta-section">
              <label>Blast radius</label>
              <p>
                <strong>{Math.round(entry.blastScore)}</strong>
              </p>
              <p className="reader-hint">
                {entry.blastDirect} direct + {entry.blastTransitive} transitive
                importers
              </p>
            </div>
            <div className="reader-meta-section">
              <label>BFS level</label>
              <p>
                {entry.level === 0
                  ? "Entry point (0) — outside surface."
                  : `Level ${entry.level} from entry.`}
              </p>
            </div>
            {(outEdges.length > 0 || inEdges.length > 0) && (
              <div className="reader-meta-section">
                <label>In this PR</label>
                {outEdges.length > 0 && (
                  <div className="reader-edges">
                    <span className="edges-label">Imports:</span>
                    <ul>
                      {outEdges.map((e) => (
                        <li key={e.to}>
                          <button onClick={() => onNavigate(e.to)}>
                            {basenameOf(e.to)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {inEdges.length > 0 && (
                  <div className="reader-edges">
                    <span className="edges-label">Imported by:</span>
                    <ul>
                      {inEdges.map((e) => (
                        <li key={e.from}>
                          <button onClick={() => onNavigate(e.from)}>
                            {basenameOf(e.from)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>

        <footer className="reader-foot">
          <button
            className="reader-nav-btn"
            disabled={!prev}
            onClick={() => prev && onNavigate(prev.matchedPath)}
            title={prev ? `Previous (←): ${basenameOf(prev.matchedPath)}` : "No previous"}
          >
            ← Previous
            {prev && (
              <span className="reader-nav-hint">
                {basenameOf(prev.matchedPath)}
              </span>
            )}
          </button>
          <span className="reader-shortcuts">
            <kbd>Esc</kbd> close · <kbd>←</kbd> / <kbd>→</kbd> navigate
          </span>
          <button
            className="reader-nav-btn"
            disabled={!next}
            onClick={() => next && onNavigate(next.matchedPath)}
            title={next ? `Next (→): ${basenameOf(next.matchedPath)}` : "No next"}
          >
            {next && (
              <span className="reader-nav-hint">
                {basenameOf(next.matchedPath)}
              </span>
            )}
            Next →
          </button>
        </footer>
      </div>
    </div>
  );
}

function basenameOf(p: string): string {
  return p.split("/").slice(-1)[0] ?? p;
}
