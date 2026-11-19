// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

type ScreenStatusSegment = {
  id: string;
  content: ReactNode;
  tone?: "default" | "strong" | "attention";
};

let currentSegments: readonly ScreenStatusSegment[] | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return currentSegments;
}

function sameSegments(a: readonly ScreenStatusSegment[] | null, b: readonly ScreenStatusSegment[] | null) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((seg, i) => {
    const other = b[i];
    return Boolean(other && seg.id === other.id && seg.content === other.content && seg.tone === other.tone);
  });
}

/** Publish contextual status-bar segments while the calling screen or pattern is mounted. */
export function useScreenStatusBar(segments: readonly ScreenStatusSegment[] | null | undefined) {
  const publishedRef = useRef<readonly ScreenStatusSegment[] | null>(null);

  useEffect(() => {
    const next = segments && segments.length > 0 ? segments : null;
    if (!next) {
      if (publishedRef.current && currentSegments === publishedRef.current) {
        currentSegments = null;
        publishedRef.current = null;
        notify();
      }
      return;
    }
    if (publishedRef.current === currentSegments && sameSegments(currentSegments, next)) return;
    currentSegments = next;
    publishedRef.current = next;
    notify();
  }, [segments]);

  useEffect(
    () => () => {
      if (publishedRef.current && currentSegments === publishedRef.current) {
        currentSegments = null;
        publishedRef.current = null;
        notify();
      }
    },
    [],
  );
}

/** Subscribe to any active screen-published status-bar segments. */
export function usePublishedStatusBar() {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
