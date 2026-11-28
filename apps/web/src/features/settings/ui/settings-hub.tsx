// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { chunk } from "../../../lib/chunk-guard";
import { codeText } from "../../../lib/code-text";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { myAccessQuery } from "../../../reference/authz/api";
import { BenefitCatalogLink } from "../../../reference/benefits/ui/benefit-catalog-link";
import { settingsQuery } from "../../../reference/settings/api";
import { settingsViews, type SettingsView } from "../../../shell/settings-views";
import { QueryState } from "../../../lib/react/query-state";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { Button } from "../../../ui/button/button-base";
import { Page } from "../../../ui/page/page";
import { SettingsPattern } from "../../../ui/patterns/settings";
import {
  formatEntryLabel,
  formatEntryValue,
  parseSettingsSection,
  SETTINGS_SECTIONS,
  settingSectionOf,
  type SettingEntry,
  type SettingSectionId,
} from "../domain/catalog";
import type { SummaryCopy } from "../domain/summaries";
import { ApprovalSettingsCard, ModuleOperationsCard, ScreenStyleSettingsCard, SettingsCard } from "./settings-cards";
import s from "./settings-hub.module.css";

const settingsCopy: SummaryCopy = (id, values) => (isMessageId(id) ? t(id, values) : t("settingsHub.unknown"));

const PolicyEditSheet = lazy(() => chunk(import("./policy-edit-sheet")).then(m => ({ default: m.PolicyEditSheet })));
const PolicyInspector = lazy(() => chunk(import("./policy-inspector")).then(m => ({ default: m.PolicyInspector })));
const PolicyCategoryPanel = lazy(() => chunk(import("./policy-sections")).then(m => ({ default: m.PolicyCategoryPanel })));
const WorkplaceScopePanel = lazy(() => chunk(import("./policy-sections")).then(m => ({ default: m.WorkplaceScopePanel })));
const ReasonCodesPanel = lazy(() => chunk(import("./policy-reasons-panel")).then(m => ({ default: m.ReasonCodesPanel })));
const PolicySavedReceipt = lazy(() => chunk(import("./policy-reasons-panel")).then(m => ({ default: m.PolicySavedReceipt })));
const RolloutPanel = lazy(() => chunk(import("./rollout-panel")).then(m => ({ default: m.RolloutPanel })));
const SettingsSummaryStrip = lazy(() => chunk(import("./settings-summary-strip")).then(m => ({ default: m.SettingsSummaryStrip })));

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
  const isDesktop = useIsDesktop();
  const settings = useQuery({ ...settingsQuery, enabled: interactive && section !== "overview" });
  const [inspecting, setInspecting] = useState<InspectState | null>(null);
  const [dismissedSection, setDismissedSection] = useState<SettingSectionId | null>(null);
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
    setDismissedSection(null);
    onSelectSection?.(next);
  };

  const isCategorySection = section === "approvals" || section === "operations" || section === "privacy";
  const autoInspectEntry =
    isDesktop && interactive && isCategorySection && dismissedSection !== section
      ? settings.data?.items.find((entry) => entry.key !== "display.experience" && settingSectionOf(entry.key) === section) ?? null
      : null;
  const activeInspect = inspecting ?? (autoInspectEntry ? { entry: autoInspectEntry, scopeEntityId: null } : null);

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
            selectedKey={activeInspect?.entry.key}
            onInspect={(entry, scopeEntityId, scopeLabel) => {
              setDismissedSection(null);
              setInspecting({ entry, scopeEntityId, scopeLabel });
            }}
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
    if (section === "rollout") {
      return (
        <Suspense fallback={null}>
          <RolloutPanel />
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
              selectedKey={activeInspect?.entry.key}
              onInspect={(entry) => {
                setDismissedSection(null);
                setInspecting({ entry, scopeEntityId: null });
              }}
              onEdit={(entry) => setEditing({ entry, scopeEntityId: null })}
            />
          </Suspense>
        )}
      </QueryState>
    );
  };

  const latestInspectedEntry = activeInspect
    ? (activeInspect.scopeEntityId == null
        ? settings.data?.items.find((item) => item.key === activeInspect.entry.key) ?? activeInspect.entry
        : activeInspect.entry)
    : null;

  return (
    <SettingsPattern
      q={{ isPending: false, error: null, data: rows, refetch: () => {} }}
      head={{ title: t("shell.link.settings"), actions: interactive ? <BenefitCatalogLink /> : undefined }}
      summary={
        interactive && isCategorySection && settings.data ? (
          <Suspense fallback={null}>
            <SettingsSummaryStrip entries={settings.data.items} />
          </Suspense>
        ) : undefined
      }
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
              meta: activeInspect?.scopeLabel ?? codeText(`settingsHub.layer.${latestInspectedEntry.source.layer}`, t("settingsHub.unknown")),
              onClose: () => {
                setInspecting(null);
                setDismissedSection(section);
              },
              children: (
                <Suspense fallback={null}>
                  <PolicyInspector
                    entry={latestInspectedEntry}
                    scopeEntityId={activeInspect?.scopeEntityId ?? null}
                    canChange={Boolean(settings.data?.can_change ?? true)}
                    onEdit={() =>
                      setEditing({
                        entry: latestInspectedEntry,
                        scopeEntityId: activeInspect?.scopeEntityId ?? null,
                        scopeLabel: activeInspect?.scopeLabel,
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
        <Page floorplan="P-05" head={{ title: t("shell.link.settings"), actions: interactive ? <BenefitCatalogLink /> : undefined }}>
          {interactive && onSelectSection && (
            <Button variant="ghost" onClick={() => selectSection(section === "rollout" ? "overview" : "rollout")}>
              {t(section === "rollout" ? "settingsHub.section.overview" : "settingsHub.section.rollout")}
            </Button>
          )}
          <section className={s.grid} aria-label={t("shell.settings.basics")}>
            {section === "rollout" ? renderPanel() : cards}
          </section>
        </Page>
      )}
    />
  );
}
