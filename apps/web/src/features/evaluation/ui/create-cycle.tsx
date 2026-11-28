// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { authzQuery } from "../../../reference/authz/api";
import { canUseServed } from "../../../reference/authz/ui/use-documents-served";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { FormPattern } from "../../../ui/patterns/form";
import { Receipt } from "../../../ui/receipt/receipt";
import { createCycle, type CreateCycle } from "../api";

const initial: CreateCycle = { name: "", kind: "REGULAR", period_label: "", due_date: "" };

export function CreateEvaluationCycle() {
  const authz = useQuery(authzQuery);
  const canRead = canUseServed("served_evaluation_cycles", authz.data?.capabilities);
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState<string>();
  const command = useCommand({ run: createCycle, invalidates: ["/api/v1/evaluation/cycles"],
    onSuccess: (_, sent) => setSaved(sent.name) });
  const update = (patch: Partial<CreateCycle>) => { command.reset(); setDraft(old => ({ ...old, ...patch })); };
  const body = { ...draft, name: draft.name.trim(), period_label: draft.period_label.trim() };
  const complete = Boolean(body.name && body.period_label && body.due_date);
  const back = canRead ? { to: "/evaluation" as const, label: t("evaluation.title") } : undefined;
  return <FormPattern q={authz} head={{ title: t("evaluation.create"), titleId: "new-evaluation-cycle-title" }} back={back}
    sections={saved ? <Receipt state="recorded" message={t("evaluation.created", { name: saved })} /> : <>
      <Field label={t("evaluation.name")} required>{p => <TextInput {...p} maxLength={120} value={draft.name}
        disabled={command.isPending} onChange={e => update({ name: e.target.value })} />}</Field>
      <Field label={t("evaluation.kind")} required>{p => <SelectInput {...p} value={draft.kind} disabled={command.isPending}
        onChange={e => update({ kind: e.target.value === "PROBATION" ? "PROBATION" : "REGULAR" })}>
        <option value="REGULAR">{t("evaluation.kind.REGULAR")}</option><option value="PROBATION">{t("evaluation.kind.PROBATION")}</option>
      </SelectInput>}</Field>
      <Field label={t("evaluation.period")} required>{p => <TextInput {...p} maxLength={60} value={draft.period_label}
        disabled={command.isPending} onChange={e => update({ period_label: e.target.value })} />}</Field>
      <DateField label={t("me.evaluation.due")} required today={todayKst()} value={draft.due_date} disabled={command.isPending}
        onChange={due_date => update({ due_date })} />
    </>}
    notice={<CommandError error={command.error} />}
    actions={saved ? <>
      {canRead && <Link to="/evaluation">{t("evaluation.title")}</Link>}
      <Button onClick={() => { command.reset(); setSaved(undefined); setDraft(initial); }}>{t("evaluation.another")}</Button>
    </> : <Button type="submit" variant="primary" disabled={!complete || command.isPending}>{t("evaluation.save")}</Button>}
    onSubmit={() => { if (complete && !saved && !command.isPending) command.mutate(body); }} />;
}
