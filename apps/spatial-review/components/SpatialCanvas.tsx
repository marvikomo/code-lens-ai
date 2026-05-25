"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeMarker,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { SymbolNode } from "./SymbolNode";
import { PR_10330, type SymbolNodeData, type CanvasEdgeData } from "@/lib/fixtures/pr-10330";

const nodeTypes: NodeTypes = {
  symbol: SymbolNode,
};

// Hand-tuned initial layout. Step 1 prototype only — auto-layout (dagre/elk)
// lands in Step 2 once we know what shape the canvas actually wants. After
// the user drags a node, xyflow's useNodesState tracks the new position.
const POSITIONS: Record<string, { x: number; y: number }> = {
  "test-stream-events-v2": { x: 0, y: 0 },
  "test-structured-parser": { x: 0, y: 380 },
  "fn-merge-lists": { x: 560, y: 180 },
  "fn-ai-message-chunk-concat": { x: 1100, y: 60 },
  "type-tool-call-chunk": { x: 1100, y: 380 },
  "ai-suggested-is-base-message": { x: 560, y: 580 },
};

function buildEdgeStyle(e: CanvasEdgeData): Partial<Edge> {
  const marker: EdgeMarker = { type: MarkerType.ArrowClosed, width: 16, height: 16 };
  if (e.kind === "ast") {
    return {
      style: { stroke: "#94a3b8", strokeWidth: 1.5 },
      markerEnd: { ...marker, color: "#94a3b8" },
    };
  }
  if (e.kind === "inferred") {
    return {
      style: { stroke: "#f59e0b", strokeWidth: 1.5, strokeDasharray: "6 4" },
      markerEnd: { ...marker, color: "#f59e0b" },
    };
  }
  return {
    style: { stroke: "#cbd5e1", strokeWidth: 1, strokeDasharray: "2 4" },
    markerEnd: { ...marker, color: "#cbd5e1" },
  };
}

// Computed once on module load — these are the canonical "starting" nodes and
// edges. After this, useNodesState/useEdgesState own them, so dragging persists
// and we don't lose positions on re-render.
const INITIAL_NODES: Node[] = PR_10330.nodes.map<Node>((n) => ({
  id: n.id,
  type: "symbol",
  position: POSITIONS[n.id] ?? { x: 0, y: 0 },
  data: { ...n } as unknown as Record<string, unknown>,
}));

const INITIAL_EDGES: Edge[] = PR_10330.edges.map<Edge>((e) => ({
  id: e.id,
  source: e.source,
  target: e.target,
  label:
    e.kind === "inferred" && e.confidence !== undefined
      ? `${e.label ?? ""} · ${(e.confidence * 100).toFixed(0)}%`
      : e.label,
  ...buildEdgeStyle(e),
}));

export function SpatialCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(INITIAL_NODES);
  const [edges, , onEdgesChange] = useEdgesState<Edge>(INITIAL_EDGES);
  const [focusedId, setFocusedId] = useState<string | null>(
    PR_10330.readingPath[0] ?? null,
  );

  // Sync `selected` flag with focusedId WITHOUT touching position. Each node's
  // identity is preserved if its selected state didn't actually change — that
  // avoids unnecessary re-renders and (critically) keeps dragged positions.
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const shouldBeSelected = n.id === focusedId;
        if (n.selected === shouldBeSelected) return n;
        return { ...n, selected: shouldBeSelected };
      }),
    );
  }, [focusedId, setNodes]);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setFocusedId(node.id);
  }, []);

  const focused = useMemo(
    () => PR_10330.nodes.find((n) => n.id === focusedId) ?? null,
    [focusedId],
  );

  return (
    <div className="layout">
      <aside className="sidebar-left">
        <div className="pr-header">
          <div className="pr-repo">
            {PR_10330.owner}/{PR_10330.repo}
          </div>
          <div className="pr-title">
            #{PR_10330.number}: {PR_10330.title}
          </div>
          <div className="pr-meta">by @{PR_10330.author}</div>
        </div>
        <div className="section-label">Reading path</div>
        <ol className="reading-path">
          {PR_10330.readingPath.map((id) => {
            const n = PR_10330.nodes.find((nn) => nn.id === id);
            if (!n) return null;
            return (
              <li
                key={id}
                className={focusedId === id ? "active" : ""}
                onClick={() => setFocusedId(id)}
              >
                <span className="rp-symbol">{n.symbol}</span>
                <span className="rp-path">{filename(n.path)}</span>
              </li>
            );
          })}
        </ol>
      </aside>

      <main className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.3}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} size={1} color="#e2e8f0" />
          <Controls position="bottom-right" showInteractive={false} />
          <MiniMap
            position="top-right"
            nodeColor={(n) => {
              const d = n.data as unknown as SymbolNodeData;
              if (d.verification === "inferred") return "#fbbf24";
              if (d.isEntryPoint) return "#3b82f6";
              return "#94a3b8";
            }}
            pannable
            zoomable
          />
        </ReactFlow>
        <div className="legend">
          <span><span className="swatch ast" /> AST-verified</span>
          <span><span className="swatch inferred" /> AI-inferred</span>
          <span><span className="swatch entry" /> Entry point</span>
        </div>
      </main>

      <aside className="sidebar-right">
        {focused ? <FocusPane node={focused} /> : <EmptyFocus />}
      </aside>
    </div>
  );
}

function FocusPane({ node }: { node: SymbolNodeData }) {
  return (
    <div className="focus-pane">
      <div className="focus-header">
        <span className="focus-symbol">{node.symbol}</span>
        <span
          className="focus-badge"
          data-inferred={node.verification === "inferred" || undefined}
        >
          {node.verification === "inferred" ? "AI-inferred" : "AST-verified"}
        </span>
      </div>
      <div className="focus-path">{node.path}</div>
      <div className="section-label">Summary</div>
      <p className="focus-summary">{node.summary}</p>
      {node.risks.length > 0 && (
        <>
          <div className="section-label warn">Risk flags</div>
          <ul className="risks">
            {node.risks.map((r, i) => (
              <li key={i}>⚠ {r}</li>
            ))}
          </ul>
        </>
      )}
      <div className="section-label">Reviewer notes</div>
      <textarea
        className="notes"
        placeholder="Notes anchor here (persistence later)"
        rows={4}
      />
    </div>
  );
}

function EmptyFocus() {
  return <div className="focus-pane empty">Click a node to focus.</div>;
}

function filename(p: string): string {
  return p.split("/").slice(-1)[0] ?? p;
}
