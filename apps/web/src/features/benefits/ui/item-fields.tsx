// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { branchesQuery } from "../../../reference/org/api";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button-base";
import { type Change, type Create, type Item } from "../api";
import { changedAttributes } from "../domain/attributes";
import { DateField } from "../../../ui/date/date-field";
import { todayKst } from "../../../lib/pure/today";
import { Form } from "../../../ui/button/button";
import { ItemAttributes } from "./item-attributes";
import { BenefitSelect, BenefitText } from "./benefit-fields";
import s from "./benefits.module.css";

export type Scope = { org_wide: boolean; branch_scope: { kind: "all" | "branches"; branches?: string[] } };

export function ItemFields({ item, scope, busy, submit }: { item?: Item; scope: Scope; busy: boolean; submit: (change: Change) => void }) {
  const [name, setName] = useState(item?.name ?? "");
  const [category, setCategory] = useState<Create["category"] | "">(item?.category ?? "");
  const [coverage, setCoverage] = useState(item?.coverage_label ?? "");
  const [cost, setCost] = useState(item?.cost_label ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [start, setStart] = useState(item?.effective_on ?? "");
  const [end, setEnd] = useState(item?.retires_on ?? "");
  const [badStart, setBadStart] = useState(false);
  const [badEnd, setBadEnd] = useState(false);
  const invalidDates = badStart || badEnd || !!(start && end && end < start);
  const [branch, setBranch] = useState("");
  const branches = useQuery({ ...branchesQuery, enabled: !item });
  const targets = (branches.data ?? []).filter(row => !row.deactivated_at && (scope.branch_scope.kind === "all" || scope.branch_scope.branches?.includes(row.id)));
  const options = [...(scope.org_wide ? [{ value: "org", label: t("benefits.org") }] : []), ...targets.map(row => ({ value: row.id, label: row.name }))];
  const [attributes, changeAttributes] = useState<ReturnType<typeof changedAttributes>>({});
  function save() {
    if (invalidDates || !category || !name.trim() || !coverage.trim() || !cost.trim()) return;
    const fields = { ...attributes,
      ...(start !== (item?.effective_on ?? "") && { effectiveOn: start || null }),
      ...(end !== (item?.retires_on ?? "") && { retiresOn: end || null }),
      name: name.trim(), category, coverageLabel: coverage.trim(), costLabel: cost.trim(), note: note.trim() || null };
    if (item) submit({ kind: "edit", id: item.id, body: { ...fields, expectedUpdatedAt: item.updated_at } });
    else if (options.some(option => option.value === branch)) submit({ kind: "create", body: { ...fields, displayOrder: 0,
      scope: branch === "org" ? { scope_type: "ORG" } : { scope_type: "BRANCH", branch_id: branch } } });
  }
  const scopeField = <BenefitSelect label="benefits.scope" value={branch} set={setBranch} options={options} />;
  const disabled = busy || invalidDates || !category || !name.trim() || !coverage.trim() || !cost.trim() || (!item && !options.some(option => option.value === branch));
  return <Form onSubmit={save} onChangeCapture={event => changeAttributes(changedAttributes(new FormData(event.currentTarget), item))} className={s.form}>
    <BenefitText label="benefits.name" required maxLength={120} value={name} set={setName} />
    <BenefitSelect label="benefits.category" value={category} set={v => setCategory(v === "legal" || v === "extra" ? v : "")}
      options={[{ value: "legal", label: t("benefits.legal") }, { value: "extra", label: t("benefits.extra") }]} />
    {!item && (scope.org_wide ? scopeField : <QueryState q={branches}>{() => scopeField}</QueryState>)}
    <BenefitText label="benefits.coverage" required maxLength={80} value={coverage} set={setCoverage} />
    <BenefitText label="benefits.cost" required maxLength={80} value={cost} set={setCost} />
    <ItemAttributes item={item} />
    <DateField label={t("benefits.effective")} required={false} value={start} onChange={setStart} onInvalid={setBadStart} today={todayKst()} max={end || undefined} />
    <DateField label={t("benefits.retires")} required={false} value={end} onChange={setEnd} onInvalid={setBadEnd} today={todayKst()} min={start || undefined} />
    <BenefitText label="benefits.note" maxLength={500} value={note} set={setNote} />
    <Button type="submit" disabled={disabled}>{t("benefits.save")}</Button>
  </Form>;
}
