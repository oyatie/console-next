// SPDX-License-Identifier: LicenseRef-Proprietary
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { cursorRead, readIdentity } from "../query";
import { markActiveCachedQuery, selectCachedInfinitePages } from "./cached-pages";

type Page = {
  items: { id: string; box: "pending" | "completed" }[];
  next_cursor: string | null;
};

const listQuery = (params: { box: "pending" | "completed"; q?: string }, pages: Page[]) =>
  cursorRead<Page>("/api/v1/approvals", params, async cursor => {
    const idx = cursor ? Number(cursor) : 0;
    return pages[idx]!;
  });

afterEach(() => {
  vi.useRealTimers();
});

test("selectCachedInfinitePages picks only the most recently updated query matching the item (no multi-query concatenation)", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });

  const filtered0418 = listQuery({ box: "pending", q: "0418" }, [
    { items: [{ id: "OC-2026-0418", box: "pending" }], next_cursor: null },
  ]);
  await qc.fetchInfiniteQuery(filtered0418);

  vi.advanceTimersByTime(1000);
  const unfiltered = listQuery({ box: "pending" }, [
    {
      items: [
        { id: "OC-2026-0418", box: "pending" },
        { id: "AP-2026-0419", box: "pending" },
      ],
      next_cursor: null,
    },
  ]);
  await qc.fetchInfiniteQuery(unfiltered);

  const hasDoc = (id: string) => (pages: readonly Page[]) => pages.some(p => p.items.some(item => item.id === id));

  const selectedAfterReset = selectCachedInfinitePages(qc, "/api/v1/approvals", hasDoc("OC-2026-0418"));
  expect(selectedAfterReset).toHaveLength(1);
  expect(selectedAfterReset[0]!.items.map(item => item.id)).toEqual(["OC-2026-0418", "AP-2026-0419"]);

  vi.advanceTimersByTime(1000);
  const filtered0419 = listQuery({ box: "pending", q: "0419" }, [
    { items: [{ id: "AP-2026-0419", box: "pending" }], next_cursor: null },
  ]);
  await qc.fetchInfiniteQuery(filtered0419);

  const selectedAfterSearch = selectCachedInfinitePages(qc, "/api/v1/approvals", hasDoc("AP-2026-0419"));
  expect(selectedAfterSearch).toHaveLength(1);
  expect(selectedAfterSearch[0]!.items.map(item => item.id)).toEqual(["AP-2026-0419"]);

  // Item absent from the newer filtered query resolves against the most recent coherent query containing it.
  const fallbackUnfiltered = selectCachedInfinitePages(qc, "/api/v1/approvals", hasDoc("OC-2026-0418"));
  expect(fallbackUnfiltered[0]!.items.map(item => item.id)).toEqual(["OC-2026-0418", "AP-2026-0419"]);
  qc.clear();
});

test("selectCachedInfinitePages keeps distinct boxes isolated and ignores sibling prefixes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });

  const pending = listQuery({ box: "pending" }, [
    { items: [{ id: "OC-2026-0418", box: "pending" }], next_cursor: null },
  ]);
  await qc.fetchInfiniteQuery(pending);

  vi.advanceTimersByTime(1000);
  const completed = listQuery({ box: "completed" }, [
    { items: [{ id: "COMP-1", box: "completed" }, { id: "COMP-2", box: "completed" }], next_cursor: null },
  ]);
  await qc.fetchInfiniteQuery(completed);

  const sibling = cursorRead<Page>("/api/v1/approvals-archive", { box: "completed" }, async () => ({
    items: [{ id: "ARCH-1", box: "completed" }],
    next_cursor: null,
  }));
  await qc.fetchInfiniteQuery(sibling);

  const hasDoc = (id: string) => (pages: readonly Page[]) => pages.some(p => p.items.some(item => item.id === id));

  expect(selectCachedInfinitePages(qc, "/api/v1/approvals", hasDoc("COMP-1")).flatMap(p => p.items)).toEqual([
    { id: "COMP-1", box: "completed" },
    { id: "COMP-2", box: "completed" },
  ]);
  expect(selectCachedInfinitePages(qc, "/api/v1/approvals", hasDoc("OC-2026-0418")).flatMap(p => p.items)).toEqual([
    { id: "OC-2026-0418", box: "pending" },
  ]);
  expect(selectCachedInfinitePages(qc, "/api/v1/approvals", hasDoc("ARCH-1"))).toEqual([]);
  qc.clear();
});

test("markActiveCachedQuery and active observers resolve stale-cache filter resets and same-timestamp ties", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity } } });

  const unfiltered = listQuery({ box: "pending" }, [
    { items: [{ id: "OC-2026-0418", box: "pending" }, { id: "AP-2026-0419", box: "pending" }], next_cursor: null },
  ]);
  const filtered0418 = listQuery({ box: "pending", q: "0418" }, [
    { items: [{ id: "OC-2026-0418", box: "pending" }], next_cursor: null },
  ]);

  // Same millisecond tie: active observer wins over inactive cached query.
  await qc.fetchInfiniteQuery(unfiltered);
  await qc.fetchInfiniteQuery(filtered0418);
  const observer = new InfiniteQueryObserver(qc, unfiltered);
  const off = observer.subscribe(() => {});
  const has0418 = (pages: readonly Page[]) => pages.some(p => p.items.some(item => item.id === "OC-2026-0418"));
  expect(selectCachedInfinitePages(qc, "/api/v1/approvals", has0418)[0]!.items.map(i => i.id)).toEqual([
    "OC-2026-0418",
    "AP-2026-0419",
  ]);
  off();

  // Later timestamp on filtered query, then filter reset re-activates fresh unfiltered query without refetch.
  vi.advanceTimersByTime(1000);
  await qc.fetchInfiniteQuery(filtered0418);
  expect(selectCachedInfinitePages(qc, "/api/v1/approvals", has0418)[0]!.items.map(i => i.id)).toEqual([
    "OC-2026-0418",
  ]);

  vi.advanceTimersByTime(500);
  markActiveCachedQuery(qc, readIdentity(unfiltered));
  expect(selectCachedInfinitePages(qc, "/api/v1/approvals", has0418)[0]!.items.map(i => i.id)).toEqual([
    "OC-2026-0418",
    "AP-2026-0419",
  ]);
  qc.clear();
});
