// SPDX-License-Identifier: LicenseRef-Proprietary
import { i18n, loadCatalog } from "@console/i18n";
import { chunk } from "./chunk-guard";

/** Decode a completed preload before painting; slow/failed fonts keep system metrics for this document. */
export async function prepareFonts() {
  const preload = document.querySelector<HTMLLinkElement>('link[rel="preload"][as="font"][data-ui-font]');
  if (!preload) return;
  if (!performance.getEntriesByName(preload.href).some(entry => entry.entryType === "resource" && (entry as PerformanceResourceTiming).responseEnd > 0)) {
    document.documentElement.dataset.fontFallback = "";
    return;
  }
  try {
    await document.fonts.load(`1em ${JSON.stringify(preload.dataset.uiFont)}`);
  } catch {
    document.documentElement.dataset.fontFallback = "";
  }
}

/**
 * A lazy screen's import: its route chunk and the active locale's screen catalog
 * resolve together. Preloaded optional fonts keep the browser's first-paint choice;
 * forcing a FontFaceSet load here can swap them into an already painted screen.
 * A chunk a deploy removed reloads the page once (lib/chunk-guard).
 */
export const screen = <M,>(load: () => Promise<M>) => () => {
  const l = i18n.locale;
  return chunk(Promise.all([load(), loadCatalog(l)]).then(([m]) => m));
};
