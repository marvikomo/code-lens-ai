"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Per-PR "I've reviewed this file" state. Persisted to localStorage so it
 * survives page refresh. Scoped by (owner, repo, number).
 *
 * SSR-safe: state initializes empty server-side and rehydrates from
 * localStorage on the first client effect. There's a tiny render flash
 * where checked items appear unchecked — acceptable cost for not pulling
 * in a server-side state store.
 *
 * Future: when we add server-side persistence (user accounts), swap this
 * hook for a server-backed version with the same shape. No call site
 * changes needed.
 */
export function useReviewProgress(
  owner: string,
  repo: string,
  number: number,
): {
  reviewed: ReadonlySet<string>;
  toggle: (matchedPath: string) => void;
  isReviewed: (matchedPath: string) => boolean;
} {
  const key = `spatial-review:progress:${owner}/${repo}#${number}`;
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set());

  // Rehydrate from localStorage after mount. Failures are silent — a stale
  // or corrupted value just means starting from empty.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setReviewed(new Set(parsed.filter((x): x is string => typeof x === "string")));
      }
    } catch {
      // ignore — corrupted localStorage value
    }
  }, [key]);

  const toggle = useCallback(
    (matchedPath: string) => {
      setReviewed((prev) => {
        const next = new Set(prev);
        if (next.has(matchedPath)) next.delete(matchedPath);
        else next.add(matchedPath);
        try {
          window.localStorage.setItem(key, JSON.stringify([...next]));
        } catch {
          // localStorage unavailable / quota exceeded — keep state in memory
        }
        return next;
      });
    },
    [key],
  );

  const isReviewed = useCallback(
    (matchedPath: string) => reviewed.has(matchedPath),
    [reviewed],
  );

  return { reviewed, toggle, isReviewed };
}
