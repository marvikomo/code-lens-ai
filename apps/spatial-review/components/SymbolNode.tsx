"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { SymbolNodeData } from "@/lib/fixtures/pr-10330";

type SymbolNodeType = Node<SymbolNodeData & Record<string, unknown>, "symbol">;

export function SymbolNode({ data, selected }: NodeProps<SymbolNodeType>) {
  const added = data.diff.filter((d) => d.kind === "added").length;
  const removed = data.diff.filter((d) => d.kind === "removed").length;
  const isInferred = data.verification === "inferred";

  return (
    <div
      className="symbol-node"
      data-entry={data.isEntryPoint || undefined}
      data-inferred={isInferred || undefined}
      data-selected={selected || undefined}
    >
      <Handle type="target" position={Position.Left} className="handle" />
      <header className="header" title="Drag to move">
        <span className="symbol">{data.symbol}</span>
        <span className="badge">
          {isInferred ? "AI-inferred" : "AST"}
        </span>
      </header>
      <div className="path">
        {data.path}
        <span className="lines">
          :{data.lineRange[0]}-{data.lineRange[1]}
        </span>
      </div>
      {/* nodrag → don't initiate node drag from here; nowheel → don't
          scroll-zoom the canvas when the user wheels inside the diff.
          Both are xyflow's standard opt-out classes. */}
      <pre className="diff nodrag nowheel">
        {data.diff.map((line, i) => (
          <div key={i} className={`line line-${line.kind}`}>
            <span className="gutter">
              {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
            </span>
            <code>{line.text || " "}</code>
          </div>
        ))}
      </pre>
      <footer className="footer">
        <span className="diff-stats">
          {added > 0 && <span className="added">+{added}</span>}
          {removed > 0 && <span className="removed">-{removed}</span>}
          {added === 0 && removed === 0 && (
            <span className="unchanged">context only</span>
          )}
        </span>
        {data.risks.length > 0 && (
          <span className="risk-flag" title={data.risks.join("\n")}>
            ⚠ {data.risks.length}
          </span>
        )}
      </footer>
      <Handle type="source" position={Position.Right} className="handle" />
    </div>
  );
}
