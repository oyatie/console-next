// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Network } from "lucide-react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { Composer } from "../../../ui/composer/composer";
import { Field, TextInput } from "../../../ui/field/field";
import { Muted } from "../../../ui/muted/muted";
import { depts, unitIdOf, type Place } from "../../../reference/org/domain/structure";
import { createGovOp } from "../domain/structure-plans";
import { GovernFields } from "./govern-fields";
import { useGovern, useGovernSubmit } from "./use-govern";
import css from "../../../reference/org/ui/structure.module.css";

const fold = (s: string) => s.normalize("NFC").trim();

/** Department naming uses one form; creation and renaming keep their own operation and sibling validation. */
export function DeptNameComposer({ mode, place, onClose }: { mode: "create" | "rename"; place: Place; onClose: () => void }) {
  const d = place.node;
  const creating = mode === "create";
  const parent = creating ? d : place.parent!;
  const [name, setName] = useState(creating ? "" : d.name);
  const gov = useGovern();
  const value = fold(name);
  const taken = value !== "" && depts(parent).some((c) => (creating || c.id !== d.id) && fold(c.name) === value);
  const missing = [
    (!value || (!creating && value === fold(d.name))) && t(creating ? "orgUnit.gov.missingName" : "orgUnit.rename.missingName"),
    taken && t("orgUnit.add.taken", { parent: parent.name }),
    ...gov.missing,
  ].filter((x): x is string => Boolean(x));
  const submit = useGovernSubmit(() => creating ? {
    kind: "NEW", target: { kind: "ORG_UNIT", ref: unitIdOf(d), label: value }, title: t("orgChange.title.create", { name: value }), proposal: [createGovOp(d, name)],
  } : {
    kind: "REORG", target: { kind: "ORG_UNIT", ref: d.id, label: t("orgChange.title.rename", { from: d.name, to: value }) }, proposal: [{ op: "RENAME_ORG_UNIT", orgUnitId: d.id, name: value }],
  }, gov);
  return <Composer
    wide={creating}
    kicker={<><Network size={14} aria-hidden />{creating ? t("orgUnit.gov.addKicker", { path: [place.workplace?.name, d.kind === "WORKPLACE" ? undefined : d.name].filter(Boolean).join(" › ") }) : [...place.path, d.name].join(" › ")}</>}
    title={creating ? t("orgUnit.gov.addTitle") : t("orgUnit.rename.titleGoverned", { name: d.name })}
    onClose={onClose}
    pending={submit.isPending}
    action={{ kind: creating ? "orgCreate" : "orgRename", mode: gov.routed ? "request" : gov.mode === "schedule" ? "schedule" : "apply", count: 1 }}
    blocked={missing.length ? { reason: t("orgUnit.gov.missing", { list: missing.join(", ") }) } : undefined}
    onSaveDraft={missing.length === 0 ? () => submit.mutate(false) : undefined}
    onSubmit={() => { if (missing.length === 0) submit.mutate(true); }}
    notice={<CommandError error={submit.error} />}
    sections={{ approvals: gov.routed ? t("orgPropose.route") : null }}
    consequence={missing.length ? null : <>
      <span>{creating ? t("orgUnit.gov.addConsequence", { name: value, date: gov.g.date }) : t("orgUnit.rename.consequence", { from: d.name, name: value, date: gov.g.date })}</span>
      {creating && <Muted>{t("orgUnit.gov.setupWouldApply")}</Muted>}
    </>}
  >
    <Field label={t(creating ? "orgUnit.gov.name" : "orgUnit.rename.newName")} required error={taken ? t("orgUnit.add.taken", { parent: parent.name }) : undefined}>
      {(p) => <TextInput {...p} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
    </Field>
    <GovernFields s={gov} />
    {creating && <p className={css.note}>{t("orgUnit.governed.membersLater")}</p>}
  </Composer>;
}
