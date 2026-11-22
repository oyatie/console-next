// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { readGroup } from "../../../lib/react/query-view";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { entitiesRef } from "../../../reference/entity/api";
import { entityName } from "../../../reference/entity/domain/names";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { FilterRail, type FilterRailTreeNode } from "../../../ui/filter-rail/filter-rail";
import { StatRow } from "../../../ui/key-value/key-value";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ListSummaryFooter } from "../../../ui/patterns/list-record-parts";
import { WorklistMeter } from "../../../ui/patterns/worklist-parts";
import { Table } from "../../../ui/table";
import {
  dataHealthEmployeesQuery,
  dataHealthFacetsQuery,
  dataHealthLatestImportRunsQuery,
  dataHealthRegisterFactsQuery,
  dataHealthUnplacedQuery,
} from "../api/data-health";
import { rosterWindowQuery } from "../api/roster";
import {
  buildCategorySummaries,
  buildHealthRows,
  filterHealthRows,
  kpiCounts,
  type CategorySummary,
  type HealthCategoryId,
  type HealthEmployeeRow,
  type KpiBucket,
} from "../domain/data-health";
import { addDays } from "../domain/roster";
import { DataHealthRecordBody, GapChip, SummaryActionLink } from "./data-health-pane";
import s from "./data-health.module.css";

type Employee = components["schemas"]["Employee"];
type RegisterFact = components["schemas"]["RegisterFactsQueryItem"];

const DEFAULT_SOON_DAYS = 30;
const EMPTY_EMPLOYEES: Employee[] = [];
const EMPTY_FACTS: RegisterFact[] = [];
const RAIL_CATEGORIES: readonly HealthCategoryId[] = [
  "birth",
  "sex",
  "address",
  "career",
  "job",
  "hire",
  "unplaced",
  "identity",
  "failed",
  "contractSoon",
];

