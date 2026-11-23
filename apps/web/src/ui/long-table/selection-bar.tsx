// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { Button } from "react-aria-components";
import { t } from "@console/i18n";
import { DisabledReason } from "../disabled-reason/disabled-reason";
import css from "./long-table.module.css";
import { ALL_MATCHING, NO_SELECTION, selectionCount, type Selection } from "./selection";

/** The selected count, the explicit select-all-matching action (or why not), the caller's actions, and how to clear. */
export function SelectionBar({
  sel,
  loaded,
  total,
  hasMore,
  limit,
  actions,
  unit,
  onChange,
}: {
  sel: Selection;
  loaded: number;
  total?: number;
  hasMore: boolean;
  limit?: { max: number; reason?: ReactNode; remedy?: ReactNode };
  actions?: ReactNode;
  unit: string;
  onChange: (s: Selection) => void;
}) {
  const count = selectionCount(sel, total ?? loaded);
  if (count === 0) return null;
  const offerAll = sel.kind === "ids" && hasMore && total !== undefined && sel.ids.size === loaded && total > loaded;
  const tooMany = offerAll && limit !== undefined && total! > limit.max;
  return (
    <div className={css.selection}>
      <span role="status">
        {sel.kind === "all"
          ? t("uiLongTable.selection.all", { count, excluded: sel.excluded.size, unit })
          : t("uiLongTable.selection.ids", { count, unit })}
      </span>
      {offerAll && !tooMany && <Button className="btn btn--ghost" onPress={() => onChange(ALL_MATCHING)}>{t("uiLongTable.selection.selectAll", { total, unit })}</Button>}
      {tooMany && (
        <DisabledReason
          layout="inline"
          reason={limit.reason ?? t("uiLongTable.selection.tooMany", { total, max: limit.max })}
          remedy={limit.remedy}
          control={(d) => <button {...d} className={`btn btn--ghost ${d.className ?? ""}`}>{t("uiLongTable.selection.selectAll", { total, unit })}</button>}
        />
      )}
      {actions}
      <Button className="btn btn--ghost" onPress={() => onChange(NO_SELECTION)}>{t("uiLongTable.selection.clear")}</Button>
    </div>
  );
}
