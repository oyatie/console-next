// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Composer } from "../../../ui/composer/composer";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { DateInput } from "../../../ui/date/date-input";
import { recordContractWage, payGroupSchemas, type ContractWage } from "../api";
const rules = payGroupSchemas.ContractWage.properties;
export function ContractWageForm({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const formId = useId();
  const [effective, setEffective] = useState("");
  const [kind, setKind] = useState<ContractWage["wage_kind"] | "">("");
  const [amount, setAmount] = useState("");
  const [hours, setHours] = useState("");
  const [source, setSource] = useState("");
  const save = useCommand({ run: recordContractWage, invalidates: ["/api/v1/payroll/employees"], settle: true, announce: () => t("payroll.employee.saved") });
  return <Composer formId={formId} layout="inline" title={t("payroll.employee.record")} action={{ kind: "contractWage", mode: "save" }} onClose={onClose} pending={save.isPending} consequence={t("payroll.employee.appendOnly")}
    notice={<><CommandError error={save.error} />{save.isSuccess && <p role="status">{t("payroll.employee.saved")}</p>}</>}
    onSubmit={() => {
    if (!(document.getElementById(formId) as HTMLFormElement).reportValidity() || !kind || !effective || !source.trim() || !Number.isSafeInteger(Number(amount)) || !Number.isSafeInteger(Number(hours))) return false;
    save.mutate({ employeeId, body: { effective_from: effective, wage_kind: kind, amount_won: Number(amount), monthly_standard_hours: Number(hours), source_note: source.trim() } });
  }}>
    <Field label={t("payroll.employee.effective")} required>{control => <DateInput {...control} value={effective} onChange={setEffective} />}</Field>
    <Field label={t("payroll.employee.kind")} required>{control => <SelectInput {...control} value={kind} onChange={event => setKind(event.target.value as ContractWage["wage_kind"])}><option value="" disabled>{t("payroll.setup.choose")}</option>{rules.wage_kind.enum.map(value => <option key={value} value={value}>{t(`payroll.rule.${value}`)}</option>)}</SelectInput>}</Field>
    <Field label={t("payroll.employee.amount")} required>{control => <TextInput {...control} type="number" min={rules.amount_won.minimum} max={Number.MAX_SAFE_INTEGER} step={1} value={amount} onChange={event => setAmount(event.target.value)} />}</Field>
    <Field label={t("payroll.employee.hours")} required>{control => <TextInput {...control} type="number" min={rules.monthly_standard_hours.minimum} max={rules.monthly_standard_hours.maximum} step={1} value={hours} onChange={event => setHours(event.target.value)} />}</Field>
    <Field label={t("payroll.employee.source")} required>{control => <TextInput {...control} maxLength={rules.source_note.maxLength} pattern={".*\\S.*"} value={source} onChange={event => setSource(event.target.value)} />}</Field>
  </Composer>;
}
