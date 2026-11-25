// SPDX-License-Identifier: LicenseRef-Proprietary
import { isValidElement, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

type ScreenStatusSegment = {
  id: string;
  content: ReactNode;
  tone?: "default" | "strong" | "attention";
};

// Segments and the trailing fact are owned apart: a screen may publish its trailing fact while its pattern publishes
// the segments.
type Slot<T> = { value: T | null; owner: object | null };
const segmentsSlot: Slot<readonly ScreenStatusSegment[]> = { value: null, owner: null };
const trailingSlot: Slot<ReactNode> = { value: null, owner: null };
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

const segmentsSnapshot = () => segmentsSlot.value;
const trailingSnapshot = () => trailingSlot.value;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>, depth: number): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(k => Object.hasOwn(b, k) && sameContent(a[k], b[k], depth))
  );
}

function sameContent(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth >= 32) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameContent(v, b[i], depth + 1));
  }
  if (isValidElement(a) || isValidElement(b)) {
    if (!isValidElement(a) || !isValidElement(b) || a.type !== b.type || a.key !== b.key) return false;
    return sameRecord(a.props as Record<string, unknown>, b.props as Record<string, unknown>, depth + 1);
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    return sameRecord(a, b, depth + 1);
  }
  return false;
}

function sameSegments(a: readonly ScreenStatusSegment[] | null, b: readonly ScreenStatusSegment[] | null) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((seg, i) => {
    const other = b[i];
    return Boolean(other && seg.id === other.id && seg.tone === other.tone && sameContent(seg.content, other.content));
  });
}

function release<T>(slot: Slot<T>, owner: object | null) {
  if (slot.owner !== owner) return;
  slot.value = null;
  slot.owner = null;
  notify();
}

function claim<T>(slot: Slot<T>, owner: object, value: T | null, same: (a: T | null, b: T | null) => boolean) {
  if (value === null) return release(slot, owner);
  if (slot.owner === owner && same(slot.value, value)) return;
  slot.value = value;
  slot.owner = owner;
  notify();
}

/**
 * Publish contextual status-bar segments, and an optional fact for the bar's right end, while the calling screen or
 * pattern is mounted.
 */
export function useScreenStatusBar(segments: readonly ScreenStatusSegment[] | null | undefined, trailing?: ReactNode) {
  const ownerRef = useRef<object | null>(null);
  ownerRef.current ??= {};

  useEffect(() => claim(segmentsSlot, ownerRef.current!, segments && segments.length > 0 ? segments : null, sameSegments), [segments]);
  useEffect(() => claim(trailingSlot, ownerRef.current!, trailing ?? null, sameContent), [trailing]);
  useEffect(() => () => {
    release(segmentsSlot, ownerRef.current);
    release(trailingSlot, ownerRef.current);
  }, []);
}

/** Subscribe to any active screen-published status-bar segments. */
export function usePublishedStatusBar() {
  return useSyncExternalStore(subscribe, segmentsSnapshot, () => null);
}

/** Subscribe to the fact the active screen publishes for the status bar's right end. */
export function usePublishedStatusTrailing() {
  return useSyncExternalStore(subscribe, trailingSnapshot, () => null);
}
