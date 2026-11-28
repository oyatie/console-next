// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { myAccessQuery, type AccessEffective } from "../../../reference/authz/api";
import { enforcedRows } from "../../../reference/authz/domain/access";
import { EmptyState } from "../../../ui/empty-state";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { SelectField } from "../../../ui/select/select-field";
import { OvertimeAttestationPanel } from "./overtime-attestation-panel";

function scopeOptions(access: AccessEffective) {
  const names = new Map<string, string>();
  if (access.is_ops) names.set("tenant", t("access.scope.tenant"));
  for (const domain of ["attendance", "settings"]) {
    for (const row of enforcedRows(access, domain, "view")) {
      if (row.scope.kind === "TENANT") names.set("tenant", t("access.scope.tenant"));
      else if (row.scope.node_id) names.set(row.scope.node_id, row.scope.node_name ?? row.role_name_ko);
    }
  }
  return Array.from(names, ([id, label]) => ({ id, label }));
}

export function OvertimeWorkRule() {
  const access = useQuery(myAccessQuery);
  const [choice, setChoice] = useState<string | null>(null);
  const options = access.data ? scopeOptions(access.data) : [];
  const selected = options.find(option => option.id === choice) ?? (options.length === 1 ? options[0] : undefined);
  return <SettingsPattern q={access} head={{ title: t("setup.step.overtime") }} panel={<>
    {access.isSuccess && options.length === 0 && <EmptyState title={t("common.denied.panel")} reason={null} />}
    {options.length > 1 && <SelectField label={t("settingsHub.workplace.scopeLabel")} options={options}
      placeholder={t("settingsHub.workplace.selectPlaceholder")} value={selected?.id ?? null} onChange={setChoice} />}
    {selected && <section aria-label={selected.label}>
      <h2>{selected.label}</h2>
      <OvertimeAttestationPanel key={selected.id} scopeEntityId={selected.id === "tenant" ? null : selected.id} />
    </section>}
  </>} />;
}
