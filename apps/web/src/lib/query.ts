// Query descriptors whose keys derive from the API path: `[path, params]`. A command invalidates by
// path prefix, so a read is refreshed by every write under its path, and two screens asking the
// same path with the same params share one cache entry.
import { hashKey, type QueryClient } from "@tanstack/react-query";
import { api, unwrap } from "@console/api";
import type { AllPaths as paths } from "@console/api/pending";

type Gettable = { [P in keyof paths]: paths[P] extends { get: { parameters: unknown } } ? P : never }[keyof paths];
type Params<P extends Gettable> = paths[P]["get"]["parameters"];
type Data<P extends Gettable> = paths[P]["get"] extends { responses: { 200: { content: { "application/json": infer D } } } } ? D : never;

/**
 * A GET as a query: the key is the path template and its params.
 * `init` is optional even where the path needs params (the server answers 4xx); type it per
 * path with openapi-fetch's MaybeOptionalInit if a missed param ever ships.
 */
export const get = <P extends Gettable>(path: P, init?: { params: Params<P> }) => ({
  queryKey: [path, init?.params ?? null] as const,
  queryFn: () => unwrap(api.GET(path, init as never)) as Promise<Data<P>>,
});

/** A read the API client wraps (not a plain GET), keyed by its path all the same. */
export const read = <T>(path: string, queryFn: () => Promise<T>, params?: unknown) => ({ queryKey: [path, params ?? null] as const, queryFn });

/** Page reads stay live; a rail snapshot refreshes on navigation and successful command invalidation. */
export const navigationRead = <T extends { queryKey: readonly unknown[] }>(descriptor: T) => ({
  ...descriptor,
  queryKey: [...descriptor.queryKey, "navigation"] as const,
  meta: { navigation: true },
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: "always" as const,
  retry: false,
});

/** Every path prefix of an API path ("/api/v1/employees" for "/api/v1/employees/{id}"). */
type Prefix<S extends string> = S extends `${infer H}/${infer T}` ? H | `${H}/${Prefix<T>}` : S;
/** "/api/v1" still type-checks (invalidates every read); narrow it if a command ever passes it. */
export type PathPrefix = Exclude<Prefix<keyof paths & string>, "" | "/api">;

/** A query's API path for commands that refresh that read and its lists. */
export const queryPath = (q: { queryKey: readonly [PathPrefix, ...unknown[]] }) => q.queryKey[0];

/** A derived key whose path is `prefix` or under it (a sibling like "/api/v1/employees-x" is not). */
export const underPath = (prefix: string) => ([k]: readonly unknown[]) => typeof k === "string" && (k === prefix || k.startsWith(prefix + "/"));

/**
 * Marks stale (and refetches if shown) every query whose path is `prefix` or under it, except those under `done` (a
 * command's earlier prefixes: a read re-read twice has its first fetch cancelled, ending a wait on it before it lands).
 */
const invalidatePath = (qc: QueryClient, prefix: PathPrefix, done: readonly PathPrefix[] = []) =>
  qc.invalidateQueries({ predicate: (q) => underPath(prefix)(q.queryKey) && !done.some((d) => underPath(d)(q.queryKey)) });
/** Each command's reads once, by the first of `prefixes` that covers it; one promise per prefix, in order. */
export const invalidatePaths = (qc: QueryClient, prefixes: readonly PathPrefix[]) => prefixes.map((p, i) => invalidatePath(qc, p, prefixes.slice(0, i)));

/**
 * Marks stale (and, unless `refetch` is false, refetches if shown) every query whose derived key passes `match`:
 * the live stream's invalidations (lib/live), which speak in `(path template, params)` and never touch the cache.
 * Navigation snapshots wait for a successful command's invalidatePaths or the next navigation.
 */
export const invalidateWhere = (qc: QueryClient, match: (path: string, params: unknown) => boolean, refetch = true) =>
  qc.invalidateQueries({ predicate: (q) => !q.meta?.navigation && typeof q.queryKey[0] === "string" && match(q.queryKey[0], q.queryKey[1]), refetchType: refetch ? "active" : "none" });

/** Whether a read on screen now (an active query) has a derived key that passes `match`. */
export const shownWhere = (qc: QueryClient, match: (path: string, params: unknown) => boolean) =>
  qc.getQueryCache().findAll({ type: "active", predicate: (q) => typeof q.queryKey[0] === "string" && match(q.queryKey[0], q.queryKey[1]) }).length > 0;

/**
 * A read re-run on open (`refetchOnMount: "always"`) as QueryState's `q`: pending until that read lands, so a
 * confirmation never shows the cached copy (a count or names that predate a change made since).
 */
export const freshOnOpen = <R extends { isFetchedAfterMount: boolean; isError: boolean; isFetching: boolean; data: unknown }>(q: R) => ({
  ...q,
  isPending: !q.isFetchedAfterMount && !(q.isError && !q.isFetching),
  data: q.isFetchedAfterMount ? (q.data as R["data"]) : undefined,
});

/**
 * Keyset pages of a list GET (`cursor` in, `next_cursor` out) as an infinite query: rows stay put while new ones
 * arrive (the attendance month grid). Keyed apart from the plain GET ("cursor").
 */
export const cursorPages = <P extends Gettable>(path: P, query: object) => ({
  queryKey: [path, { query }, "cursor"] as const,
  queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
    unwrap(api.GET(path, { params: { query: { ...query, cursor: pageParam } } } as never)) as Promise<Data<P>>,
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (last: Data<P>) => (last as { next_cursor?: string | null }).next_cursor ?? undefined,
});

/** A query descriptor's cache entry was invalidated by a command since it was last read (it re-reads on next use). */
export const isInvalidated = (qc: QueryClient, q: { queryKey: readonly unknown[] }) => qc.getQueryState(q.queryKey)?.isInvalidated ?? false;

/** Stable identity for a read when one mounted screen changes its path or coordinates. */
export const readIdentity = (q: { queryKey: readonly unknown[] }) => hashKey(q.queryKey);
