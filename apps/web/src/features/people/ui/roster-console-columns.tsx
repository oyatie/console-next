// SPDX-License-Identifier: LicenseRef-Proprietary
import { ArrowDown, ArrowUp } from "lucide-react";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { Button, Check } from "../../../ui/button/button";
import { moveColumn, OPTIONAL_COLUMNS, toggleColumn, type ColumnId } from "../domain/columns";
import s from "./roster.module.css";

export function ConsoleColumnsBody({
  shown,
  onChange,
  onClose,
}: {
  shown: ColumnId[];
  onChange: (next: ColumnId[]) => void;
  onClose: () => void;
}) {
  const rows = [...shown, ...OPTIONAL_COLUMNS.filter(id => !shown.includes(id))];
  const name = (id: ColumnId) => t(`roster.columns.${id}`);
  return (
    <div className="stack">
      <ul className={s.order} aria-label={t("roster.columns.order")}>
        {rows.map(id => {
          const on = shown.includes(id);
          const at = shown.indexOf(id);
          return (
            <li key={id}>
              <div className={s.colBox}>
                <Check checked={on} onChange={() => onChange(toggleColumn(shown, id))}>
                  {name(id)}
                </Check>
              </div>
              {on ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("roster.columns.up", { column: name(id) })}
                    disabled={at === 0}
                    onClick={() => onChange(moveColumn(shown, id, -1))}
                  >
                    <ArrowUp size={12} aria-hidden="true" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t("roster.columns.down", { column: name(id) })}
                    disabled={at === shown.length - 1}
                    onClick={() => onChange(moveColumn(shown, id, 1))}
                  >
                    <ArrowDown size={12} aria-hidden="true" />
                  </Button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      <div className={s.consoleTools}>
        <Button
          size="sm"
          disabled={shown.join() === OPTIONAL_COLUMNS.join()}
          onClick={() => onChange([...OPTIONAL_COLUMNS])}
        >
          {t("roster.columns.reset")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            onClose();
            focusSoon("people-title");
          }}
        >
          {t("empCard.reveal.cancel")}
        </Button>
      </div>
    </div>
  );
}
