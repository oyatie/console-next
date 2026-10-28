// SPDX-License-Identifier: LicenseRef-Proprietary
import { i18n, loadCatalog } from "@console/i18n";
import { chunk } from "./chunk-guard";

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