export function DataHealthConsole() {
  const today = todayKst();
  const accessQ = useQuery(myAccessQuery);
  const canOrgEdit = accessQ.data !== undefined && accessRefusal(accessQ.data, { domain: "hr_basic", level: "edit", tenant: true }) === null;
  const windowQ = useQuery({ ...rosterWindowQuery, retry: false });
  const soonDays = windowQ.data ?? DEFAULT_SOON_DAYS;
  const soonCutoff = addDays(today, soonDays + 1);

  const entitiesQ = useQuery(entitiesRef);
  const facetsQ = useQuery(dataHealthFacetsQuery(soonCutoff));
  const employeesQ = useQuery(dataHealthEmployeesQuery);
  const factsQ = useQuery({ ...dataHealthRegisterFactsQuery, enabled: canOrgEdit });
  const unplacedQ = useQuery({ ...dataHealthUnplacedQuery, enabled: canOrgEdit });
  const runsQ = useQuery({ ...dataHealthLatestImportRunsQuery, enabled: canOrgEdit });

  const [kpi, setKpi] = useState<KpiBucket>("all");
  const [entityId, setEntityId] = useState<string | null>(null);
  const [category, setCategory] = useState<HealthCategoryId | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(25);

  const entities = entitiesQ.data?.items ?? [];
  const employees = employeesQ.data?.items ?? EMPTY_EMPLOYEES;
  const factsItems = factsQ.data?.items ?? EMPTY_FACTS;
  const factsById = new Map(factsItems.map((item) => [item.employee_id, item]));
  const allRows = buildHealthRows(employees, factsById, soonCutoff);
  const filteredRows = filterHealthRows(allRows, { kpi, entityId, category });
  const visibleRows = filteredRows.slice(0, visibleLimit);

  const totalActive = facetsQ.data?.total ?? employeesQ.data?.total ?? employees.length;
  const counts = kpiCounts(allRows, facetsQ.data);
  const unplacedCount = unplacedQ.data?.count ?? counts.unplaced;
  const canReadRegisterFacts = canOrgEdit && factsQ.isSuccess;
  const summaries = buildCategorySummaries({ totalActive, facets: facetsQ.data, employees, factsById, soonCutoff, canReadRegisterFacts });
  const latestAppliedRun = (runsQ.data?.items ?? []).find((r) => r.status === "APPLIED");
  const activeFilters = (kpi !== "all" ? 1 : 0) + (entityId ? 1 : 0) + (category ? 1 : 0);
  const resetFilters = () => (setKpi("all"), setEntityId(null), setCategory(null), setVisibleLimit(25));
  const chooseKpi = (next: KpiBucket) => (setKpi(next), setVisibleLimit(25));
  const chooseEntity = (next: string | null) => (setEntityId(next), setVisibleLimit(25));
  const chooseCategory = (next: HealthCategoryId | null) => (setCategory(next), setVisibleLimit(25));

  const entityCountMap = new Map((facetsQ.data?.legal_entity ?? []).map((x) => [x.value, x.count]));
  const orgNodes: FilterRailTreeNode[] = entities.map((entity) => ({
    id: entity.id,
    label: entityName(entity),
    checked: entityId === entity.id,
    count: entityCountMap.get(entity.id) ?? 0,
    onChange: (checked) => chooseEntity(checked ? entity.id : null),
  }));

  const selectedRow: HealthEmployeeRow | undefined = selectedId ? filteredRows.find((r) => r.employee.id === selectedId) : undefined;
  const orgText = (e: HealthEmployeeRow["employee"]) => [e.company, e.org_unit ?? e.worksite_name].filter(Boolean).join(" · ") || "—";

  return (
    <ListRecord
      q={readGroup([facetsQ, employeesQ])}
      head={{
        titleId: "data-health-title",
        title: t("dataHealth.title"),
        asOf: t("dataHealth.asOf", { date: fmtDate(today) }),
        actions: canOrgEdit ? (
          <>
            <Link to="/people/grid" className={buttonClass("secondary", { size: "sm" })}>{t("dataHealth.action.bulkEdit")}</Link>
            <Link to="/people/import" className={buttonClass("primary", { size: "sm" })}>{t("dataHealth.action.import")}</Link>
          </>
        ) : undefined,
      }}
      stats={
        <StatRow
          label={t("dataHealth.stat.label")}
          items={[
            { key: "all", label: t("dataHealth.stat.all"), value: fmtNumber(counts.all), meta: t("dataHealth.stat.activeMeta", { count: totalActive }), active: kpi === "all", onPress: () => chooseKpi("all") },
            { key: "register", label: t("dataHealth.stat.register"), value: fmtNumber(counts.register), tone: counts.register > 0 ? "warn" : "ok", active: kpi === "register", onPress: () => chooseKpi(kpi === "register" ? "all" : "register") },
            { key: "unplaced", label: t("dataHealth.stat.unplaced"), value: fmtNumber(unplacedCount), tone: unplacedCount > 0 ? "warn" : "ok", active: kpi === "unplaced", onPress: () => chooseKpi(kpi === "unplaced" ? "all" : "unplaced") },
            { key: "identity", label: t("dataHealth.stat.identity"), value: fmtNumber(counts.identity), tone: counts.identity > 0 ? "danger" : "ok", active: kpi === "identity", onPress: () => chooseKpi(kpi === "identity" ? "all" : "identity") },
            { key: "actionsContracts", label: t("dataHealth.stat.actionsContracts"), value: fmtNumber(counts.actionsContracts), tone: counts.actionsContracts > 0 ? "danger" : "ok", active: kpi === "actionsContracts", onPress: () => chooseKpi(kpi === "actionsContracts" ? "all" : "actionsContracts") },
          ]}
        />
      }
      rail={
        <FilterRail
          label={t("dataHealth.rail.label")}
          toggleLabel={t("dataHealth.rail.toggle")}
          activeCount={activeFilters}
          org={{
            title: t("dataHealth.rail.org"),
            all: { label: t("dataHealth.rail.allEntities"), checked: entityId === null, onChange: () => chooseEntity(null) },
            nodes: orgNodes,
          }}
          groups={[
            {
              id: "categories",
              title: t("dataHealth.rail.categories"),
              items: summaries
                .filter((item) => RAIL_CATEGORIES.includes(item.id))
                .map((item) => ({
                  id: item.id,
                  label: item.id === "contractSoon" ? t("dataHealth.field.contractSoon", { days: soonDays }) : t(`dataHealth.field.${item.id}` as "dataHealth.field.birth"),
                  checked: category === item.id,
                  count: item.missing,
                  onChange: (checked) => chooseCategory(checked ? item.id : null),
                })),
            },
          ]}
          reset={{ label: t("dataHealth.rail.clear"), disabled: activeFilters === 0, onReset: resetFilters }}
        />
      }
      notes={
        <>
          {accessQ.isSuccess && !canOrgEdit && <Banner tone="info">{t("dataHealth.limitedNotice")}</Banner>}
          {factsQ.data?.next_cursor && (
            <Banner tone="info">{t("dataHealth.cappedNotice", { shown: factsItems.length, total: facetsQ.data?.review.register_review_required ?? factsItems.length })}</Banner>
          )}
          {latestAppliedRun && (
            <Banner
              tone="info"
              actions={<Link to="/people/import" search={{ run: latestAppliedRun.id }} className={buttonClass("ghost", { size: "sm" })}>{t("dataHealth.latestImportOpen")}</Link>}
            >
              {t("dataHealth.latestImport", {
                file: latestAppliedRun.source_filename,
                inserted: latestAppliedRun.apply_summary?.inserted ?? 0,
                updated: latestAppliedRun.apply_summary?.updated ?? 0,
              })}
            </Banner>
          )}
        </>
      }
      list={
        <div className={s.stack}>
          <Card titleId="data-health-summary" title={t("dataHealth.summary.title")}>
            <Table<CategorySummary>
              label={t("dataHealth.summary.title")}
              density="compact"
              mobileLayout="compact"
              rows={summaries}
              rowId={(r) => r.id}
              columns={[
                { header: t("dataHealth.summary.col.item"), card: "fact", cell: (r) => (r.id === "contractSoon" ? t("dataHealth.field.contractSoon", { days: soonDays }) : t(`dataHealth.field.${r.id}` as "dataHealth.field.birth")) },
                { header: t("dataHealth.summary.col.missing"), card: "status", cell: (r) => <Chip tone={r.missing > 0 ? (r.id === "identity" || r.id === "failed" ? "danger" : "warn") : "ok"}>{fmtNumber(r.missing)}</Chip>, fit: true },
                { header: <bdi className={s.rateHead}>{t("dataHealth.summary.col.rate")}</bdi>, card: "title", fit: true, cell: (r) => <WorklistMeter value={r.total - r.missing} max={Math.max(1, r.total)} label={t("dataHealth.summary.col.rate")} valueLabel={`${r.rate}%`} /> },
                { header: t("dataHealth.summary.col.action"), card: "action", fit: true, cell: (r) => <SummaryActionLink row={r} canOrgEdit={canOrgEdit} /> },
              ]}
            />
          </Card>
          <Card titleId="data-health-worklist" title={t("dataHealth.worklist.title")} meta={t("dataHealth.foot.count", { shown: filteredRows.length })}>
            {filteredRows.length === 0 ? (
              <EmptyState
                title={t("dataHealth.worklist.emptyTitle")}
                reason={t("dataHealth.worklist.emptyReason")}
                actions={activeFilters > 0 ? <Button variant="secondary" onClick={resetFilters}>{t("dataHealth.worklist.reset")}</Button> : undefined}
              />
            ) : (
              <>
                <Table<HealthEmployeeRow>
                  label={t("dataHealth.worklist.title")}
                  density="compact"
                  mobileLayout="compact"
                  rows={visibleRows}
                  rowId={(r) => r.employee.id}
                  selected={selectedId ?? undefined}
                  onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
                  columns={[
                    {
                      header: t("dataHealth.worklist.col.employee"),
                      card: "fact",
                      cell: (r) => (
                        <div className={s.nameCell}>
                          <b>{r.employee.name}</b>
                          <span className={s.subNum}>{r.employee.employee_number ?? "—"}</span>
                        </div>
                      ),
                    },
                    { header: t("dataHealth.worklist.col.org"), card: "title", cell: (r) => <span className={s.sub}>{orgText(r.employee)}</span> },
                    {
                      header: t("dataHealth.worklist.col.gaps"),
                      card: "status",
                      cell: (r) => (
                        <div className={s.chips}>
                          {r.registerOnly && <Chip tone="warn">{t("dataHealth.worklist.registerNeeded")}</Chip>}
                          {r.categories.slice(0, 3).map((cat) => (
                            <GapChip key={cat} cat={cat} contractEndDate={r.employee.contract_end_date} />
                          ))}
                        </div>
                      ),
                    },
                    {
                      header: t("dataHealth.worklist.col.action"),
                      card: "action",
                      fit: true,
                      cell: (r) => (
                        <div className={s.actions}>
                          {r.unplacedKind && canOrgEdit ? (
                            <Link to="/people/unplaced" className={`${buttonClass("secondary", { size: "sm" })} ${s.nowrap}`}>{t("dataHealth.worklist.place")}</Link>
                          ) : null}
                          <Link to="/people/$id" params={{ id: r.employee.id }} search={{}} className={`${buttonClass("ghost", { size: "sm" })} ${s.nowrap}`}>{t("dataHealth.worklist.openCard")}</Link>
                        </div>
                      ),
                    },
                  ]}
                />
                {filteredRows.length > visibleLimit && (
                  <div className={s.moreBar}>
                    <Button variant="secondary" size="sm" onClick={() => setVisibleLimit((n) => n + 25)}>
                      {t("dataHealth.worklist.showMore", { remaining: filteredRows.length - visibleLimit })}
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      }
      record={
        selectedRow
          ? {
              id: selectedRow.employee.id,
              label: t("dataHealth.pane.label"),
              closeLabel: t("dataHealth.pane.close"),
              onClose: () => setSelectedId(null),
              children: <DataHealthRecordBody row={selectedRow} orgText={orgText(selectedRow.employee)} canOrgEdit={canOrgEdit} />,
            }
          : false
      }
      foot={<ListSummaryFooter start={t("dataHealth.foot.scoped", { flagged: allRows.length, total: totalActive })} end={t("dataHealth.foot.count", { shown: filteredRows.length })} />}
      statusSegments={[{ id: "flagged", content: t("dataHealth.foot.scoped", { flagged: allRows.length, total: totalActive }), tone: allRows.length > 0 ? "attention" : "default" }]}
    />
  );
}
