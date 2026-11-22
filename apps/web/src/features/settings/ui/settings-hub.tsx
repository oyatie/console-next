// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { components } from "@console/api/schema";
import { chunk } from "../../../lib/chunk-guard";
import { get } from "../../../lib/query";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { myAccessQuery } from "../../../reference/authz/api";
import { settingsQuery } from "../../../reference/settings/api";
import { settingsViews, type SettingsView } from "../../../shell/settings-views";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button-base";
import { Page } from "../../../ui/page/page";
import { Card } from "../../../ui/card/card";
import { SettingsPattern } from "../../../ui/patterns/settings";
import {
  formatEntryLabel,
  formatEntryValue,
  parseSettingsSection,
  SETTINGS_SECTIONS,
  type SettingEntry,
  type SettingSectionId,
} from "../domain/catalog";
import { domainSummary, approvalSummary, experienceSummary, summaryFormatters, type SummaryCopy } from "../domain/summaries";
import s from "./settings-hub.module.css";

const ScreenStyleSheet = lazy(() => chunk(import("./screen-style-sheet")).then(m => ({ default: m.ScreenStyleSheet })));
const PolicyEditSheet = lazy(() => chunk(import("./policy-edit-sheet")).then(m => ({ default: m.PolicyEditSheet })));
const PolicyInspector = lazy(() => chunk(import("./policy-inspector")).then(m => ({ default: m.PolicyInspector })));
const PolicyCategoryPanel = lazy(() => chunk(import("./policy-sections")).then(m => ({ default: m.PolicyCategoryPanel })));
const WorkplaceScopePanel = lazy(() => chunk(import("./policy-sections")).then(m => ({ default: m.WorkplaceScopePanel })));
const ReasonCodesPanel = lazy(() =>
  chunk(import("./policy-reasons-panel")).then(m => ({ default: m.ReasonCodesPanel })),
);
const PolicySavedReceipt = lazy(() =>
  chunk(import("./policy-reasons-panel")).then(m => ({ default: m.PolicySavedReceipt })),
);

export function SettingsHub() {
  const access = useQuery(myAccessQuery);
  const router = useRouter();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { section?: string };
  const section = parseSettingsSection(search.section);
  const rows = settingsViews(Object.values(router.routesByPath), access.data);
  return (
    <SettingsHubView
      rows={rows}
      interactive
      section={section}
      onSelectSection={(next) => {
        void navigate({
          to: "/settings",
          search: { section: next === "overview" ? undefined : next },
        });
      }}
    />
  );
}

const settingsCopy: SummaryCopy = (id, values) => isMessageId(id) ? t(id, values) : t("settingsHub.unknown");

function SettingsCard({ row }: { row: SettingsView }) {
  const domain = row.summary.format === "domain";
  const me = useQuery({ ...get("/api/v1/users/me"), enabled: domain, staleTime: Infinity, retry: false });
  const format = summaryFormatters[row.summary.format] as (data: unknown, copy: SummaryCopy, date: (value: string) => string) => string;
  const q = useQuery<unknown, Error, string>({ ...row.summary, select: data => domain
    ? domainSummary(data as Parameters<typeof domainSummary>[0], settingsCopy, me.data?.sign_in_id)
    : format(data, settingsCopy, fmtDate), retry: false });
  return <Card title={<Link to={row.to} className={s.link}>{t(row.label)}<ChevronRight size={16} aria-hidden /></Link>}>
    <QueryState q={domain ? { ...q, isPending: q.isPending || me.isPending, error: q.error || me.error } : q} inline own={() => t("settingsHub.unknown")}>
      {value => <div className={s.value}>{value}</div>}
    </QueryState>
  </Card>;
}

