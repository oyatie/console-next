// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { TextArea } from "../../../ui/field/text-area";
import { Composer } from "../../../ui/composer/composer";
import { choices, engagements, saveChange, type Change, type Engagement } from "../api";
import { OptionField } from "./option-field";

import { stages, type Next } from "../workflow";

export function EngagementChange({ row, kind, onClose }: { row: Engagement; kind: Change["kind"]; onClose: () => void }) {
  const [description, describe] = useState("");
  const [title, setTitle] = useState("");
  const [parent, select] = useState("");
  const [document, setDoc] = useState("");
  const [evidence, setEvidence] = useState("");
  const [kpi, setKpi] = useState("");
  const [approval, setApproval] = useState("");
  const [time, setTime] = useState("");
  const [direction, setDirection] = useState<"INCREASE" | "DECREASE">("INCREASE");
  const next = stages(row);
  const [to, setTo] = useState<Next | undefined>(next.length === 1 ? next[0] : undefined);
  // Keep the version reviewed when the editor opened across background refetches.
  const [expectedVersion] = useState(row.version);
  const command = useCommand({ run: (change: Change, key: string) => saveChange(row.id, change, key),
    invalidates: [engagements, choices], settle: true, announce: () => t("consulting.saved"), onSuccess: onClose });
  let change: Change | undefined;
  const note = description.trim();
  const textLabel = { diagnostic: "summary", finding: "statement", initiative: "hypothesis", observation: "note", transition: "reason" } as const;
  const parentRows = kind === "observation" ? row.initiatives.map(r => ({ id: r.id, label: r.title }))
    : kind === "initiative" ? row.findings.map(r => ({ id: r.id, label: r.statement }))
    : row.diagnostics.map(r => ({ id: r.id, label: r.summary }));
  const selected = parentRows.some(r => r.id === parent);
  if (note) {
    switch (kind) {
      case "diagnostic": change = { kind, body: { summary: note, documentId: document || undefined } }; break;
      case "finding": if (selected && evidence) change = { kind, body: { statement: note, diagnosticId: parent, evidenceId: evidence, documentId: document || undefined } }; break;
      case "initiative": if (selected && kpi && title.trim()) change = { kind, body: { findingId: parent, hypothesis: note, title: title.trim(), kpiDefinitionId: kpi, targetDirection: direction } }; break;
      case "observation": {
        const initiative = row.initiatives.find(r => r.id === parent);
        const observed = Date.parse(`${time}+09:00`);
        if (initiative && evidence && Number.isFinite(observed)) change = { kind, body: { initiativeId: parent, kpiDefinitionId: initiative.kpi_definition_id, evidenceId: evidence, observedAt: new Date(observed).toISOString(), note } };
        break;
      }
      case "transition": if (to && next.includes(to) && (to !== "APPROVED" || approval)) change = { kind, body: { expectedVersion, reason: note, toStatus: to, approvalId: to === "APPROVED" ? approval : undefined } }; break;
    }
  }
  return <Composer open title={t(`consulting.${kind}`)} action={{kind: "consultingEngagement", mode: kind === "transition" ? "change" : "record"}}
    onClose={onClose} pending={command.isPending} consequence={row.title} error={command.error}
    notice={<CommandError error={command.error} />} incomplete={!change} onSubmit={() => {
      if (!change || command.isPending) return false;
      command.mutate(change);
    }}>
    {(kind === "initiative" || kind === "finding" || kind === "observation") && <Field required
      label={t(`consulting.${kind === "initiative" ? "finding" : kind === "finding" ? "diagnostic" : "initiative"}`)}>{p =>
      <SelectInput {...p} value={parent} onChange={e => select(e.target.value)}><option value="">{t("consulting.choose")}</option>
        {parentRows.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</SelectInput>}</Field>}
    {kind === "initiative" && <Field label={t("consulting.initiativeName")} required>{p =>
      <TextInput {...p} value={title} onChange={e => setTitle(e.target.value)} />}</Field>}
    {kind === "transition" && <Field label={t("consulting.nextStage")} required>{p => <SelectInput {...p} value={to ?? ""}
      onChange={e => setTo(next.find(stage => stage === e.target.value))}><option value="">{t("consulting.choose")}</option>
      {next.map(stage => <option key={stage} value={stage}>{t(`consulting.stage.${stage}`)}</option>)}</SelectInput>}</Field>}
    <Field label={t(`consulting.${textLabel[kind]}`)} required>{p =>
      <TextArea {...p} value={description} onChange={e => describe(e.target.value)} />}</Field>
    {(kind === "diagnostic" || kind === "finding") && <OptionField kind="DOCUMENT" label={t("consulting.document")} required={false} value={document} onChange={setDoc} />}
    {(kind === "finding" || kind === "observation") && <OptionField kind="EVIDENCE" label={t("consulting.evidence")} required value={evidence} onChange={setEvidence} />}
    {kind === "initiative" && <>
      <OptionField kind="KPI_DEFINITION" label={t("consulting.kpi")} required value={kpi} onChange={setKpi} />
      <Field label={t("consulting.direction")} required>{p => <SelectInput {...p} value={direction} onChange={e => setDirection(e.target.value === "DECREASE" ? "DECREASE" : "INCREASE")}>
        <option value="INCREASE">{t("consulting.INCREASE")}</option><option value="DECREASE">{t("consulting.DECREASE")}</option></SelectInput>}</Field></>}
    {kind === "observation" && <Field label={t("consulting.observed")} required>{p =>
      <TextInput {...p} type="datetime-local" value={time} onChange={e => setTime(e.target.value)} />}</Field>}
    {kind === "transition" && to === "APPROVED" && <OptionField kind="APPROVAL" engagement={row.id} label={t("consulting.approval")} required value={approval} onChange={setApproval} />}
  </Composer>;
}
