// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import type { ImportDryRun, ImportRow, ReviewItem } from "../domain/contract";
import type { Picks } from "../domain/steps";
import { itemRemediationHintKey, rowRemediationHintKey } from "../domain/triage";
import { ReviewResolve } from "./review-resolve";
import { RowDetail } from "./row-detail";
import s from "./import-console.module.css";

export function ImportConsoleInspector({
  dry,
  picks,
  currentItem,
  activeRow,
  sexMapped,
  busy,
  onResolve,
  onSheets,
}: {
  dry: ImportDryRun;
  picks: Picks;
  currentItem: ReviewItem | undefined;
  activeRow: ImportRow | undefined;
  sexMapped: boolean;
  busy: boolean;
  onResolve: (c: Picks) => void;
  onSheets: () => void;
}) {
  const itemHintKey = currentItem ? itemRemediationHintKey(currentItem.reason) : null;
  const rowHintKey = activeRow ? rowRemediationHintKey(activeRow) : null;
  const sameItemAndRow = Boolean(
    currentItem &&
    activeRow &&
    currentItem.sheet === activeRow.sheet &&
    currentItem.row === activeRow.row,
  );
  const showRowHint = rowHintKey && !(sameItemAndRow && itemHintKey === rowHintKey);
  const sexText =
    activeRow?.new_person?.sex === "MALE" || activeRow?.new_person?.sex === "FEMALE"
      ? t(`import.sex.${activeRow.new_person.sex}`)
      : null;

  return (
    <Card titleId="import-inspector" title={t("import.dry.inspector")}>
      {currentItem && (
        <>
          <ReviewResolve
            key={currentItem.id}
            item={currentItem}
            dry={dry}
            picks={picks}
            busy={busy}
            onResolve={onResolve}
            onSheets={onSheets}
          />
          {itemHintKey && <Banner tone="warn">{t(itemHintKey as "import.hint.invalid_date")}</Banner>}
        </>
      )}
      {activeRow && (
        <RowDetail
          r={activeRow}
          extra={
            <div className={s.inspectorExtras}>
              {activeRow.new_person?.status === "PRE_HIRE" && <Chip tone="info">{t("import.rows.preHireBadge")}</Chip>}
              {sexText && <div className={s.mutedLine}>{t(sexMapped ? "import.rows.sexRecorded" : "import.rows.sexDerived", { sex: sexText })}</div>}
              {showRowHint && <Banner tone="warn">{t(rowHintKey as "import.hint.invalid_date")}</Banner>}
            </div>
          }
        />
      )}
      {!currentItem && !activeRow && <p className={s.mutedLine}>{t("import.dry.pickToResolve")}</p>}
    </Card>
  );
}
