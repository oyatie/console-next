// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Button, Check } from "../../../ui/button/button";
import { Dialog } from "../../../ui/dialog";
import { ALL_OPTIONAL_WORKLIST_COLUMNS, type OptionalWorklistColumn } from "../domain/inline-decide";
import s from "./worklist-console.module.css";

function columnLabel(col: OptionalWorklistColumn) {
  switch (col) {
    case "date":
      return t("home.inbox.column.due");
    case "reason":
      return t("home.inbox.record.reason");
    case "statutory":
      return t("home.worklist.col.statutory");
    case "action":
      return t("home.worklist.col.action");
  }
}

/** Modal column visibility chooser for the Console worklist table. */
export function WorklistColumnsDialog({
  open,
  shownCols,
  onToggle,
  onClose,
}: {
  open: boolean;
  shownCols: ReadonlySet<OptionalWorklistColumn>;
  onToggle: (col: OptionalWorklistColumn, next: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} title={t("home.worklist.columns")} onClose={onClose} size="sm">
      <div className={s.colDialogList}>
        {ALL_OPTIONAL_WORKLIST_COLUMNS.map(col => (
          <Check key={col} checked={shownCols.has(col)} onChange={next => onToggle(col, next)}>
            {columnLabel(col)}
          </Check>
        ))}
      </div>
      <div className="form__actions">
        <Button variant="primary" onClick={onClose}>
          {t("composer.dismiss")}
        </Button>
      </div>
    </Dialog>
  );
}
