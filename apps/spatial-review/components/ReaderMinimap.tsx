"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import type { FileViewLine } from "@/lib/file-view";

interface ReaderMinimapProps {
  view: FileViewLine[];
  /** Scrollable container the minimap tracks + scrolls. */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Vertical strip on the right edge of the diff. Shows change density
 * across the whole file: green dots for added lines, red dots for
 * removed-ghost lines. The translucent box is the current viewport
 * position. Click anywhere on the strip → diff scrolls to that point.
 *
 * Marks are positioned by *line index proportion* (i / view.length)
 * rather than by pixel — so the minimap stays accurate regardless of
 * how the diff text is laid out. Dense change clusters visually merge
 * into bands, which is the desired UX.
 */
export function ReaderMinimap({ view, scrollContainerRef }: ReaderMinimapProps) {
  const minimapRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const update = () => {
      const mm = minimapRef.current;
      if (!mm) return;
      const mmHeight = mm.clientHeight;
      const scrollHeight = container.scrollHeight;
      if (scrollHeight === 0) return;
      setViewport({
        top: (container.scrollTop / scrollHeight) * mmHeight,
        height: Math.max(
          12, // minimum visible thumb height
          (container.clientHeight / scrollHeight) * mmHeight,
        ),
      });
    };

    update();
    container.addEventListener("scroll", update, { passive: true });
    // ResizeObserver covers layout changes (font load, window resize,
    // metadata pane width changes from prev/next).
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => {
      container.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollContainerRef, view.length]);

  const onJump = (e: React.MouseEvent<HTMLDivElement>) => {
    const container = scrollContainerRef.current;
    const mm = minimapRef.current;
    if (!container || !mm) return;
    const rect = mm.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const proportion = Math.max(0, Math.min(1, y / rect.height));
    // Center the target line on screen — feels better than top-aligning.
    const target =
      proportion * container.scrollHeight - container.clientHeight / 2;
    container.scrollTo({
      top: Math.max(0, target),
      behavior: "smooth",
    });
  };

  return (
    <div className="reader-minimap" ref={minimapRef} onClick={onJump}>
      {view.map((line, i) => {
        if (line.kind === "context") return null;
        const top = (i / view.length) * 100;
        return (
          <div
            key={i}
            className={`mm-mark mm-${line.kind}`}
            style={{ top: `${top}%` }}
            title={
              line.kind === "added"
                ? `+ line ${line.headLine}`
                : `− line ${line.baseLine}`
            }
          />
        );
      })}
      <div
        className="mm-viewport"
        style={{ top: viewport.top, height: viewport.height }}
        aria-hidden
      />
    </div>
  );
}
