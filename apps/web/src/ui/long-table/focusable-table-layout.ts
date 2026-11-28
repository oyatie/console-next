// SPDX-License-Identifier: LicenseRef-Proprietary
import { Rect, TableLayout } from "react-aria-components";

export class FocusableTableLayout extends TableLayout<unknown> {
  override getVisibleLayoutInfos(rect: Rect) {
    const virtualizer = this.virtualizer;
    if (!virtualizer?.persistedKeys.size) return super.getVisibleLayoutInfos(rect);
    const visible = super.getVisibleLayoutInfos(rect.copy());
    let missing: Rect | undefined;
    for (const key of virtualizer.persistedKeys) {
      if (visible.some(item => item.key === key)) continue;
      // Wrapping content can move a row beyond its cached estimate. Recompute its position
      // before TableLayout resolves the focused cell or drop target against the visible rows.
      const margin = virtualizer.size.height;
      missing ??= new Rect(rect.x, Math.max(0, rect.y - margin), rect.width, rect.height + 2 * margin);
      const estimated = this.getLayoutInfo(key);
      if (estimated) missing = missing.union(estimated.rect);
    }
    if (!missing) return visible;
    this.layoutIfNeeded(missing);
    return super.getVisibleLayoutInfos(rect);
  }
}
