"use client";

import { useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { FileCardNode } from "./FileCardNode";
import type { ReadingPathEntry } from "@/lib/reading-path";

const nodeTypes: NodeTypes = {
  fileCard: FileCardNode,
};

// Custom column layout: x = level * (cardWidth + gap), y = indexInLevel
// * (cardHeight + gap), centered vertically per column. Echoes the BFS
// ordering visually — entry points on the left, deps to the right.
//
// Card height is approximate — actual rendered height depends on diff
// length (scrolls internally past CARD_HEIGHT). The constant determines
// vertical spacing in the layout, not the rendered height. Slightly
// undersized constant = tighter packing, with diffs scrolling internally.
const CARD_WIDTH = 420;
const CARD_HEIGHT = 280;
const COL_GAP = 120;
const ROW_GAP = 40;

function layout(entries: ReadingPathEntry[]): Map<string, { x: number; y: number }> {
  const byLevel = new Map<number, ReadingPathEntry[]>();
  for (const e of entries) {
    if (!byLevel.has(e.level)) byLevel.set(e.level, []);
    byLevel.get(e.level)!.push(e);
  }
  const positions = new Map<string, { x: number; y: number }>();
  const tallestColumnHeight = Math.max(
    ...Array.from(byLevel.values()).map(
      (col) => col.length * (CARD_HEIGHT + ROW_GAP),
    ),
  );
  for (const [level, col] of byLevel) {
    const x = level * (CARD_WIDTH + COL_GAP);
    const columnHeight = col.length * (CARD_HEIGHT + ROW_GAP);
    const startY = (tallestColumnHeight - columnHeight) / 2;
    col.forEach((entry, i) => {
      positions.set(entry.matchedPath, {
        x,
        y: startY + i * (CARD_HEIGHT + ROW_GAP),
      });
    });
  }
  return positions;
}

interface PrCanvasProps {
  entries: ReadingPathEntry[];
  edges: Array<{ from: string; to: string }>;
  focusedPath: string | null;
  onFocus: (matchedPath: string) => void;
}

export function PrCanvas({ entries, edges, focusedPath, onFocus }: PrCanvasProps) {
  // INITIAL_NODES is derived from entries; we use useNodesState so dragged
  // positions persist across selection re-renders (same pattern as the
  // static prototype's SpatialCanvas).
  const initial = useMemo(() => {
    const positions = layout(entries);
    return entries.map<Node>((e) => ({
      id: e.matchedPath,
      type: "fileCard",
      position: positions.get(e.matchedPath) ?? { x: 0, y: 0 },
      data: { ...e } as unknown as Record<string, unknown>,
    }));
  }, [entries]);

  const initialEdges = useMemo<Edge[]>(
    () =>
      edges.map((e, i) => ({
        id: `e-${i}`,
        source: e.from,
        target: e.to,
        style: { stroke: "#94a3b8", strokeWidth: 1.5 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: "#94a3b8",
        },
      })),
    [edges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initial);
  const [edgesState, , onEdgesChange] = useEdgesState<Edge>(initialEdges);

  // If the entries/edges arrays themselves change (e.g., the user navigates
  // to a different PR while the component stays mounted), reset state.
  useEffect(() => {
    setNodes(initial);
  }, [initial, setNodes]);

  // Sync `selected` flag from focusedPath without touching position.
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => {
        const shouldBeSelected = n.id === focusedPath;
        if (n.selected === shouldBeSelected) return n;
        return { ...n, selected: shouldBeSelected };
      }),
    );
  }, [focusedPath, setNodes]);

  return (
    <div className="canvas-pane">
      <ReactFlow
        nodes={nodes}
        edges={edgesState}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => onFocus(n.id)}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={24} size={1} color="#e2e8f0" />
        <Controls position="bottom-right" showInteractive={false} />
        {nodes.length > 6 && (
          <MiniMap
            position="top-right"
            nodeColor={(n) => {
              const d = n.data as unknown as ReadingPathEntry;
              if (d.isEntry) return "#3b82f6";
              if (d.isSpine) return "#f59e0b";
              return "#94a3b8";
            }}
            pannable
            zoomable
          />
        )}
      </ReactFlow>
    </div>
  );
}
