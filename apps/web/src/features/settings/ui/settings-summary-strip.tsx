// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { Banner } from "../../../ui/banner/banner";
import { Field } from "../../../ui/field/field";
import { TextInput } from "../../../ui/field/text-input";
import { StatRow } from "../../../ui/key-value/key-value";
import type { SettingEntry } from "../domain/catalog";
import s from "./settings-hub.module.css";

export function PolicySearchBar({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div className={s.scopeBar}>
      <Field label={t("settingsHub.search.label")} required={false}>
        {(props) => <TextInput {...props} value={value} onChange={(e) => onChange(e.target.value)} />}
      </Field>
    </div>
  );
}

export function SettingsSummaryStrip({ entries }: { entries: readonly SettingEntry[] }) {
  const visible = entries.filter((e) => e.key !== "display.experience");
  const tenantSet = visible.filter((e) => e.source.layer === "tenant").length;
  const scopedSet = visible.filter((e) =>
    ["legal_entity", "workplace", "department", "person"].includes(e.source.layer),
  ).length;
  const scheduled = visible.filter((e) => e.scheduled.length > 0).length;
  const undeclared = visible.filter((e) => e.value === null).length;

  return (
    <div className={s.stack}>
      <StatRow
        label={t("shell.link.settings")}
        items={[
          { key: "total", label: t("settingsHub.summary.total"), value: fmtNumber(visible.length) },
          { key: "tenant", label: t("settingsHub.summary.tenantSet"), value: fmtNumber(tenantSet) },
          { key: "scoped", label: t("settingsHub.summary.scopedSet"), value: fmtNumber(scopedSet) },
          { key: "scheduled", label: t("settingsHub.summary.scheduled"), value: fmtNumber(scheduled) },
          { key: "undeclared", label: t("settingsHub.summary.undeclared"), value: fmtNumber(undeclared) },
        ]}
      />
      {undeclared > 0 && (
        <Banner tone="warn">{t("settingsHub.undeclaredBanner", { count: undeclared })}</Banner>
      )}
    </div>
  );
}
