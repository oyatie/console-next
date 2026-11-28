// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t, type MessageId } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { authzQuery } from "../../../reference/authz/api";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { FormPattern } from "../../../ui/patterns/form";
import { Receipt } from "../../../ui/receipt/receipt";
import { actions, catalogPaths, saveCatalog, type CatalogAction } from "../api";
import { catalogCommand, initial, type Draft } from "../domain/catalog-draft";
import { ReferenceField, type ReferenceKind } from "./reference-field";
import { BranchField } from "./scope";
import { useCatalogScope } from "./use-catalog-scope";
import { complianceCode, controlTypes, coverage, frameworkKinds, obligationTypes, relationships, risk } from "../present";

export function ComplianceCatalogForm() {
  const authz = useQuery(authzQuery);
  const manage = useCatalogScope("manage");
  const read = authz.data?.capabilities.find(cap => cap.feature === "served_compliance_catalog" && cap.permission !== "request_only");
  const readOrg = !!read?.org_wide && authz.data?.branch_scope.kind === "all";
  const [action, setAction] = useState<CatalogAction>("framework");
  const [draft, setDraft] = useState(initial);
  const [scope, setScope] = useState("");
  const branch = manage.ids.includes(scope) ? scope : !manage.orgWide && manage.ids.length === 1 ? manage.ids[0] ?? "" : "";
  const [saved, setSaved] = useState(false);
  const command = useCommand({ run: saveCatalog, invalidates: catalogPaths, onSuccess: () => setSaved(true) });
  const disabled = command.isPending;
  const mode = manage.orgWide ? action : "obligation";
  const update = (patch: Partial<Draft>) => { command.reset(); setDraft(d => ({ ...d, ...patch })); };
  const body = catalogCommand(mode, draft, manage.orgWide, branch);
  const reference = (kind: ReferenceKind) => <ReferenceField key={kind === "control" ? draft.framework : kind} kind={kind}
    canRead={readOrg} value={draft[kind]} framework={draft.framework} disabled={disabled}
    onChange={v => update(kind === "framework" ? { framework: v, control: "" } : { [kind]: v })} />;
  const field = (key: "name" | "detail" | "version" | "jurisdiction" | "citation" | "area" | "controlKey" | "site", label: MessageId, required = true) =>
    <Field label={t(label)} required={required}>{p => <TextInput {...p} disabled={disabled} value={draft[key]} onChange={e => update({ [key]: e.target.value })} />}</Field>;
  const choices = <K extends "frameworkKind" | "controlType" | "obligationType" | "risk" | "relationship" | "coverage">(key: K, values: readonly Draft[K][]) =>
    <Field label={t(`compliance.${key}`)} required>{p => <SelectInput {...p} value={draft[key]} disabled={disabled} onChange={e => {
      const value = values.find(v => v === e.target.value); if (value) update({ [key]: value });
    }}>{values.map(v => <option key={v} value={v}>{complianceCode(v)}</option>)}</SelectInput>}</Field>;
  const dated = mode === "regulation" || mode === "framework" || mode === "obligation";
  const back = read ? { to: "/compliance" as const, label: t("compliance.title") } : undefined;
  return <FormPattern q={authz} head={{ title: t("compliance.create"), titleId: "compliance-catalog-command" }} back={back}
    sections={saved ? <Receipt state="recorded" message={t("compliance.saved", { action: t(`compliance.action.${mode}`) })} /> : <>
      {manage.orgWide && <Field label={t("compliance.action")} required>{p => <SelectInput {...p} value={action} disabled={disabled} onChange={e => {
        const next = actions.find(a => a === e.target.value); if (next) { command.reset(); setDraft(initial); setAction(next); }
      }}>{actions.map(a => <option key={a} value={a}>{t(`compliance.action.${a}`)}</option>)}</SelectInput>}</Field>}
      {mode === "obligation" && <BranchField scope={manage} value={branch} all={manage.orgWide} disabled={disabled} onChange={v => { update({ site: "" }); setScope(v); }} />}
      {mode === "obligation" && branch && field("site", "compliance.site", false)}
      {(mode === "control" || mode === "coverage" && readOrg) && reference("framework")}
      {mode === "coverage" && reference("control")}
      {(mode === "coverage" || mode === "regulationLink") && reference("obligation")}
      {mode === "regulationLink" && reference("regulation")}
      {(dated || mode === "control") && field("name", "compliance.name")}
      {mode === "framework" && <>{field("version", "compliance.version")}{choices("frameworkKind", frameworkKinds)}</>}
      {mode === "regulation" && <>{field("jurisdiction", "compliance.jurisdiction")}{field("citation", "compliance.citation")}
        {field("area", "compliance.area")}{field("detail", "compliance.impact")}{choices("risk", risk)}</>}
      {mode === "obligation" && <>{field("detail", "compliance.detail")}{choices("obligationType", obligationTypes)}{choices("risk", risk)}</>}
      {mode === "control" && <>{field("controlKey", "compliance.controlKey")}{field("detail", "compliance.objective")}{choices("controlType", controlTypes)}</>}
      {mode === "regulationLink" && <>{choices("relationship", relationships)}{field("detail", "compliance.rationale", false)}</>}
      {mode === "coverage" && <>{choices("coverage", coverage)}{field("detail", "compliance.rationale", false)}</>}
      {dated && <><DateField required={false} label={t("compliance.from")} today={todayKst()} value={draft.from} disabled={disabled} onChange={from => update({ from })} />
        <DateField required={false} label={t("compliance.to")} today={todayKst()} value={draft.to} disabled={disabled} onChange={to => update({ to })} /></>}
    </>} notice={<CommandError error={command.error} />}
    actions={saved ? <>{read && <Link to="/compliance">{t("compliance.title")}</Link>}
      <Button onClick={() => { command.reset(); setDraft(initial); setSaved(false); }}>{t("compliance.another")}</Button></> :
      <Button type="submit" variant="primary" disabled={!body || disabled}>{t("compliance.save")}</Button>}
    onSubmit={() => { if (body && !saved && !disabled) command.mutate(body); }} />;
}
