/**
 * Geometry from the layout, written through the CSSOM: the `style` prop stays forbidden for styling (oxlint), and
 * positions are data, not style. Use as a ref callback; React calls it again on every render with new values.
 */
export const place = (geo: Record<string, string | number>) => (el: HTMLElement | null) => {
  if (!el) return;
  for (const [k, v] of Object.entries(geo)) el.style.setProperty(k, typeof v === "number" ? `${v}px` : v);
};
