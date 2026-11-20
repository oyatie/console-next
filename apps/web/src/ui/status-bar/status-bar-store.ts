// SPDX-License-Identifier: LicenseRef-Proprietary
import { isValidElement, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

type ScreenStatusSegment = {
  id: string;
  content: ReactNode;
  tone?: "default" | "strong" | "attention";
};

let currentSegments: readonly ScreenStatusSegment[] | null = null;
let currentOwner: object | null = null;
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

function sameContent(a: ReactNode, b: ReactNode, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth >= 8) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameContent(v, b[i], depth + 1));
  }
  if (!isValidElement(a) || !isValidElement(b) || a.type !== b.type || a.key !== b.key) return false;
  const ap = a.props as Record<string, unknown>;
  const bp = b.props as Record<string, unknown>;
  const ak = Object.keys(ap);
  return ak.length === Object.keys(bp).length && ak.every(k => Object.hasOwn(bp, k) && sameContent(ap[k] as ReactNode, bp[k] as ReactNode, depth + 1));
}

function sameSegments(a: readonly ScreenStatusSegment[] | null, b: readonly ScreenStatusSegment[] | null) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((seg, i) => {
    const other = b[i];
    return Boolean(other && seg.id === other.id && seg.tone === other.tone && sameContent(seg.content, other.content));
  });
}

/** Publish contextual status-bar segments while the calling screen or pattern is mounted. */
export function useScreenStatusBar(segments: readonly ScreenStatusSegment[] | null | undefined) {
  const ownerRef = useRef<object | null>(null);
  ownerRef.current ??= {};

  useEffect(() => {
    const owner = ownerRef.current!;
    const next = segments && segments.length > 0 ? segments : null;
    if (!next) {
      if (currentOwner === owner) {
        currentSegments = null;
        currentOwner = null;
        notify();
      }
      return;
    }
    if (currentOwner === owner && sameSegments(currentSegments, next)) return;
    currentSegments = next;
    currentOwner = owner;
    notify();
  }, [segments]);

  useEffect(
    () => () => {
      if (currentOwner === ownerRef.current) {
        currentSegments = null;
        currentOwner = null;
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
