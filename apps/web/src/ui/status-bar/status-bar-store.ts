// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useSyncExternalStore, type ReactNode } from "react";

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

/** Publish contextual status-bar segments while the calling screen or pattern is mounted. */
export function useScreenStatusBar(segments: readonly ScreenStatusSegment[] | null | undefined) {
  useEffect(() => {
    if (!segments || segments.length === 0) {
      if (currentSegments !== null) {
        currentSegments = null;
        notify();
      }
      return;
    }
    currentSegments = segments;
    notify();
    return () => {
      if (currentSegments === segments) {
        currentSegments = null;
        notify();
      }
    };
  }, [segments]);
}

/** Subscribe to any active screen-published status-bar segments. */
export function usePublishedStatusBar() {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
