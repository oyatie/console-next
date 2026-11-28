// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Field, TextInput } from "../../../ui/field/field";
import type { Item } from "../api";

import { numbers } from "../domain/attributes";

export function ItemAttributes({ item }: { item?: Item }) {
  return <>
    {numbers.map(([name, key, label, max]) => <Field key={name} label={t(label)} required={false}>{props =>
      <TextInput {...props} name={name} type="number" min={0} max={max} step={1} defaultValue={item?.[key] ?? ""} />}</Field>)}
    <Field label={t("benefits.legalBasis")} required={false}>{props => <TextInput {...props} name="legalBasis" maxLength={300} defaultValue={item?.legal_basis ?? ""} />}</Field>
  </>;
}
