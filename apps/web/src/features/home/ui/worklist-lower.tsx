// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { fmtMonth, fmtNumber } from "@console/i18n/format";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal, type AccessRequirement } from "../../../reference/authz/domain/access";
import { operationAccess } from "../../../reference/authz/domain/operation-access";
import { buttonClass } from "../../../ui/button/button-class";
import { DueCell } from "../../../ui/due-cell/due-cell";
import { StatRow } from "../../../ui/key-value/key-value";
import { PaneHead } from "../../../ui/pane-grid/pane-grid";
import {
  WorklistBandBlock,
  WorklistBandCol,
  WorklistBandEmpty,
  WorklistBandsGrid,
  WorklistMeter,
  WorklistStatWrap,
  WorklistSubLabel,
} from "../../../ui/patterns/worklist-parts";
import { Skeleton } from "../../../ui/skeleton/skeleton";
import { Table } from "../../../ui/table";
import { homeEmployeeFacetsQuery, homeOrgStructureQuery } from "../api";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import { kstDayIso, shortMonthDay } from "../domain/inline-decide";
import { buildPeopleChecks } from "../domain/worklist-lower-checks";
import { KIND_TEXT, recordAction, type RowAction } from "./grouped-queue";
import s from "./worklist-console.module.css";

type FacetCount = components["schemas"]["EmployeeFacetCount"];
type OrgNode = components["schemas"]["OrgStructureNode"];

function statusCount(list: readonly FacetCount[] | undefined, ...values: string[]): number | undefined {
  if (!list) return undefined;
  const hits = values
    .map(val => list.find(entry => entry.value === val))
    .filter((hit): hit is FacetCount => Boolean(hit));
  if (hits.length === 0) return undefined;
  return hits.find(hit => hit.count > 0)?.count ?? hits[0]!.count;
}

function splitPayrollNote(row: AttentionInboxItem): { dueText?: string; checkText: string } {
  const reason = row.context?.reason?.trim();
  if (row.kind === "payroll" && !row.due && reason?.includes(" · ")) {
    const idx = reason.indexOf(" · ");
    return { dueText: reason.slice(0, idx), checkText: reason.slice(idx + 3) };
  }
  return {
    checkText: row.site && row.context?.worksite_name ? row.site : reason || row.title,
  };
}

/**
 * Lower two-column operational bands beneath the deadline strip: monthly operations, capability-gated people checks,
 * headcount stats, and legal-entity headcount breakdown.
 */
