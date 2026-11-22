// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import type { components } from "@console/api/schema";
import { settingsQuery } from "../../../reference/settings/api";
import { QueryState } from "../../../lib/react/query-state";
import { Table } from "../../../ui/table";

type Entry = components["schemas"]["SettingEntry"];

function isRetentionEntry(entry: Entry): boolean {
  return (
    entry.key.startsWith("retention.") ||
    entry.key.startsWith("privacy.") ||
    entry.key === "people.void_pii_retention"
  );
}

function retentionLabel(key: string): string {
  if (key === "people.void_pii_retention") return t("account.privacy.retention.item.voidPii");
  const msgKey = `settingsHub.key.${key}`;
  return isMessageId(msgKey) ? t(msgKey) : key;
}

function retentionPeriod(entry: Entry): string {
  if (entry.kind.type === "int" && typeof entry.value === "number") {
    if (entry.kind.unit === "days") return t("account.privacy.retention.days", { days: entry.value });
    if (entry.kind.unit === "years") return t("account.privacy.retention.years", { years: entry.value });
    return t("settingsHub.number", { value: entry.value });
  }
  if (entry.kind.type === "bool" && typeof entry.value === "boolean") {
    return t(entry.value ? "settingsHub.on" : "settingsHub.off");
  }
  if (entry.kind.type === "code" && entry.value != null) {
    const id = `settingsHub.code.${entry.value}`;
    if (isMessageId(id)) return t(id);
  }
  return String(entry.value ?? t("account.privacy.retentionPending"));
}

export function PrivacyRetentionSection() {
  const q = useQuery({ ...settingsQuery, retry: false });
  const fallback = <div className="muted t-sm">{t("account.privacy.retention.fallback")}</div>;
  if (q.isError) return fallback;
  return (
    <QueryState q={q} compact denied={fallback}>
      {data => {
        const rows = data.items.filter(isRetentionEntry);
        if (rows.length === 0) return fallback;
        return (
          <Table
            label={t("account.privacy.retention.title")}
            mobileLayout="compact"
            rows={rows}
            rowId={row => row.key}
            columns={[
              { header: t("account.privacy.retention.setting"), card: "title", cell: row => retentionLabel(row.key) },
              { header: t("account.privacy.retention.period"), card: "fact", cell: row => retentionPeriod(row) },
            ]}
          />
        );
      }}
    </QueryState>
  );
}