function ApprovalSettingsCard({ onManage }: { onManage?: () => void }) {
  const q = useQuery({ ...settingsQuery, select: data => ({ ...approvalSummary(data, settingsCopy, fmtDate), canChange: data.can_change }) });
  return <Card title={t("settingsHub.approval")}>
    <QueryState q={q} inline own={() => t("settingsHub.unknown")}>
      {summary => <>
        <div className={s.row}>
          <div className={s.value}>{summary.value}</div>
          {onManage && summary.canChange && (
            <Button size="sm" variant="secondary" onClick={onManage}>
              {t("settingsHub.operations.editAction")}
            </Button>
          )}
        </div>
        {summary.hints.length > 0 && <ul className={`muted ${s.hints}`}>{summary.hints.map((hint, i) => <li key={i}>{hint}</li>)}</ul>}
      </>}
    </QueryState>
  </Card>;
}

function ModuleOperationsCard({ onManage }: { onManage: () => void }) {
  const q = useQuery(settingsQuery);
  const byKey = new Map((q.data?.items ?? []).map((item) => [item.key, item]));
  const payroll = byKey.get("module.payroll.enabled");
  const week52 = byKey.get("attendance.week52.warn_hours");
  if (!payroll && !week52) return null;
  const parts = [
    payroll ? t(payroll.value ? "settingsHub.operations.payrollOn" : "settingsHub.operations.payrollOff") : null,
    week52 && typeof week52.value === "number" ? t("settingsHub.operations.week52", { hours: week52.value }) : null,
  ].filter(Boolean);
  return (
    <Card title={t("settingsHub.operations.title")}>
      <div className={s.row}>
        <div className={s.value}>{parts.join(" · ")}</div>
        {q.data?.can_change && (
          <Button size="sm" variant="secondary" onClick={onManage}>
            {t("settingsHub.operations.editAction")}
          </Button>
        )}
      </div>
    </Card>
  );
}

function ScreenStyleSettingsCard() {
  const [open, setOpen] = useState(false);
  const q = useQuery({ ...settingsQuery, select: data => experienceSummary(data, settingsCopy, fmtDate) });
  return <Card title={t("settingsHub.key.display.experience")}>
    <QueryState q={q} inline own={() => t("settingsHub.unknown")}>
      {summary => <>
        <div className={s.row}>
          <div className={s.value}>{summary.value}</div>
          {summary.canEdit && summary.entry && <Button size="sm" aria-haspopup="dialog" onClick={() => setOpen(true)}>{t("settingsHub.experience.change")}</Button>}
        </div>
        {summary.hints.length > 0 && <ul className={`muted ${s.hints}`}>{summary.hints.map((hint, i) => <li key={i}>{hint}</li>)}</ul>}
        {open && summary.entry && <Suspense fallback={null}><ScreenStyleSheet entry={summary.entry} onClose={() => setOpen(false)} /></Suspense>}
      </>}
    </QueryState>
  </Card>;
}

type InspectState = { entry: SettingEntry; scopeEntityId: string | null; scopeLabel?: string };
type EditState = { entry: SettingEntry; scopeEntityId: string | null; scopeLabel?: string };

