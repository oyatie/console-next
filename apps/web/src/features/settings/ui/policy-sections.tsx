// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { get } from "../../../lib/query";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { entityName } from "../../../reference/entity/domain/names";
import { entitiesRef } from "../../../reference/entity/api/reads";
import { ApiError, settingsForEntityQuery } from "../../../reference/settings/api";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button-base";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { SelectField, type SelectOption } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import {
  formatEntryDefault,
  formatEntryLabel,
  formatEntryValue,
  isSettingEditable,
  settingSectionOf,
  type SettingEntry,
} from "../domain/catalog";
import { type SummaryCopy } from "../domain/summaries";
import { PolicySearchBar } from "./settings-summary-strip";
import s from "./settings-hub.module.css";

const settingsCopy: SummaryCopy = (id, values) => (isMessageId(id) ? t(id, values) : t("settingsHub.unknown"));
const ownError = (code: string) => {
  const id = `settingsHub.error.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

export function PolicyCategoryPanel({
  category,
  entries,
  canChange,
  selectedKey,
  onInspect,
  onEdit,
}: {
  category: "approvals" | "operations" | "privacy";
  entries: readonly SettingEntry[];
  canChange: boolean;
  selectedKey?: string;
  onInspect: (entry: SettingEntry) => void;
  onEdit: (entry: SettingEntry) => void;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const sectionEntries = entries.filter(
    (entry) => entry.key !== "display.experience" && settingSectionOf(entry.key) === category,
  );
  const filtered = query
    ? sectionEntries.filter((entry) => {
        const label = formatEntryLabel(entry, settingsCopy).toLowerCase();
        const val = formatEntryValue(entry, entry.value, settingsCopy).toLowerCase();
        const statute = entry.legal_basis?.title.toLowerCase() ?? "";
        return label.includes(query) || entry.key.toLowerCase().includes(query) || val.includes(query) || statute.includes(query);
      })
    : sectionEntries;

  if (sectionEntries.length === 0) {
    return (
      <RecordPaneSection title={t(`settingsHub.section.${category}`)}>
        <p className="muted">{t("settingsHub.policy.emptySection")}</p>
      </RecordPaneSection>
    );
  }

  return (
    <RecordPaneSection title={t(`settingsHub.section.${category}`)} padded={false}>
      <PolicySearchBar value={search} onChange={setSearch} />
      <Table<SettingEntry>
        label={t(`settingsHub.section.${category}`)}
        rows={filtered}
        rowId={(entry) => entry.key}
        selected={selectedKey}
        onSelect={(key) => {
          const hit = filtered.find((e) => e.key === key);
          if (hit) onInspect(hit);
        }}
        scrollLayout="auto"
        density="compact"
        mobileLayout="compact"
        columns={[
          {
            header: t("settingsHub.policy.noun"),
            card: "title",
            cell: (entry) => {
              const defaultText = formatEntryDefault(entry, settingsCopy);
              return (
                <div>
                  <div>{formatEntryLabel(entry, settingsCopy)}</div>
                  {defaultText && <div className="muted">{t("settingsHub.policy.defaultValue", { value: defaultText })}</div>}
                </div>
              );
            },
          },
          {
            header: t("settingsHub.policy.valueLabel"),
            card: "status",
            cell: (entry) => (
              <div className={s.chips}>
                <Chip tone={entry.value === null ? "warn" : "neutral"}>{formatEntryValue(entry, entry.value, settingsCopy)}</Chip>
                {entry.scheduled.length > 0 && <Chip tone="info">{fmtDate(entry.scheduled[0]!.effective_from)}</Chip>}
              </div>
            ),
          },
          {
            header: t("settingsHub.workplace.chainTitle"),
            card: "fact",
            cell: (entry) => (
              <div className={s.chips}>
                <Chip tone="info">{t(`settingsHub.layer.${entry.source.layer}`)}</Chip>
                {entry.governance !== "tenant" && <Chip tone="neutral">{t(`settingsHub.governance.${entry.governance}`)}</Chip>}
              </div>
            ),
          },
          {
            header: t("settingsHub.reasons.actionsCol"),
            type: "action",
            card: "action",
            cell: (entry) => (
              <div className={s.actions}>
                <Button size="sm" variant="link" onClick={() => onInspect(entry)}>
                  {t("settingsHub.policy.inspect")}
                </Button>
                {isSettingEditable(entry, canChange) ? (
                  <Button size="sm" variant="secondary" onClick={() => onEdit(entry)}>
                    {t("settingsHub.policy.edit")}
                  </Button>
                ) : (
                  <DisabledReason
                    layout="inline"
                    reason={entry.governance === "tenant" ? t("settingsHub.readOnly") : t(`settingsHub.governance.${entry.governance}`)}
                    control={(props) => (
                      <Button {...props} size="sm" variant="secondary">
                        {t("settingsHub.policy.edit")}
                      </Button>
                    )}
                  />
                )}
              </div>
            ),
          },
        ]}
      />
    </RecordPaneSection>
  );
}

export function WorkplaceScopePanel({
  selectedKey,
  onInspect,
  onEdit,
}: {
  selectedKey?: string;
  onInspect: (entry: SettingEntry, scopeEntityId: string | null, scopeLabel: string) => void;
  onEdit: (entry: SettingEntry, scopeEntityId: string | null, scopeLabel: string) => void;
}) {
  const [scopeId, setScopeId] = useState<string>("tenant");
  const entities = useQuery({ ...entitiesRef, retry: false });
  const orgUnits = useQuery({ ...get("/api/v1/org-units"), retry: false });
  const entityParam = scopeId === "tenant" ? null : scopeId;
  const scopedSettings = useQuery(settingsForEntityQuery(entityParam));

  const options: SelectOption[] = [
    { id: "tenant", label: t("settingsHub.workplace.tenantScope") },
    ...(entities.data?.items ?? []).flatMap((entity) => {
      const labelName = entityName(entity) || entity.id;
      return [
        { id: entity.id, label: `${labelName} (${t("enum.orgChangeTarget.ENTITY")})` },
        ...entity.workplaces.filter((wp) => !wp.closed_on).map((wp) => ({ id: wp.id, label: `${labelName} › ${wp.current?.name ?? wp.id}` })),
      ];
    }),
    ...(orgUnits.data?.items ?? []).map((unit) => ({ id: unit.id, label: unit.name })),
  ];
  const scopeLabel = options.find((o) => o.id === scopeId)?.label ?? t("settingsHub.workplace.tenantScope");
  const scopedDenied = scopedSettings.error instanceof ApiError && scopedSettings.error.status === 403;

  return (
    <div className={s.stack}>
      <RecordPaneSection title={t("settingsHub.section.workplace")} padded={false}>
        <div className={s.scopeBar}>
          <SelectField
            label={t("settingsHub.workplace.scopeLabel")}
            options={options}
            value={scopeId}
            onChange={setScopeId}
            placeholder={t("settingsHub.workplace.selectPlaceholder")}
          />
        </div>
        {scopedDenied ? (
          <Banner tone="warn" title={t("settingsHub.workplace.scopeError")}>
            <CommandError error={scopedSettings.error} own={ownError} />
          </Banner>
        ) : (
          <QueryState q={scopedSettings} inline own={ownError}>
            {(data) => {
              const items = data.items.filter((entry) => entry.key !== "display.experience");
              return (
                <Table<SettingEntry>
                  label={t("settingsHub.section.workplace")}
                  rows={items}
                  rowId={(entry) => entry.key}
                  selected={selectedKey}
                  onSelect={(key) => {
                    const hit = items.find((e) => e.key === key);
                    if (hit) onInspect(hit, entityParam, scopeLabel);
                  }}
                  density="compact"
                  mobileLayout="compact"
                  columns={[
                    { header: t("settingsHub.policy.noun"), card: "title", cell: (entry) => formatEntryLabel(entry, settingsCopy) },
                    { header: t("settingsHub.policy.valueLabel"), card: "status", cell: (entry) => formatEntryValue(entry, entry.value, settingsCopy) },
                    {
                      header: t("settingsHub.workplace.chainTitle"),
                      card: "fact",
                      cell: (entry) => (
                        <div className={s.chips}>
                          {entry.chain.map((layer, i) => (
                            <Chip key={`${layer.layer}-${i}`} tone={layer.deciding ? "ok" : "neutral"}>
                              {t("shellRoutes.pair", {
                                primary: settingsCopy(`settingsHub.layer.${layer.layer}`),
                                secondary: formatEntryValue(entry, layer.value, settingsCopy),
                              })}
                            </Chip>
                          ))}
                        </div>
                      ),
                    },
                    {
                      header: t("settingsHub.reasons.actionsCol"),
                      type: "action",
                      card: "action",
                      cell: (entry) => (
                        <div className={s.actions}>
                          <Button size="sm" variant="link" onClick={() => onInspect(entry, entityParam, scopeLabel)}>
                            {t("settingsHub.policy.inspect")}
                          </Button>
                          {isSettingEditable(entry, data.can_change) ? (
                            <Button size="sm" variant="secondary" onClick={() => onEdit(entry, entityParam, scopeLabel)}>
                              {t("settingsHub.workplace.override")}
                            </Button>
                          ) : (
                            <DisabledReason
                              layout="inline"
                              reason={t(`settingsHub.governance.${entry.governance}`)}
                              control={(props) => (
                                <Button {...props} size="sm" variant="secondary">
                                  {t("settingsHub.workplace.override")}
                                </Button>
                              )}
                            />
                          )}
                        </div>
                      ),
                    },
                  ]}
                />
              );
            }}
          </QueryState>
        )}
      </RecordPaneSection>
    </div>
  );
}
