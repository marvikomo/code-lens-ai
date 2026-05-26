"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { ReadingPathEntry } from "@/lib/reading-path";

type FileCardNodeType = Node<
  ReadingPathEntry & Record<string, unknown>,
  "fileCard"
>;

/**
 * Compact metadata card — overview view. The actual diff lives in the reader
 * pane (overlay), opened by clicking this card. Keeping the card small lets
 * the canvas hold many files on screen at once for spatial overview.
 */
export function FileCardNode({ data, selected }: NodeProps<FileCardNodeType>) {
  const basename = data.matchedPath.split("/").slice(-1)[0] ?? data.matchedPath;
  const dir = data.matchedPath.slice(
    0,
    Math.max(0, data.matchedPath.length - basename.length - 1),
  );

  return (
    <div
      className="file-card compact"
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
      <div className="fc-cta">Click to read →</div>
      <Handle type="source" position={Position.Right} className="fc-handle" />
    </div>
  );
}
