// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * Partition an ordered list of horizontal bar item widths into inline vs overflow indices,
 * guaranteeing that `activeIndex` stays inline whenever it fits inside the reserved budget.
 */
export function partitionBarOverflow(
  widths: readonly number[],
  containerWidth: number,
  reserveWidth: number,
  activeIndex: number,
  persistentReserve = 0,
): { visibleIndices: number[]; overflowIndices: number[] } {
  if (widths.length === 0 || containerWidth <= 0) {
    return { visibleIndices: widths.map((_, idx) => idx), overflowIndices: [] };
  }
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total + persistentReserve <= containerWidth) {
    return { visibleIndices: widths.map((_, idx) => idx), overflowIndices: [] };
  }
  const budget = Math.max(0, containerWidth - reserveWidth);
  const visible: number[] = [];
  let used = 0;
  for (let idx = 0; idx < widths.length; idx++) {
    const w = widths[idx]!;
    if (used + w <= budget) {
      visible.push(idx);
      used += w;
    } else {
      break;
    }
  }
  if (activeIndex >= 0 && activeIndex < widths.length && !visible.includes(activeIndex)) {
    const activeW = widths[activeIndex]!;
    while (visible.length > 0 && used + activeW > budget) {
      const popped = visible.pop()!;
      used -= widths[popped]!;
    }
    visible.push(activeIndex);
  }
  if (visible.length === 0 && widths.length > 0) {
    visible.push(activeIndex >= 0 && activeIndex < widths.length ? activeIndex : 0);
  }
  const visibleSet = new Set(visible);
  const overflowIndices = widths.map((_, idx) => idx).filter(idx => !visibleSet.has(idx));
  return { visibleIndices: visible, overflowIndices };
}
