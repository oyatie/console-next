// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import type { CategorySummary, HealthCategoryId, HealthEmployeeRow } from "../domain/data-health";
import s from "./data-health.module.css";

export function GapChip({ cat, contractEndDate }: { cat: HealthCategoryId; contractEndDate?: string }) {
  const label =
    cat === "contractSoon" && contractEndDate
      ? t("dataHealth.worklist.contractSoon", { date: fmtDate(contractEndDate) })
      : t(`dataHealth.field.${cat}` as "dataHealth.field.birth");
  return <Chip tone={cat === "identity" || cat === "failed" ? "danger" : "warn"}>{label}</Chip>;
}

export function SummaryActionLink({ row, canOrgEdit }: { row: CategorySummary; canOrgEdit: boolean }) {
  if (row.destination === "unplaced" && canOrgEdit) {
    return (
      <Link to="/people/unplaced" className={`${buttonClass("ghost", { size: "sm" })} ${s.nowrap}`}>
        {t("dataHealth.summary.openUnplaced")}
      </Link>
    );
  }
  if (row.destination === "grid" && canOrgEdit) {
    return (
      <Link to="/people/grid" className={`${buttonClass("ghost", { size: "sm" })} ${s.nowrap}`}>
        {t("dataHealth.summary.openGrid")}
      </Link>
    );
  }
  return (
    <Link to="/people" search={row.rosterReview ? { review: row.rosterReview } : {}} className={`${buttonClass("ghost", { size: "sm" })} ${s.nowrap}`}>
      {t("dataHealth.summary.openRoster")}
    </Link>
  );
}

export function DataHealthRecordBody({
  row,
  orgText,
  canOrgEdit,
}: {
  row: HealthEmployeeRow;
  orgText: string;
  canOrgEdit: boolean;
}) {
  return (
    <>
      <RecordIdentityBar name={row.employee.name} number={row.employee.employee_number ?? undefined} path={orgText} />
      <RecordPaneSection title={t("dataHealth.pane.missingTitle")}>
        <div className={s.chips}>
          {row.registerOnly && <Chip tone="warn">{t("dataHealth.worklist.registerNeeded")}</Chip>}
          {row.categories.map((cat) => (
            <GapChip key={cat} cat={cat} contractEndDate={row.employee.contract_end_date} />
          ))}
        </div>
      </RecordPaneSection>
      <RecordPaneSection title={t("dataHealth.pane.nextActions")}>
        <div className={s.actions}>
          <Link to="/people/$id" params={{ id: row.employee.id }} search={{}} className={buttonClass("primary", { size: "sm" })}>
            {t("dataHealth.pane.openCard")}
          </Link>
          {canOrgEdit && (
            <Link to="/people/grid" className={buttonClass("secondary", { size: "sm" })}>
              {t("dataHealth.pane.openGrid")}
            </Link>
          )}
          {row.unplacedKind && canOrgEdit && (
            <Link to="/people/unplaced" className={buttonClass("ghost", { size: "sm" })}>
              {t("dataHealth.pane.openUnplaced")}
            </Link>
          )}
        </div>
      </RecordPaneSection>
    </>
  );
}
