// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { authzQuery } from "../../../reference/authz/api";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { FormPattern } from "../../../ui/patterns/form";
import { Receipt } from "../../../ui/receipt/receipt";
import { applyEvidence, confidences, evidencePath, evLabel, targetTypes } from "../api/evidence";
import { ReferenceField } from "./reference-field";

export function EvidenceProposal() {
  const authz = useQuery(authzQuery);
  const [framework, setFramework] = useState("");
  const [control, setControl] = useState("");
  const [obligation, setObligation] = useState("");
  const [target, setTarget] = useState("");
  const [type, setType] = useState<typeof targetTypes[number]>("external_document");
  const [confidence, setConfidence] = useState<typeof confidences[number]>("MEDIUM");
  const [source, setSource] = useState("");
  const [digest, setDigest] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [saved, setSaved] = useState(false);
  const command = useCommand({ run: applyEvidence, invalidates: [evidencePath], onSuccess: () => setSaved(true) });
  const pending = command.isPending;
  const valid = !!control && !!target.trim() && (!source || /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(source))
    && (!digest || /^[\da-f]{64}$/i.test(digest)) && (!from || !to || from <= to);
  const back = { to: "/compliance/evidence" as const, label: t("compliance.evidence") };
  return <FormPattern q={authz} head={{ title: t("compliance.propose"), titleId: "propose-evidence-binding" }} back={back}
    sections={saved ? <Receipt state="recorded" message={t("compliance.proposed")} /> : <>
      <ReferenceField kind="framework" canRead value={framework} onChange={id => { setFramework(id); setControl(""); }} disabled={pending} />
      <ReferenceField key={framework} kind="control" canRead framework={framework} value={control} onChange={setControl} disabled={pending} />
      <ReferenceField kind="obligation" canRead optional value={obligation} onChange={setObligation} disabled={pending} />
      <Field label={t("compliance.targetKind")} required>{p => <SelectInput {...p} value={type} disabled={pending} onChange={e => {
        const next = targetTypes.find(v => v === e.target.value); if (next) setType(next);
      }}>{targetTypes.map(v => <option key={v} value={v}>{evLabel(v)}</option>)}</SelectInput>}</Field>
      <Field label={t("compliance.targetId")} required>{p => <TextInput {...p} value={target} maxLength={200} disabled={pending} onChange={e => setTarget(e.target.value)} />}</Field>
      <Field label={t("compliance.confidence")} required>{p => <SelectInput {...p} value={confidence} disabled={pending} onChange={e => {
        const next = confidences.find(v => v === e.target.value); if (next) setConfidence(next);
      }}>{confidences.map(v => <option key={v} value={v}>{evLabel(v)}</option>)}</SelectInput>}</Field>
      <Field label={t("compliance.auditId")} required={false}>{p => <TextInput {...p} value={source} disabled={pending} onChange={e => setSource(e.target.value.trim())} />}</Field>
      <Field label={t("compliance.digest")} required={false}>{p => <TextInput {...p} value={digest} maxLength={64} disabled={pending} onChange={e => setDigest(e.target.value.trim())} />}</Field>
      <DateField label={t("compliance.validFrom")} required={false} today={todayKst()} value={from} onChange={setFrom} disabled={pending} />
      <DateField label={t("compliance.validTo")} required={false} today={todayKst()} value={to} onChange={setTo} disabled={pending} />
    </>} notice={<CommandError error={command.error} />}
    actions={saved ? <Link to="/compliance/evidence">{back.label}</Link> :
      <Button type="submit" variant="primary" disabled={!valid || pending}>{t("compliance.propose")}</Button>}
    onSubmit={() => {
      if (valid && !saved && !pending) command.mutate({ propose: { control_id: control, obligation_id: obligation || null,
        evidence_target_type: type, evidence_target_id: target.trim(), confidence, source_audit_event_id: source || null,
        hash_sha256: digest || null, valid_from: from || null, valid_to: to || null } });
    }} />;
}
