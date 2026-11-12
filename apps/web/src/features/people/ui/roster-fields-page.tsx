// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Page } from "../../../ui/page/page";
import { Card } from "../../../ui/card/card";
import { Button, Form } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Table, type Column } from "../../../ui/table";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { addRosterField, rosterFieldsQuery, updateRosterField, type RosterField, type RosterFieldInput } from "../api";

const READS = ["/api/v1/roster-fields"] as const;
const TYPES = ["TEXT", "INTEGER", "DECIMAL", "DATE", "CHOICE"] as const;
const SECTIONS = ["PERSONAL", "JOB"] as const;
const LABEL_MAX = 60;
const lines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

/**
 * The fields a company adds to its personnel card: each has a name, a value type, the card section it shows in and,
 * for a choice, its options. A field is retired rather than deleted so the values already kept stay readable. Who may
 * change the list is the server's verdict (`can_manage`).
 */
export function RosterFieldsPage() {
  const fields = useQuery(rosterFieldsQuery);
  // Who may change the list is the server's verdict on this user.
  const manage = fields.data?.can_manage === true;
  const columns: Column<RosterField>[] = [
    { header: t("rosterFields.col.label"), cell: x => x.label, card: "title", width: "summary" },
    { header: t("rosterFields.col.type"), cell: x => t(`rosterFields.type.${x.value_type as typeof TYPES[number]}`), card: "fact", width: "status" },
    { header: t("rosterFields.col.section"), cell: x => t(`rosterFields.section.${x.section as typeof SECTIONS[number]}`), width: "status" },
    { header: t("rosterFields.col.choices"), cell: x => x.choices.map(c => c.label).join(" · "), width: "summary" },
    { header: t("rosterFields.col.state"), cell: x => t(x.active ? "rosterFields.active" : "rosterFields.retired"), width: "status" },
    ...(manage ? [{ header: t("rosterFields.col.actions"), cell: (x: RosterField) => <Actions x={x} />, card: "action" as const }] : []),
  ];
  return <Page floorplan="P-05" head={{ title: t("rosterFields.title"), tools: <Link to="/people" search={{}}>{t("people.title")}</Link> }} q={fields}>
    {data => <>
      {manage ? <AddField /> : <p role="status">{t("rosterFields.denied")}</p>}
      <Card title={t("rosterFields.list")}>
        {data.items.length ? <Table mobileLayout="cards" label={t("rosterFields.list")} rows={data.items} rowId={x => x.id} columns={columns} /> : <EmptyState title={t("rosterFields.none.title")} reason={t(manage ? "rosterFields.none.manage" : "rosterFields.none.read")} />}
      </Card>
    </>}
  </Page>;
}

function AddField() {
  const [label, setLabel] = useState("");
  const [type, setType] = useState<RosterFieldInput["value_type"] | null>(null);
  const [section, setSection] = useState<RosterFieldInput["section"] | null>(null);
  const [choices, setChoices] = useState("");
  const [tried, setTried] = useState(false);
  const choice = type === "CHOICE";
  const run = useCommand({
    run: () => addRosterField({ label: label.trim(), value_type: type!, section: section!, ...(choice ? { choices: lines(choices).map(l => ({ label: l })) } : {}) }),
    invalidates: READS,
    onSuccess: () => (setLabel(""), setChoices(""), setTried(false)),
  });
  const missing = !label.trim() || !type || !section || (choice && !lines(choices).length);
  return <>
    {run.isSuccess && <p role="status">{t("rosterFields.added", { label: run.data.label })}</p>}
    <Card title={t("rosterFields.add")} titleId="roster-fields-add"><Form className="form" aria-labelledby="roster-fields-add" noValidate onSubmit={() => { setTried(true); if (!missing) run.mutate(undefined); }}>
      <Field label={t("rosterFields.col.label")} required error={tried && !label.trim() ? t("rosterFields.label.missing") : undefined}>
        {p => <TextInput {...p} value={label} maxLength={LABEL_MAX} onChange={e => (run.reset(), setLabel(e.target.value))} />}
      </Field>
      <ChoiceField label={t("rosterFields.col.type")} required options={TYPES.map(v => ({ value: v, label: t(`rosterFields.type.${v}`) }))} value={type} onChange={v => (run.reset(), setType(v))} error={tried && !type ? t("rosterFields.type.missing") : undefined} />
      <ChoiceField label={t("rosterFields.col.section")} required options={SECTIONS.map(v => ({ value: v, label: t(`rosterFields.section.${v}`) }))} value={section} onChange={v => (run.reset(), setSection(v))} error={tried && !section ? t("rosterFields.section.missing") : undefined} />
      {choice && <Field label={t("rosterFields.choices")} required error={tried && !lines(choices).length ? t("rosterFields.choices.missing") : undefined}>
        {p => <TextArea {...p} rows={4} value={choices} onChange={e => setChoices(e.target.value)} />}
      </Field>}
      <CommandError error={run.error} />
      <div className="form__actions"><Button type="submit" variant="primary" aria-disabled={run.isPending || undefined}>{t("rosterFields.add.commit")}</Button></div>
    </Form></Card>
  </>;
}

/** Rename, add options (existing ones are never removed), or retire and restore. */
function Actions({ x }: { x: RosterField }) {
  const [edit, setEdit] = useState(false);
  const toggle = useCommand({ run: () => updateRosterField(x.id, { active: !x.active }), invalidates: READS });
  return <>
    <Button variant="ghost" onClick={() => setEdit(true)}>{t("rosterFields.edit", { label: x.label })}</Button>
    {edit && <Edit x={x} onClose={() => setEdit(false)} />}
    <Button variant="ghost" onClick={() => toggle.mutate(undefined)} aria-disabled={toggle.isPending || undefined}>{t(x.active ? "rosterFields.retire" : "rosterFields.restore", { label: x.label })}</Button>
    <CommandError error={toggle.error} />
  </>;
}

function Edit({ x, onClose }: { x: RosterField; onClose: () => void }) {
  const [label, setLabel] = useState(x.label);
  const [more, setMore] = useState("");
  const [tried, setTried] = useState(false);
  const run = useCommand({
    run: () => updateRosterField(x.id, {
      ...(label.trim() !== x.label ? { label: label.trim() } : {}),
      ...(lines(more).length ? { choices: [...x.choices, ...lines(more).map(l => ({ label: l }))] } : {}),
    }),
    invalidates: READS, settle: true, onSuccess: onClose,
  });
  return <Form aria-label={t("rosterFields.edit.title", { label: x.label })} noValidate onSubmit={() => { setTried(true); if (label.trim()) run.mutate(undefined); }}>
    <Field label={t("rosterFields.col.label")} required error={tried && !label.trim() ? t("rosterFields.label.missing") : undefined}>
      {p => <TextInput {...p} value={label} maxLength={LABEL_MAX} onChange={e => setLabel(e.target.value)} />}
    </Field>
    {x.value_type === "CHOICE" && <Field label={t("rosterFields.choices.more")} required={false}>
      {p => <TextArea {...p} rows={3} value={more} onChange={e => setMore(e.target.value)} />}
    </Field>}
    <CommandError error={run.error} />
    <Button variant="ghost" onClick={onClose}>{t("composer.dismiss")}</Button>
    <Button type="submit" variant="primary" aria-disabled={run.isPending || undefined}>{t("rosterFields.edit.commit")}</Button>
  </Form>;
}
