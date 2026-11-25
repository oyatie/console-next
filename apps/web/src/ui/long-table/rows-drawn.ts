// SPDX-License-Identifier: LicenseRef-Proprietary
/**
 * Runs `apply` once a virtual grid has drawn a row. The grid measures itself before it draws any, and a scroll position
 * set before then is lost to the top. Returns a function that stops waiting.
 */
export function whenRowsDrawn(grid: HTMLElement, apply: () => void): () => void {
  const drawn = () => grid.querySelector("[data-row-id]") !== null;
  if (drawn()) {
    apply();
    return () => {};
  }
  const rows = new MutationObserver(() => {
    if (!drawn()) return;
    rows.disconnect();
    apply();
  });
  rows.observe(grid, { childList: true, subtree: true });
  return () => rows.disconnect();
}
