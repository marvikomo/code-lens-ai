"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { ReadingPathEntry } from "@/lib/reading-path";

type FileCardNodeType = Node<
  ReadingPathEntry & Record<string, unknown>,
  "fileCard"
>;

export function FileCardNode({ data, selected }: NodeProps<FileCardNodeType>) {
  const basename = data.matchedPath.split("/").slice(-1)[0] ?? data.matchedPath;
  const dir = data.matchedPath.slice(
    0,
    Math.max(0, data.matchedPath.length - basename.length - 1),
  );

  return (
    <div
      className="file-card"
      data-entry={data.isEntry || undefined}
      data-spine={data.isSpine || undefined}
      data-selected={selected || undefined}
    >
      <Handle type="target" position={Position.Left} className="fc-handle" />
      <div className="fc-head">
        <span className="fc-basename" title={data.matchedPath}>
          {basename}
        </span>
        <div className="fc-tags">
          {data.isEntry && <span className="fc-tag entry">entry</span>}
          {data.isSpine && <span className="fc-tag spine">spine</span>}
        </div>
      </div>
      {dir && <div className="fc-dir">{dir}</div>}

      {/* Diff body — scrollable + non-drag/non-wheel so it doesn't fight
          xyflow's pan/drag. Empty when GitHub returned no patch (binary,
          too large, or status=removed). */}
      {data.diff.length > 0 ? (
        <pre className="fc-diff nodrag nowheel">
          {data.diff.map((line, i) => (
            <div key={i} className={`fc-line fc-line-${line.kind}`}>
              <span className="fc-gutter">
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
        <div className="fc-no-diff">
          (no diff — binary file, too large, or status: {data.status})
        </div>
      )}

      <div className="fc-meta">
        <span className="fc-stats">
          {data.additions > 0 && (
            <span className="fc-add">+{data.additions}</span>
          )}
          {data.deletions > 0 && (
            <span className="fc-rm">−{data.deletions}</span>
          )}
        </span>
        {data.communityLabel && (
          <span className="fc-community">{data.communityLabel}</span>
        )}
        {data.blastScore > 0 && (
          <span className="fc-blast">blast {Math.round(data.blastScore)}</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="fc-handle" />
    </div>
  );
}
