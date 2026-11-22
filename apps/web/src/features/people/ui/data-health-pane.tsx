// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { EMPLOYEE_STATUS, label } from "../../../lib/labels";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import type { CategorySummary, DrilldownItem } from "../domain/data-health";
import s from "./data-health.module.css";

function GapChip({ cat }: { cat: string }) {
  const key = `dataHealth.field.${cat}`;
  const text = t(key as "dataHealth.field.birth");
  const tone = cat === "identity_review" || cat === "failed_action" || cat === "rrn_missing" ? "danger" : "warn";
  return <Chip tone={tone}>{text}</Chip>;
}

export function GapSummary({ categories }: { categories: readonly string[] }) {
  if (categories.length === 0) return null;
  return (
    <bdi className={s.gapSummary}>
      <GapChip cat={categories[0]!} />
      {categories.length > 1 ? (
        <bdi className={s.sub}>
          {" · "}
          {categories.slice(1).map((cat) => t(`dataHealth.field.${cat}` as "dataHealth.field.birth")).join(" · ")}
        </bdi>
      ) : null}
    </bdi>
  );
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
  const search = row.drilldownIds?.length
    ? { ids: row.drilldownIds.join(",") }
    : row.rosterReview
      ? { review: row.rosterReview }
      : {};
  return (
    <Link to="/people" search={search} className={`${buttonClass("ghost", { size: "sm" })} ${s.nowrap}`}>
      {t("dataHealth.summary.openRoster")}
    </Link>
  );
}

export function DataHealthRecordBody({
  item,
  canOrgEdit,
}: {
  item: DrilldownItem;
  canOrgEdit: boolean;
}) {
  return (
    <>
      <RecordIdentityBar name={item.label} path={label(EMPLOYEE_STATUS, item.employmentStatus)} />
      <RecordPaneSection title={t("dataHealth.pane.missingTitle")}>
        <div className={s.chips}>
          {item.missingCategories.map((cat) => (
            <GapChip key={cat} cat={cat} />
          ))}
        </div>
      </RecordPaneSection>
      <RecordPaneSection title={t("dataHealth.pane.nextActions")}>
        <div className={s.actions}>
          <Link to="/people/$id" params={{ id: item.employeeId }} search={{}} className={buttonClass("primary", { size: "sm" })}>
            {t("dataHealth.pane.openCard")}
          </Link>
          {canOrgEdit && (
            <Link to="/people/grid" className={buttonClass("secondary", { size: "sm" })}>
              {t("dataHealth.pane.openGrid")}
            </Link>
          )}
          {item.unplacedKind && canOrgEdit && (
            <Link to="/people/unplaced" className={buttonClass("ghost", { size: "sm" })}>
              {t("dataHealth.pane.openUnplaced")}
            </Link>
          )}
        </div>
      </RecordPaneSection>
    </>
  );
}
