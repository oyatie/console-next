// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";

export type ReadState<T = unknown> = {
  isPending: boolean;
  error: unknown;
  data: T | undefined;
  refetch: () => unknown;
  fetchStatus?: string;
  isPlaceholderData?: boolean;
};

/** A response determines the state; QueryState may preserve an opted-in record's local draft on loss. */
export function queryView(q: Pick<ReadState, "isPending" | "error" | "data" | "fetchStatus">) {
  if (q.error instanceof ApiError && q.error.status === 403) return "denied";
  if (q.error instanceof ApiError && q.error.status === 404) return "not-found";
  if (q.fetchStatus === "paused") return "offline";
  if (q.isPending && !q.error) return "loading";
  if (q.data !== undefined) return q.error ? "stale" : "ready";
  return q.error ? "failed" : "loading";
}

/** Required reads settle as one region; an error wins over a held sibling instead of hiding forever. */
export function readGroup(reads: readonly ReadState[]): ReadState<true> {
  return {
    isPending: reads.some(q => q.isPending),
    isPlaceholderData: reads.some(q => q.isPlaceholderData),
    error: (reads.find(q => queryView(q) === "denied") ?? reads.find(q => queryView(q) === "not-found") ?? reads.find(q => q.error))?.error ?? null,
    data: reads.every(q => q.data !== undefined) ? true : undefined,
    fetchStatus: reads.some(q => q.fetchStatus === "paused") ? "paused" : undefined,
    refetch: () => Promise.all(reads.map(q => q.refetch())),
  };
}
