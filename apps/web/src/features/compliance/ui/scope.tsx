// SPDX-License-Identifier: LicenseRef-Proprietary
import type { useCatalogScope } from "./use-catalog-scope";
import { t } from "@console/i18n";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";

export function BranchField({ scope, value, onChange, all, disabled }: {
  scope: ReturnType<typeof useCatalogScope>; value: string; onChange: (value: string) => void; all?: boolean; disabled?: boolean;
}) {
  return <Field label={t("compliance.branch")} required={!all}>{p => <SelectInput {...p} disabled={disabled}
    value={value} onChange={e => onChange(e.target.value)}>
    <option value="">{t(all ? "compliance.all" : "compliance.chooseBranch")}</option>
    {scope.ids.map(id => <option key={id} value={id}>{scope.names.get(id) ?? id}</option>)}
  </SelectInput>}</Field>;
}
