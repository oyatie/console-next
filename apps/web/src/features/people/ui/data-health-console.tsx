// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { EMPLOYEE_STATUS, ID_TYPE, IMPORT_RUN_STATUS, label, labeled } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { FilterRail } from "../../../ui/filter-rail/filter-rail";
import { StatRow } from "../../../ui/key-value/key-value";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ListSplitBands, ListSummaryFooter } from "../../../ui/patterns/list-record-parts";
import { WorklistMeter } from "../../../ui/patterns/worklist-parts";
import { Table } from "../../../ui/table";
import { peopleDataHealthQuery, type DataHealthCategory } from "../api/data-health";
import {
  buildCategorySummaries,
  kpiCategory,
  kpiSummary,
  mapDrilldownItems,
  type CategorySummary,
  type DrilldownItem,
  type KpiBucket,
} from "../domain/data-health";
import { DataHealthRecordBody, GapSummary, SummaryActionLink } from "./data-health-pane";
import s from "./data-health.module.css";

export function DataHealthConsole() {
  const today = todayKst();
  const accessQ = useQuery(myAccessQuery);
  const canOrgEdit = accessQ.data !== undefined && accessRefusal(accessQ.data, { domain: "hr_basic", level: "edit", tenant: true }) === null;

  const [kpi, setKpi] = useState<KpiBucket>("all");
  const [category, setCategory] = useState<DataHealthCategory | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const healthQ = useQuery({ ...peopleDataHealthQuery(category ?? undefined), placeholderData: keepPreviousData });
  const data = healthQ.data;
  const summaries = data ? buildCategorySummaries(data) : [];
  const items = data ? mapDrilldownItems(data) : [];
  const counts = data ? kpiSummary(data) : { all: 0, register: 0, unplaced: 0, identity: 0, actionsContracts: 0 };
  const latestImport = canOrgEdit ? data?.latest_import : undefined;

  const activeFilters = (kpi !== "all" ? 1 : 0) + (category ? 1 : 0);
  const resetFilters = () => (setKpi("all"), setCategory(null));
  const chooseKpi = (next: KpiBucket) => {
    const resolvedKpi = next === kpi ? "all" : next;
    setKpi(resolvedKpi);
    setCategory(kpiCategory(resolvedKpi, data));
  };
  const chooseCategory = (next: DataHealthCategory | null) => {
    setCategory(next);
    if (next === null) setKpi("all");
  };

  const selectedItem: DrilldownItem | undefined = selectedId ? items.find((item) => item.employeeId === selectedId) : undefined;
  const cohort = data?.cohort ?? { total: 0, active: 0, on_leave: 0, pre_hire: 0 };

  return (
    <ListRecord
      q={healthQ}
      head={{
        titleId: "data-health-title",
        title: t("dataHealth.title"),
        asOf: t("dataHealth.asOf", { date: today }),
        actions: canOrgEdit ? (
          <>
            <Link to="/people/grid" className={buttonClass("secondary", { size: "sm" })}>{t("dataHealth.action.bulkEdit")}</Link>
            <Link to="/people/import" className={buttonClass("primary", { size: "sm" })}>{t("dataHealth.action.import")}</Link>
          </>
        ) : undefined,
      }}
      stats={
        <StatRow
          phoneCols={2}
          label={t("dataHealth.stat.label")}
          items={[
            {
              key: "all",
              label: t("dataHealth.stat.all"),
              value: fmtNumber(counts.all),
              meta: t("dataHealth.stat.allMeta", { active: cohort.active, onLeave: cohort.on_leave, preHire: cohort.pre_hire }),
              active: kpi === "all" && category === null,
              onPress: () => chooseKpi("all"),
            },
            {
              key: "register",
              label: t("dataHealth.stat.register"),
              value: fmtNumber(counts.register),
              tone: counts.register > 0 ? "warn" : "ok",
              active: kpi === "register",
              onPress: () => chooseKpi("register"),
            },
            {
              key: "unplaced",
              label: t("dataHealth.stat.unplaced"),
              value: fmtNumber(counts.unplaced),
              tone: counts.unplaced > 0 ? "warn" : "ok",
              active: kpi === "unplaced",
              onPress: () => chooseKpi("unplaced"),
            },
            {
              key: "identity",
              label: t("dataHealth.stat.identity"),
              value: fmtNumber(counts.identity),
              tone: counts.identity > 0 ? "danger" : "ok",
              active: kpi === "identity",
              onPress: () => chooseKpi("identity"),
            },
            {
              key: "actionsContracts",
              label: t("dataHealth.stat.actionsContracts"),
              value: fmtNumber(counts.actionsContracts),
              tone: counts.actionsContracts > 0 ? "danger" : "ok",
              active: kpi === "actionsContracts",
              onPress: () => chooseKpi("actionsContracts"),
            },
          ]}
        />
      }
      rail={
        <FilterRail
          label={t("dataHealth.rail.label")}
          toggleLabel={t("dataHealth.rail.toggle")}
          activeCount={activeFilters}
          groups={[
            {
              id: "categories",
              title: t("dataHealth.rail.categories"),
              items: summaries.map((item) => ({
                id: item.id,
                label: t(`dataHealth.field.${item.id}` as "dataHealth.field.birth"),
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
          {latestImport && (
            <Banner
              tone="info"
              actions={<Link to="/people/import" search={{ run: latestImport.run_id }} className={buttonClass("ghost", { size: "sm" })}>{t("dataHealth.latestImportOpen")}</Link>}
            >
              {t("dataHealth.latestImport", {
                status: label(IMPORT_RUN_STATUS, latestImport.status),
                count: latestImport.candidate_rows,
                date: fmtDate(latestImport.applied_at ?? latestImport.created_at),
              })}
            </Banner>
          )}
        </>
      }
      list={
        <div className={s.stack}>
          {data && (
            <Card titleId="data-health-id-summary" title={t("dataHealth.idSummary.title")} flush look="flush">
              <StatRow
                phoneCols={2}
                label={t("dataHealth.idSummary.title")}
                items={[
                  {
                    key: "recorded",
                    label: t("dataHealth.idSummary.recorded"),
                    value: fmtNumber(data.id_summary.rrn_recorded),
                    meta: `${labeled(ID_TYPE, "RRN").label} ${fmtNumber(data.id_summary.by_type.rrn)} · ${labeled(ID_TYPE, "ARC").label} ${fmtNumber(data.id_summary.by_type.arc)} · ${labeled(ID_TYPE, "DOMESTIC_RESIDENCE").label} ${fmtNumber(data.id_summary.by_type.domestic_residence)}`,
                    tone: "ok",
                  },
                  {
                    key: "not_issued",
                    label: t("dataHealth.idSummary.notIssued"),
                    value: fmtNumber(data.id_summary.not_issued),
                    tone: data.id_summary.not_issued > 0 ? "warn" : undefined,
                  },
                  {
                    key: "missing",
                    label: t("dataHealth.idSummary.missing"),
                    value: fmtNumber(data.id_summary.missing),
                    meta: `${t("dataHealth.idSummary.unset")} ${fmtNumber(data.id_summary.by_type.unset)}`,
                    tone: data.id_summary.missing > 0 ? "danger" : "ok",
                  },
                  {
                    key: "bank_ok",
                    label: t("dataHealth.bank.registered"),
                    value: fmtNumber(data.bank_account.registered),
                    tone: "ok",
                  },
                  {
                    key: "bank_missing",
                    label: t("dataHealth.bank.missing"),
                    value: fmtNumber(data.bank_account.missing),
                    tone: data.bank_account.missing > 0 ? "warn" : "ok",
                  },
                ]}
              />
            </Card>
          )}
          <ListSplitBands>
            <Card titleId="data-health-summary" title={t("dataHealth.summary.title")} flush look="flush">
              <Table<CategorySummary>
                label={t("dataHealth.summary.title")}
                density="compact"
                mobileLayout="compact"
                rows={summaries}
                rowId={(r) => r.id}
                columns={[
                  { header: t("dataHealth.summary.col.item"), card: "fact", cell: (r) => t(`dataHealth.field.${r.id}` as "dataHealth.field.birth") },
                  { header: t("dataHealth.summary.col.missing"), card: "status", cell: (r) => <Chip tone={r.missing > 0 ? (r.id === "identity_review" || r.id === "failed_action" || r.id === "rrn_missing" ? "danger" : "warn") : "ok"}>{fmtNumber(r.missing)}</Chip>, fit: true },
                  { header: <bdi className={s.rateHead}>{t("dataHealth.summary.col.rate")}</bdi>, card: "title", fit: true, cell: (r) => <WorklistMeter value={r.total - r.missing} max={Math.max(1, r.total)} label={t("dataHealth.summary.col.rate")} valueLabel={`${r.rate}%`} /> },
                  { header: t("dataHealth.summary.col.action"), card: "action", fit: true, cell: (r) => <SummaryActionLink row={r} canOrgEdit={canOrgEdit} /> },
                ]}
              />
            </Card>
            <Card titleId="data-health-worklist" title={t("dataHealth.worklist.title")} meta={t("dataHealth.foot.count", { shown: items.length })} flush look="flush">
              {items.length === 0 ? (
                <EmptyState
                  title={t("dataHealth.worklist.emptyTitle")}
                  reason={t("dataHealth.worklist.emptyReason")}
                  actions={activeFilters > 0 ? <Button variant="secondary" onClick={resetFilters}>{t("dataHealth.worklist.reset")}</Button> : undefined}
                />
              ) : (
                <Table<DrilldownItem>
                  label={t("dataHealth.worklist.title")}
                  density="compact"
                  mobileLayout="compact"
                  rows={items}
                  rowId={(r) => r.employeeId}
                  selected={selectedId ?? undefined}
                  onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
                  columns={[
                    {
                      header: t("dataHealth.worklist.col.employee"),
                      card: "status",
                      fit: true,
                      cell: (r) => <b className={`num ${s.nowrap}`}>{r.label}</b>,
                    },
                    {
                      header: t("dataHealth.worklist.col.status"),
                      card: "fact",
                      fit: true,
                      cell: (r) => {
                        const st = labeled(EMPLOYEE_STATUS, r.employmentStatus);
                        return <Chip tone={st.tone}>{st.label}</Chip>;
                      },
                    },
                    {
                      header: t("dataHealth.worklist.col.gaps"),
                      card: "title",
                      cell: (r) => <GapSummary categories={r.missingCategories} />,
                    },
                    {
                      header: t("dataHealth.worklist.col.action"),
                      card: "action",
                      fit: true,
                      cell: (r) => (
                        <Link to="/people/$id" params={{ id: r.employeeId }} search={{}} className={`${buttonClass("ghost", { size: "sm" })} ${s.nowrap}`}>
                          {t("dataHealth.worklist.openCard")}
                        </Link>
                      ),
                    },
                  ]}
                />
              )}
            </Card>
          </ListSplitBands>
        </div>
      }
      record={
        selectedItem
          ? {
              id: selectedItem.employeeId,
              label: t("dataHealth.pane.label"),
              closeLabel: t("dataHealth.pane.close"),
              onClose: () => setSelectedId(null),
              children: <DataHealthRecordBody item={selectedItem} canOrgEdit={canOrgEdit} />,
            }
          : false
      }
      foot={<ListSummaryFooter start={t("dataHealth.foot.scoped", { flagged: items.length, total: cohort.total })} end={t("dataHealth.foot.count", { shown: items.length })} />}
      statusSegments={[{ id: "flagged", content: t("dataHealth.foot.scoped", { flagged: items.length, total: cohort.total }), tone: items.length > 0 ? "attention" : "default" }]}
    />
  );
}
