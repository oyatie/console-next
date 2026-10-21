// Pretendard ships as ~90 unicode-range subsets with font-display: swap, fetched as text needing them first paints.
// A screen painted before its subsets land swaps them in and nudges every control on it a few pixels, under a
// pointer already aimed. So a screen waits until the subsets its catalog's text needs are in, at most CAP_MS.
// catalog text only; a name or other user data can still pull one subset late (one swap, not per screen).
const FONT = '1em "Pretendard Variable"';
const CAP_MS = 1500;
const loads = new Map<string, Promise<unknown>>();

/** Resolves once the glyphs for `text()` are loaded (fetched once per `key`), or after CAP_MS, whichever is first. */
export function glyphs(key: string, text: () => string): Promise<unknown> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  let p = loads.get(key);
  if (!p) loads.set(key, (p = document.fonts.load(FONT, text()).catch(() => undefined)));
  return Promise.race([p, new Promise((r) => setTimeout(r, CAP_MS))]);
}
