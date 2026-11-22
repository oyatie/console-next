// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { Banner } from "../../../ui/banner/banner";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import type { ImportDryRun, ImportRow, ReviewItem } from "../domain/contract";
import { canRecordRowIdentifier, rowOf } from "../domain/review";
import type { Picks } from "../domain/steps";
import { itemRemediationHintKey, rowRemediationHintKey } from "../domain/triage";
import { idTypeLabel } from "../present";
import { ReviewResolve } from "./review-resolve";
import { RowDetail } from "./row-detail";
import s from "./import-console.module.css";

const RowIdentifierControl = lazy(() => chunk(import("./resolve-controls")).then((m) => ({ default: m.RowIdentifierControl })));

export function ImportConsoleInspector({
  dry,
  picks,
  currentItem,
  activeRow,
  sexMapped,
  busy,
  onResolve,
  onSheets,
  onDryRun,
  onExpired,
}: {
  dry: ImportDryRun;
  picks: Picks;
  currentItem: ReviewItem | undefined;
  activeRow: ImportRow | undefined;
  sexMapped: boolean;
  busy: boolean;
  onResolve: (c: Picks) => void;
  onSheets: () => void;
  onDryRun?: (d: ImportDryRun) => void;
  onExpired?: () => void;
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
  const idType = activeRow?.new_person?.id_type;
  const showPreHireSecondaryNote =
    activeRow?.new_person?.status === "PRE_HIRE" &&
    (idType === "NOT_ISSUED" || activeRow?.refusal_code === "not_issued_secondary_key_required");
  const currentItemRow = currentItem ? rowOf(dry, currentItem) : undefined;
  const showRowIdentifier = Boolean(
    onDryRun &&
    activeRow &&
    canRecordRowIdentifier(undefined, activeRow) &&
    !(currentItem && canRecordRowIdentifier(currentItem, currentItemRow) && currentItemRow?.source_key === activeRow.source_key),
  );

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
            onDryRun={onDryRun}
            onExpired={onExpired}
          />
          {itemHintKey && <Banner tone="warn">{t(itemHintKey as "importReview.hint.invalid_date")}</Banner>}
        </>
      )}
      {activeRow && (
        <RowDetail
          r={activeRow}
          extra={
            <div className={s.inspectorExtras}>
              {idType && <Chip tone={idType === "NOT_ISSUED" ? "warn" : "neutral"}>{idTypeLabel(idType)}</Chip>}
              {showPreHireSecondaryNote && <Chip tone="info">{t("import.rows.preHireBadge")}</Chip>}
              {sexText && <div className={s.mutedLine}>{t(sexMapped ? "import.rows.sexRecorded" : "import.rows.sexDerived", { sex: sexText })}</div>}
              {showRowHint && <Banner tone="warn">{t(rowHintKey as "importReview.hint.invalid_date")}</Banner>}
              {showRowIdentifier && onDryRun && (
                <Suspense fallback={null}>
                  <RowIdentifierControl
                    key={activeRow.source_key}
                    runId={dry.run_id}
                    row={activeRow}
                    picks={picks}
                    busy={busy}
                    onDryRun={onDryRun}
                    onExpired={onExpired ?? (() => undefined)}
                  />
                </Suspense>
              )}
            </div>
          }
        />
      )}
      {!currentItem && !activeRow && <p className={s.mutedLine}>{t("import.dry.pickToResolve")}</p>}
    </Card>
  );
}
