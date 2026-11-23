// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { RecordSection } from "../../../ui/record/record-section";
import { SetupRail } from "../../../ui/setup-rail/setup-rail";
import { payGroupsQuery, payrollRunsPages, type PayGroup } from "../api";
import { payDateRule, periodRule, runName, runStatus } from "../present";
import s from "./payroll-console.module.css";

const periodRange = (start: string, end: string) => `${fmtDate(start)} – ${fmtDate(end)}`;

function GroupRunsConsole({ group }: { group: PayGroup }) {
  const runs = useInfiniteQuery(
    payrollRunsPages({ pay_group_id: group.id, legal_entity_id: group.legal_entity_id }),
  );
  const loadedRows = (runs.data?.pages ?? [])
    .flatMap(page => page.items)
    .filter(run => run.pay_group_id === group.id && run.legal_entity_id === group.legal_entity_id);
  const totalCount = runs.data ? (runs.data.pages[0]?.total ?? loadedRows.length) : undefined;
  return (
    <RecordSection
      id="payroll-group-runs"
      title={t("payroll.runs", { name: group.name })}
      tools={totalCount !== undefined ? <Chip>{t("statutory.count", { count: totalCount })}</Chip> : undefined}
    >
      <QueryState q={runs} layout="list">
        {data => {
          const rows = data.pages
            .flatMap(page => page.items)
            .filter(run => run.pay_group_id === group.id && run.legal_entity_id === group.legal_entity_id);
          const total = data.pages[0]?.total ?? rows.length;
          return rows.length ? (
            <div className={s.sectionStack}>
              <LongTable
                label={t("payroll.runs", { name: group.name })}
                empty={null}
                rows={rows}
                total={total}
                rowId={run => run.id}
                mobileLayout="compact"
                hasMore={Boolean(runs.hasNextPage)}
                loadingMore={runs.isFetchingNextPage}
                onLoadMore={() => void runs.fetchNextPage()}
                columns={[
                  {
                    id: "name",
                    header: t("payroll.runName"),
                    card: "title",
                    rowHeader: true,
                    cell: run => (
                      <Link to="/payroll/runs/$id" params={{ id: run.id }} className={s.plainLink}>
                        {runName(run, group)}
                      </Link>
                    ),
                  },
                  {
                    id: "period",
                    header: t("payroll.period"),
                    card: "fact",
                    cell: run => <bdi className="num">{periodRange(run.period_start, run.period_end)}</bdi>,
                  },
                  {
                    id: "payDate",
                    header: t("payroll.create.payDate"),
                    card: "fact",
                    cell: run => <bdi className="num">{fmtDate(run.pay_date)}</bdi>,
                  },
                  {
                    id: "status",
                    header: t("payroll.status"),
                    card: "status",
                    cell: run => <Chip>{runStatus(run.status)}</Chip>,
                  },
                ]}
              />
              {runs.hasNextPage ? (
                <div className={s.headActions}>
                  <Button size="sm" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
                    {t("common.more")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <EmptyState title={t("payroll.noRuns")} reason={t("payroll.noRunsReason")} />
          );
        }}
      </QueryState>
    </RecordSection>
  );
}

export function PayrollHomeConsole({
  setupAccess,
  createAccess,
  baseline,
}: {
  setupAccess: unknown;
  createAccess: unknown;
  baseline: () => React.ReactNode;
}) {
  return (
    <ExperienceSwitch baseline={baseline}>
      {() => <PayrollHomeConsoleContent setupAccess={setupAccess} createAccess={createAccess} baseline={baseline} />}
    </ExperienceSwitch>
  );
}

function PayrollHomeConsoleContent({
  setupAccess,
  createAccess,
  baseline,
}: {
  setupAccess: unknown;
  createAccess: unknown;
  baseline: () => React.ReactNode;
}) {
  const groups = useQuery(payGroupsQuery);
  const access = useQuery(myAccessQuery);
  const navigate = useNavigate();
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  const canSetup = Boolean(
    access.data &&
      setupAccess &&
      (setupAccess === "signed-in" || accessRefusal(access.data, setupAccess as never) === null),
  );
  const canCreate = Boolean(
    access.data &&
      createAccess &&
      (createAccess === "signed-in" || accessRefusal(access.data, createAccess as never) === null),
  );

  const items = groups.data?.items ?? [];
  const entities = groups.data?.legal_entities ?? [];
  const activeGroup = items.find(g => g.id === selectedGroupId) ?? items[0];
  const entityName = activeGroup
    ? entities.find(entity => entity.id === activeGroup.legal_entity_id)?.name ?? t("payroll.entityUnnamed")
    : undefined;

  const primaryAction = canCreate
    ? { id: "payroll-create-run", label: t("payroll.create.title"), onAction: () => void navigate({ to: "/payroll/runs/new" }) }
    : canSetup
      ? { id: "payroll-setup", label: t("payroll.setup.add"), onAction: () => void navigate({ to: "/payroll/setup" }) }
      : undefined;

  const rail =
    items.length > 0 && activeGroup ? (
      <nav aria-label={t("payroll.home.groups")} className={s.railList}>
        {items.map(group => {
          const groupEntity = entities.find(e => e.id === group.legal_entity_id)?.name;
          const active = group.id === activeGroup.id;
          return (
            <Button
              key={group.id}
              size="sm"
              variant={active ? "primary" : "ghost"}
              aria-pressed={active}
              className={s.railItem}
              onClick={() => setSelectedGroupId(group.id)}
            >
              {groupEntity ? `${group.name} · ${groupEntity}` : group.name}
            </Button>
          );
        })}
      </nav>
    ) : undefined;

  const mainContent =
    items.length > 0 && activeGroup ? (
      <div className={s.mainStack}>
        <RecordSection
          id="payroll-group-rules"
          title={activeGroup.name}
          tools={entityName ? <bdi className="muted">{entityName}</bdi> : undefined}
        >
          <KeyValue
            readOnly
            items={[
              { key: "payDateRule", label: t("payroll.payDateRule"), value: payDateRule(activeGroup.pay_date_rule) },
              { key: "basePeriod", label: t("payroll.basePeriod"), value: periodRule(activeGroup.base_period) },
              { key: "variablePeriod", label: t("payroll.variablePeriod"), value: periodRule(activeGroup.variable_period) },
              { key: "proration", label: t("payroll.proration"), value: t(`payroll.rule.${activeGroup.proration}`) },
              { key: "channel", label: t("payroll.channel"), value: t(`payroll.rule.${activeGroup.channel}`) },
              {
                key: "sensitive",
                label: t("payroll.sensitive"),
                value: t(
                  activeGroup.sensitive === null
                    ? "payroll.rule.unknown"
                    : activeGroup.sensitive
                      ? "payroll.rule.sensitive.true"
                      : "payroll.rule.sensitive.false",
                ),
              },
              {
                key: "payBasisAllowed",
                label: t("payroll.payBasisAllowed"),
                value:
                  activeGroup.pay_basis_allowed?.map(basis => t(`payroll.rule.${basis}`)).join(" · ") ??
                  t("payroll.rule.unknown"),
              },
            ]}
          />
        </RecordSection>
        <GroupRunsConsole group={activeGroup} />
      </div>
    ) : groups.data ? (
      <div className={s.mainStack}>
        <SetupRail
          title={t("payroll.setup.title")}
          summary={t("payroll.setup.reason")}
          groups={[
            {
              key: "payroll",
              title: t("payroll.title"),
              steps: [
                {
                  key: "entity",
                  title: t("payroll.setup.entity"),
                  state: entities.length ? "done" : "todo",
                  detail: t("payroll.setup.entityDetail"),
                },
                {
                  key: "group",
                  title: t("payroll.setup.group"),
                  state: "todo",
                  action: canSetup ? (
                    <Link to="/payroll/setup" className={buttonClass("primary", { size: "sm", className: s.nowrap })}>
                      {t("payroll.setup.add")}
                    </Link>
                  ) : undefined,
                  detail: t("payroll.setup.groupDetail"),
                },
                {
                  key: "reference",
                  title: t("payroll.setup.reference"),
                  state: "todo",
                  action: (
                    <Link
                      to="/payroll/reference"
                      search={{ entity: undefined }}
                      className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
                    >
                      {t("payroll.reference.title")}
                    </Link>
                  ),
                  detail: t("payroll.setup.referenceDetail"),
                },
              ],
            },
          ]}
        />
      </div>
    ) : null;

  return (
    <ListRecord
      q={groups}
      head={{
        title: t("payroll.title"),
        titleId: "payroll-home-title",
        primary: primaryAction,
        actions: (
          <div className={s.headActions}>
            {canCreate && canSetup ? (
              <Link to="/payroll/setup" className={buttonClass("secondary", { size: "sm", className: s.nowrap })}>
                {t("payroll.setup.add")}
              </Link>
            ) : null}
            <Link
              to="/payroll/reference"
              search={{ entity: undefined }}
              className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
            >
              {t("payroll.reference.title")}
            </Link>
          </div>
        ),
      }}
      rail={rail}
      list={mainContent}
      statusSegments={
        groups.data
          ? [
              { id: "count", content: t("payroll.home.statusGroups", { count: items.length }) },
              ...(activeGroup ? [{ id: "active", tone: "strong" as const, content: activeGroup.name }] : []),
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}
