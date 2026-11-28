// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState, type ReactNode } from "react";
import { type UseQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { chunk } from "../../../lib/chunk-guard";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { SearchField } from "../../../ui/search/search-field";
import type { AccessGrant } from "../api";
import { lastDay } from "../domain/grants";
import { enforcementText, periodText, storedScope } from "../present";
import { AccessNavTabs } from "./access-head";
import s from "./access.module.css";

const AccessReviewCyclePanel = lazy(() =>
  chunk(import("./access-review-cycle")).then((m) => ({ default: m.AccessReviewCyclePanel })),
);

const ISO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });
function fmtIsoDay(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : ISO_DAY.format(d);
}

function consistentGrantPeriod(g: AccessGrant): string {
  const from = g.enforcement === "PREPARED"
    ? t("access.period.golive")
    : fmtIsoDay(g.enforcement === "SCHEDULED" && g.activates_at ? g.activates_at : g.valid_from);
  const to = lastDay(g.valid_to);
  return to ? t("access.period", { from, to: fmtIsoDay(to) }) : t("access.period.open", { from });
}

function AccessReviewInspector({ grant }: { grant: AccessGrant }) {
  return (
    <div className={s.stack}>
      <RecordIdentityBar
        name={grant.account_display_name ?? grant.account_employee_number ?? grant.account_id}
        number={grant.account_employee_number}
        badges={
          <Chip tone={grant.enforcement === "ENFORCED" ? "ok" : "neutral"}>
            {enforcementText(grant.enforcement)}
          </Chip>
        }
        roleLine={grant.account_unit ?? grant.role_name_ko}
      />
      <RecordPaneSection title={t("accessReview.detail.title")}>
        <KeyValue
          density="dense"
          items={[
            { key: "role", label: t("accessReview.role"), value: grant.role_name_ko },
            { key: "scope", label: t("accessReview.scope"), value: storedScope(grant.scope) },
            { key: "period", label: t("accessReview.period"), value: periodText(grant) },
            { key: "grantedAt", label: t("accessReview.detail.grantedAt"), value: fmtDateTime(grant.granted_at) },
            { key: "state", label: t("accessReview.state"), value: enforcementText(grant.enforcement) },
          ]}
        />
      </RecordPaneSection>
      <RecordPaneSection title={t("accessReview.action.section")}>
        <div className={s.pad}>
          <div className={s.actions}>
            <Link
              to="/access/people/$accountId"
              params={{ accountId: grant.account_id }}
              className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
            >
              {t("accessReview.action.editPeriod")}
            </Link>
            <Link
              to="/access/people/$accountId"
              params={{ accountId: grant.account_id }}
              className={buttonClass("ghost-danger", { size: "sm", className: s.nowrap })}
            >
              {t("accessReview.action.revoke")}
            </Link>
          </div>
          <p className={s.lede}>{t("accessReview.action.openPerson")}</p>
        </div>
      </RecordPaneSection>
    </div>
  );
}

export function AccessReviewConsole({
  grants,
  phase,
  items,
  rows,
  find,
  onFind,
  statItems,
  selected,
  onSelect,
  baseline,
}: {
  grants: UseQueryResult<{ items: AccessGrant[] }>;
  phase?: "SETUP" | "OPERATING";
  items: AccessGrant[];
  rows: AccessGrant[];
  find: string;
  onFind: (value: string) => void;
  statItems: { key: string; label: string; value: string; active: boolean; onPress: () => void }[];
  selected: AccessGrant | null;
  onSelect: (grant: AccessGrant | null) => void;
  baseline: () => ReactNode;
}) {
  const isDesktop = useIsDesktop();
  const [dismissedAuto, setDismissedAuto] = useState(false);
  const [cyclePeriod, setCyclePeriod] = useState<string | null>(null);
  const effectiveSelected = cyclePeriod ? null : (selected ?? (isDesktop && !dismissedAuto ? (rows[0] ?? null) : null));

  return (
    <ListRecord
      q={grants}
      tabs={<AccessNavTabs failed={Boolean(grants.error)} />}
      head={{
        title: t("accessReview.title"),
        titleId: "access-review-title",
        asOf: phase && (
          <PhaseLine phase={phase === "SETUP" ? "setup" : "operating"}>
            {t(phase === "SETUP" ? "access.phase.setup" : "access.phase.operating")}
          </PhaseLine>
        ),
        actions: phase === "OPERATING" ? (
          <Suspense fallback={null}>
            <AccessReviewCyclePanel mode="toolbar" activePeriod={cyclePeriod} onSelectPeriod={setCyclePeriod} />
          </Suspense>
        ) : undefined,
      }}
      find={!cyclePeriod && items.length > 0 ? <SearchField label={t("accessReview.find")} value={find} onChange={onFind} className={s.findField} /> : undefined}
      stats={!cyclePeriod && items.length > 0 ? <StatRow label={t("accessReview.title")} items={statItems} /> : undefined}
      list={
        cyclePeriod ? (
          <Suspense fallback={null}>
            <AccessReviewCyclePanel mode="body" activePeriod={cyclePeriod} onSelectPeriod={setCyclePeriod} />
          </Suspense>
        ) : !items.length ? (
          <EmptyState title={t("accessReview.empty")} reason={t("accessReview.emptyReason")} />
        ) : (
          <LongTable
            label={t("accessReview.table")}
            rows={rows}
            rowId={g => g.id}
            total={rows.length}
            hasMore={false}
            onLoadMore={() => {}}
            density="compact"
            mobileLayout="compact"
            activeRowId={effectiveSelected?.id}
            onRowAction={id => {
              setDismissedAuto(false);
              onSelect(rows.find(row => row.id === id) ?? null);
            }}
            empty={t("accessReview.noMatch")}
            columns={[
              {
                id: "person",
                header: t("accessReview.person"),
                card: "title",
                rowHeader: true,
                cell: g => (
                  <Link className={`${s.plainLink} ${s.strong}`} to="/access/people/$accountId" params={{ accountId: g.account_id }}>
                    {g.account_display_name ?? g.account_employee_number ?? g.account_id}
                  </Link>
                ),
              },
              { id: "number", header: t("accessReview.number"), card: "fact", width: 96, cell: g => g.account_employee_number ?? "—" },
              { id: "role", header: t("accessReview.role"), card: "fact", cell: g => g.role_name_ko },
              { id: "scope", header: t("accessReview.scope"), card: "omit", cell: g => storedScope(g.scope) },
              { id: "period", header: t("accessReview.period"), card: "fact", width: 200, cell: g => <bdi className={`num ${s.nowrap}`}>{consistentGrantPeriod(g)}</bdi> },
              {
                id: "state",
                header: t("accessReview.state"),
                card: "status",
                width: 112,
                cell: g => <Chip tone={g.enforcement === "ENFORCED" ? "ok" : "neutral"}>{enforcementText(g.enforcement)}</Chip>,
              },
            ]}
          />
        )
      }
      onSelect={id => {
        setDismissedAuto(false);
        onSelect(rows.find(row => row.id === id) ?? null);
      }}
      record={
        effectiveSelected
          ? {
              id: effectiveSelected.id,
              label: t("accessReview.detail.title"),
              title: effectiveSelected.account_display_name ?? effectiveSelected.account_employee_number ?? t("accessReview.detail.title"),
              meta: effectiveSelected.role_name_ko,
              onClose: () => {
                onSelect(null);
                setDismissedAuto(true);
              },
              children: <AccessReviewInspector grant={effectiveSelected} />,
            }
          : undefined
      }
      baseline={baseline}
    />
  );
}