export function WorklistLower({
  items,
  asOf,
  focusAfter,
  orgNeed,
  canOrgStructure,
}: {
  items: readonly AttentionInboxItem[];
  asOf?: string | null;
  action?: RowAction;
  focusAfter?: string;
  orgNeed?: AccessRequirement;
  canOrgStructure?: boolean;
}) {
  const access = useQuery({ ...myAccessQuery });
  const canDirectory = Boolean(
    access.data && accessRefusal(access.data, operationAccess["GET /api/v1/employees"]) === null,
  );
  const resolvedOrgNeed = orgNeed ?? operationAccess["GET /api/v1/org-structure"];
  const canOrg =
    canOrgStructure ??
    Boolean(access.data && accessRefusal(access.data, resolvedOrgNeed) === null);

  const facets = useQuery({ ...homeEmployeeFacetsQuery(), enabled: canDirectory });
  const structure = useQuery({ ...homeOrgStructureQuery(), enabled: canOrg });

  const opsItems = items.filter(
    item => item.kind === "period_unlock" || item.kind === "payroll" || Boolean(item.context?.unlock),
  );
  const asOfDay = kstDayIso(asOf);
  const opsPeriodMeta = asOfDay ? fmtMonth(asOfDay.slice(0, 7)) : undefined;

  if (!canDirectory && !canOrg && opsItems.length === 0) return null;

  const peopleChecks = facets.data ? buildPeopleChecks(facets.data.review, items) : [];
  const activeCount = facets.data ? (statusCount(facets.data.status, "ACTIVE") ?? facets.data.total) : 0;
  const leaveCount = facets.data ? (statusCount(facets.data.status, "ON_LEAVE", "LEAVE") ?? 0) : 0;
  const startingCount = facets.data ? (statusCount(facets.data.status, "PRE_HIRE") ?? 0) : 0;
  const entities: readonly OrgNode[] = structure.data?.entities ?? [];
  const maxHeadcount = Math.max(1, ...entities.map(entity => entity.headcount));

  return (
    <WorklistBandsGrid>
      <WorklistBandCol>
        <WorklistBandBlock>
          <PaneHead title={t("home.worklist.opsTitle")} meta={opsPeriodMeta} level={3} />
          {opsItems.length > 0 ? (
            <Table
              density="compact"
              mobileLayout="rows"
              label={t("home.worklist.opsTitle")}
              rows={opsItems}
              rowId={row => row.id}
              columns={[
                {
                  header: t("home.worklist.col.task"),
                  cell: row => (
                    <strong className={s.dateCol}>
                      {t(
                        row.context?.unlock?.exceptionId
                          ? "periodLocks.review.title"
                          : row.kind === "period_unlock" && !row.context?.unlock
                            ? "home.worklist.attendanceClose"
                            : KIND_TEXT[row.kind] ?? "home.inbox.unknown",
                      )}
                    </strong>
                  ),
                },
                { header: t("home.worklist.opsCol.scope"), cell: row => row.context?.worksite_name ?? row.site ?? "—" },
                {
                  header: t("home.worklist.opsCol.state"),
                  cell: row =>
                    t(
                      row.kind === "payroll"
                        ? "home.worklist.opsState.payrollCalculated"
                        : "home.worklist.opsState.beforeClose",
                    ),
                },
                {
                  header: t("home.inbox.column.due"),
                  cell: row => {
                    const note = splitPayrollNote(row);
                    if (note.dueText) return <bdi className="num muted">{note.dueText}</bdi>;
                    const md = shortMonthDay(row.due);
                    return (
                      <div className={s.opsDue}>
                        {md ? <bdi className="num">{md}</bdi> : null}
                        {row.days_remaining != null ? <DueCell days={row.days_remaining} /> : !md ? "—" : null}
                      </div>
                    );
                  },
                },
                {
                  header: t("home.worklist.opsCol.check"),
                  wide: true,
                  cell: row => splitPayrollNote(row).checkText,
                },
                {
                  header: <bdi className="sr-only">{t("home.worklist.col.action")}</bdi>,
                  fit: true,
                  cell: row => <div className={s.dateCol}>{recordAction(row, undefined, "home.inbox.open", focusAfter)}</div>,
                },
              ]}
            />
          ) : (
            <WorklistBandEmpty>{t("home.worklist.opsEmpty")}</WorklistBandEmpty>
          )}
        </WorklistBandBlock>

        {canDirectory ? (
          <WorklistBandBlock>
            <PaneHead title={t("home.worklist.peopleCheck")} level={3} />
            {facets.isPending ? (
              <WorklistBandEmpty><Skeleton decorative bones={["row", "row"]} /></WorklistBandEmpty>
            ) : facets.isError ? (
              <WorklistBandEmpty>{t("common.loadFailed.title")}</WorklistBandEmpty>
            ) : peopleChecks.length === 0 ? (
              <WorklistBandEmpty>{t("home.worklist.peopleEmpty")}</WorklistBandEmpty>
            ) : (
              <Table
                density="compact"
                mobileLayout="rows"
                label={t("home.worklist.peopleCheck")}
                rows={peopleChecks}
                rowId={row => row.key}
                columns={[
                  {
                    header: t("home.worklist.peopleCol.item"),
                    cell: row => {
                      const label =
                        row.missingFieldKey && isMessageId(row.missingFieldKey)
                          ? t(row.labelKey, { field: t(row.missingFieldKey) })
                          : t(row.labelKey);
                      return row.indent ? (
                        <WorklistSubLabel>{label}</WorklistSubLabel>
                      ) : (
                        <strong className="t-ink">{label}</strong>
                      );
                    },
                  },
                  {
                    header: t("home.worklist.peopleCol.count"),
                    fit: true,
                    cell: row => <bdi className={`${s.dateCol} num t-semibold`}>{t("home.worklist.personCount", { count: row.count })}</bdi>,
                  },
                  {
                    header: <bdi className="sr-only">{t("home.worklist.col.action")}</bdi>,
                    fit: true,
                    cell: row => (
                      <Link to={row.to} search={row.search} className={`${buttonClass("secondary", { size: "sm" })} ${s.dateCol}`}>
                        {t("home.inbox.open")}
                      </Link>
                    ),
                  },
                ]}
              />
            )}
          </WorklistBandBlock>
        ) : null}
      </WorklistBandCol>

      {canDirectory || canOrg ? (
        <WorklistBandCol>
          <WorklistBandBlock>
            <PaneHead title={t("home.worklist.headcount")} meta={asOfDay ? t("home.asOf", { time: asOfDay }) : undefined} level={3} />
            {canDirectory ? (
              facets.data ? (
                <WorklistStatWrap>
                  <StatRow
                    label={t("home.worklist.headcount")}
                    items={[
                      { key: "active", label: t("home.worklist.stat.active"), value: fmtNumber(activeCount) },
                      { key: "leave", label: t("home.worklist.stat.leave"), value: fmtNumber(leaveCount) },
                      { key: "starting", label: t("home.worklist.stat.starting"), value: fmtNumber(startingCount) },
                    ]}
                  />
                </WorklistStatWrap>
              ) : facets.isPending ? (
                <WorklistBandEmpty><Skeleton decorative bones={["short", "short"]} /></WorklistBandEmpty>
              ) : !canOrg ? (
                <WorklistBandEmpty>{t("common.loadFailed.title")}</WorklistBandEmpty>
              ) : null
            ) : null}
            {canOrg ? (
              structure.isPending ? (
                <WorklistBandEmpty><Skeleton decorative bones={["row", "row", "row"]} /></WorklistBandEmpty>
              ) : structure.isError ? (
                <WorklistBandEmpty>{t("common.loadFailed.title")}</WorklistBandEmpty>
              ) : entities.length === 0 ? (
                <WorklistBandEmpty>{t("entity.empty.title")}</WorklistBandEmpty>
              ) : (
                <Table
                  density="compact"
                  mobileLayout="rows"
                  label={t("home.worklist.entityCol.entity")}
                  rows={[...entities]}
                  rowId={entity => entity.id}
                  columns={[
                    { header: t("home.worklist.entityCol.entity"), cell: entity => <bdi className="t-ink t-medium">{entity.name}</bdi> },
                    {
                      header: t("home.worklist.entityCol.sites"),
                      fit: true,
                      cell: entity => (
                        <bdi className="muted num">
                          {t("home.worklist.siteCount", {
                            count: entity.children?.filter(child => child.kind === "WORKPLACE").length ?? entity.children?.length ?? 0,
                          })}
                        </bdi>
                      ),
                    },
                    {
                      header: t("home.worklist.peopleCol.count"),
                      cell: entity => (
                        <WorklistMeter
                          value={entity.headcount}
                          max={maxHeadcount}
                          label={`${entity.name} ${t("home.worklist.personCount", { count: entity.headcount })}`}
                          valueLabel={fmtNumber(entity.headcount)}
                        />
                      ),
                    },
                  ]}
                />
              )
            ) : null}
          </WorklistBandBlock>
        </WorklistBandCol>
      ) : null}
    </WorklistBandsGrid>
  );
}
