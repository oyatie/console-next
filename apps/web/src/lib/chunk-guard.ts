// The bundle's side of the chunk guard. public/chunk-guard.js (loaded before the entry) owns the decision: reload
// once per build with a cache-busting navigation, then an error screen. This file routes lazy chunks through it.
type ChunkGuard = { handled?(error: unknown): void; recover(): boolean; reload(): void; loaded(): void; fail(): void; start(): void };
const guard = (): ChunkGuard | undefined => (globalThis as { consoleChunkGuard?: ChunkGuard }).consoleChunkGuard;

// Chromium, Firefox, Safari, and Vite's CSS preload. TanStack's lazyRouteComponent reloads on the first three itself.
const MISSING = /^(Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS)/;
export const isChunkError = (e: unknown) => e instanceof Error && MISSING.test(e.message);

/**
 * A dynamic import whose chunk may be gone after a deploy. A missing chunk reloads the page once (the promise never
 * settles while it goes); after that it rejects with an error TanStack's own plain `location.reload()` ignores (its
 * test is the message prefix), so the route's error screen shows and the guard alone decides about reloads.
 */
export function chunk<M>(load: Promise<M>): Promise<M> {
  return load.catch((e: unknown) => {
    if (!isChunkError(e)) throw e;
    if (guard()?.recover()) return new Promise<M>(() => {});
    throw new Error(`Chunk still missing after a reload: ${(e as Error).message}`, { cause: e });
  });
}

/** A local boundary keeps the surrounding form; claim Vite's preload failure before its global recovery runs. */
export function localChunk<M>(load: Promise<M>): Promise<M> {
  return load.catch((error: unknown) => { guard()?.handled?.(error); throw error; });
}

/** The error screen's button: a reload that fetches index.html afresh (a plain reload may revalidate a stale one). */
export const reloadPage = () => (guard() ? guard()!.reload() : location.reload());
/** The entry ran: its static imports are in, so failed scripts from here on are lazy chunks. */
export const started = () => guard()?.start();
/** The first screen rendered with its catalog: a later deploy may reload once again. */
export const loaded = () => guard()?.loaded();
/** The React root crashed and unmounted: the static error screen, never a blank page. */
export const crashed = () => guard()?.fail();
