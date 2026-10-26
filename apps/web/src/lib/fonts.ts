// SPDX-License-Identifier: LicenseRef-Proprietary
// Subsets use font-display: optional (Vite font policy): slow fonts never swap under an aimed pointer.
import { catalogText, i18n, loadCatalog } from "@console/i18n";
import { chunk } from "./chunk-guard";

const FONT = '1em "Pretendard Variable"';
const loads = new Map<string, Promise<unknown>>();

/** Initiates background loading of glyphs for `text()` (fetched once per `key`). Does not block screen paint. */
export function glyphs(key: string, text: () => string): Promise<unknown> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  let p = loads.get(key);
  if (!p) loads.set(key, (p = document.fonts.load(FONT, text()).catch(() => undefined)));
  return p;
}

/**
 * A lazy screen's import: its route chunk and the active locale's screen catalog
 * resolve together so the screen paints without waiting on font glyphs (lib/fonts).
 * Subsets load in the background; a chunk a deploy removed reloads the page once (lib/chunk-guard).
 */
export const screen = <M,>(load: () => Promise<M>) => () => {
  const l = i18n.locale;
  void loadCatalog(l).then(() => glyphs(l, () => catalogText(l))).catch(() => {});
  return chunk(Promise.all([load(), loadCatalog(l)]).then(([m]) => m));
};