export function SettingsHubView({
  rows,
  interactive = false,
  section = "overview",
  onSelectSection,
}: {
  rows: readonly SettingsView[];
  interactive?: boolean;
  section?: SettingSectionId;
  onSelectSection?: (section: SettingSectionId) => void;
}) {
  const settings = useQuery({ ...settingsQuery, enabled: interactive && section !== "overview" });
  const [inspecting, setInspecting] = useState<InspectState | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [savedChange, setSavedChange] = useState<{ entry: SettingEntry; change: components["schemas"]["SettingChange"] } | null>(null);

  const cards = (
    <>
      {rows.map(row => <SettingsCard key={row.to} row={row} />)}
      <ApprovalSettingsCard onManage={interactive && onSelectSection ? () => onSelectSection("approvals") : undefined} />
      {interactive && onSelectSection && <ModuleOperationsCard onManage={() => onSelectSection("operations")} />}
      <ScreenStyleSettingsCard />
    </>
  );

  const selectSection = (next: SettingSectionId) => {
    setInspecting(null);
    onSelectSection?.(next);
  };

  const renderPanel = () => {
    if (!interactive || section === "overview") {
      return (
        <div className={s.consolePanel} data-settings-hub="" aria-label={t("shell.settings.basics")}>
          {cards}
        </div>
      );
    }
    if (section === "workplace") {
      return (
        <Suspense fallback={null}>
          <WorkplaceScopePanel
            selectedKey={inspecting?.entry.key}
            onInspect={(entry, scopeEntityId, scopeLabel) => setInspecting({ entry, scopeEntityId, scopeLabel })}
            onEdit={(entry, scopeEntityId, scopeLabel) => setEditing({ entry, scopeEntityId, scopeLabel })}
          />
        </Suspense>
      );
    }
    if (section === "reasons") {
      return (
        <Suspense fallback={null}>
          <ReasonCodesPanel />
        </Suspense>
      );
    }
    return (
      <QueryState q={settings} inline own={() => t("settingsHub.unknown")}>
        {(data) => (
          <Suspense fallback={null}>
            <PolicyCategoryPanel
              category={section}
              entries={data.items}
              canChange={data.can_change}
              selectedKey={inspecting?.entry.key}
              onInspect={(entry) => setInspecting({ entry, scopeEntityId: null })}
              onEdit={(entry) => setEditing({ entry, scopeEntityId: null })}
            />
          </Suspense>
        )}
      </QueryState>
    );
  };

  const latestInspectedEntry = inspecting
    ? (inspecting.scopeEntityId == null
        ? settings.data?.items.find((item) => item.key === inspecting.entry.key) ?? inspecting.entry
        : inspecting.entry)
    : null;

  return (
    <SettingsPattern
      q={{ isPending: false, error: null, data: rows, refetch: () => {} }}
      head={{ title: t("shell.link.settings") }}
      views={
        interactive && onSelectSection ? (
          <nav className={s.viewsNav} aria-label={t("shell.link.settings")}>
            {SETTINGS_SECTIONS.map((id) => (
              <Button
                key={id}
                type="button"
                variant={section === id ? "secondary" : "ghost"}
                aria-current={section === id ? "true" : undefined}
                onClick={() => selectSection(id)}
              >
                {t(`settingsHub.section.${id}`)}
              </Button>
            ))}
          </nav>
        ) : undefined
      }
      notes={
        savedChange ? (
          <Suspense fallback={null}>
            <PolicySavedReceipt
              message={t("settingsHub.policy.saved", {
                key: formatEntryLabel(savedChange.entry, settingsCopy),
                value: formatEntryValue(savedChange.entry, savedChange.change.value, settingsCopy),
                date: fmtDate(savedChange.change.effective_from),
              })}
              onDismiss={() => setSavedChange(null)}
            />
          </Suspense>
        ) : undefined
      }
      panel={renderPanel()}
      record={
        latestInspectedEntry
          ? {
              id: latestInspectedEntry.key,
              label: formatEntryLabel(latestInspectedEntry, settingsCopy),
              title: formatEntryLabel(latestInspectedEntry, settingsCopy),
              meta: inspecting?.scopeLabel ?? t(`settingsHub.layer.${latestInspectedEntry.source.layer}`),
              onClose: () => setInspecting(null),
              children: (
                <Suspense fallback={null}>
                  <PolicyInspector
                    entry={latestInspectedEntry}
                    canChange={Boolean(settings.data?.can_change ?? true)}
                    onEdit={() =>
                      setEditing({
                        entry: latestInspectedEntry,
                        scopeEntityId: inspecting?.scopeEntityId ?? null,
                        scopeLabel: inspecting?.scopeLabel,
                      })
                    }
                  />
                </Suspense>
              ),
            }
          : null
      }
      overlays={
        editing ? (
          <Suspense fallback={null}>
            <PolicyEditSheet
              entry={editing.entry}
              scopeEntityId={editing.scopeEntityId}
              scopeLabel={editing.scopeLabel}
              onSaved={(change) => setSavedChange({ entry: editing.entry, change })}
              onClose={() => setEditing(null)}
            />
          </Suspense>
        ) : undefined
      }
      baseline={() => (
        <Page floorplan="P-05" head={{ title: t("shell.link.settings") }}>
          <section className={s.grid} aria-label={t("shell.settings.basics")}>
            {cards}
          </section>
        </Page>
      )}
    />
  );
}
