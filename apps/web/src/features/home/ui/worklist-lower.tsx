// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime, fmtMonth, fmtNumber } from "@console/i18n/format";
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
import { KIND_TEXT, recordAction, type RowAction } from "./grouped-queue";
import s from "./worklist-console.module.css";

type FacetCount = components["schemas"]["EmployeeFacetCount"];
type OrgNode = components["schemas"]["OrgStructureNode"];
type PeopleCheckRow = {
  key: string;
  label: string;
  subLabel?: string;
  count: number;
  to: "/people" | "/people/unplaced";
  search?: Record<string, string>;
};

function statusCount(list: readonly FacetCount[] | undefined, ...values: string[]): number | undefined {
  if (!list) return undefined;
  const hits = values
    .map(val => list.find(entry => entry.value === val))
    .filter((hit): hit is FacetCount => Boolean(hit));
  if (hits.length === 0) return undefined;
  return hits.find(hit => hit.count > 0)?.count ?? hits[0]!.count;
}

function buildPeopleChecks(review: components["schemas"]["EmployeeFacets"]["review"]): PeopleCheckRow[] {
  const rows: PeopleCheckRow[] = [];
  if (review.register_review_required > 0) {
    rows.push({
      key: "register",
      label: t("home.review.register"),
      subLabel:
        review.department_missing && review.department_missing > 0
          ? t("home.worklist.peopleSubMissing", { field: t("home.review.unplaced") })
          : undefined,
      count: review.register_review_required,
      to: "/people",
      search: { review: "register" },
    });
  }
  const unplacedCount = review.department_missing ?? review.home_branch_review_required;
  if (unplacedCount > 0) {
    rows.push({ key: "unplaced", label: t("home.review.unplaced"), count: unplacedCount, to: "/people/unplaced" });
  }
  if (review.identity_review_required > 0) {
    rows.push({
      key: "identity",
      label: t("home.review.identity"),
      count: review.identity_review_required,
      to: "/people",
      search: { review: "identity" },
    });
  }
  if (review.lifecycle_apply_failed > 0) {
    rows.push({
      key: "failed",
      label: t("home.part.failedActions"),
      count: review.lifecycle_apply_failed,
      to: "/people",
      search: { review: "failed", status: "all" },
    });
  }
  const contractCount = (review.contract_ended ?? 0) + (review.contract_ending_before ?? 0);
  if (contractCount > 0) {
    rows.push({
      key: "contract",
      label: t("people.lifecycle.action.CONTRACT_RENEWAL"),
      count: contractCount,
      to: "/people",
      search: { review: review.contract_ended > 0 ? "contractPast" : "contractSoon" },
    });
  }
  return rows;
}

/**
 * Lower two-column operational bands beneath the deadline strip: monthly operations, capability-gated people checks,
 * headcount stats, and legal-entity headcount breakdown.
 */
export function WorklistLower({
  items,
  asOf,
  action,
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

  const peopleChecks = facets.data ? buildPeopleChecks(facets.data.review) : [];
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
                    <strong>
                      {t(row.context?.unlock?.exceptionId ? "periodLocks.review.title" : KIND_TEXT[row.kind] ?? "home.inbox.unknown")}
                    </strong>
                  ),
                },
                { header: t("home.worklist.opsCol.scope"), cell: row => row.context?.worksite_name ?? row.site ?? "—" },
                { header: t("home.worklist.opsCol.state"), cell: row => <DueCell days={row.days_remaining} /> },
                { header: t("home.inbox.column.due"), wide: true, cell: row => <bdi className="num muted">{shortMonthDay(row.due) ?? "—"}</bdi> },
                { header: t("home.worklist.opsCol.check"), wide: true, cell: row => (row.site && row.context?.worksite_name ? row.site : row.context?.reason ?? row.title) },
                { header: t("home.worklist.col.action"), fit: true, cell: row => <div className={s.dateCol}>{recordAction(row, action, undefined, focusAfter)}</div> },
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
                    cell: row => (
                      <div>
                        <strong className="t-ink">{row.label}</strong>
                        {row.subLabel ? <WorklistSubLabel>{row.subLabel}</WorklistSubLabel> : null}
                      </div>
                    ),
                  },
                  {
                    header: t("home.worklist.peopleCol.count"),
                    fit: true,
                    cell: row => <bdi className={`${s.dateCol} num t-semibold`}>{t("home.worklist.personCount", { count: row.count })}</bdi>,
                  },
                  {
                    header: t("home.worklist.col.action"),
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
            <PaneHead title={t("home.worklist.headcount")} meta={asOf ? t("home.asOf", { time: fmtDateTime(asOf) }) : undefined} level={3} />
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
