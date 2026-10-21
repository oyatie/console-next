import { useState } from "react";
import { Lock, Network } from "lucide-react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { depts, type Place } from "../../../reference/org/domain/structure";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { GovernFields } from "./govern-fields";
import { useGovern, useGovernSubmit } from "./use-govern";
import css from "../../../reference/org/ui/structure.module.css";

const fold = (s: string) => s.normalize("NFC").trim();

/**
 * Renaming a department after go-live (D12): the same action opens a proposal — the new name (checked against open
 * siblings as typed, I-5), effective date with no default, reason and the route. Its people keep their placement.
 */
export function DeptRenameGovernedSheet({ place, onClose }: { place: Place; onClose: () => void }) {
  const d = place.node;
  const [name, setName] = useState(d.name);
  const gov = useGovern();
  const taken = depts(place.parent!).some((c) => c.id !== d.id && fold(c.name) === fold(name));
  const same = fold(name) === fold(d.name);
  const submit = useGovernSubmit(() => ({ kind: "REORG", target: { kind: "ORG_UNIT", ref: d.id, label: t("orgChange.title.rename", { from: d.name, to: fold(name) }) }, proposal: [{ op: "RENAME_ORG_UNIT", orgUnitId: d.id, name: fold(name) }] }), gov);
  const missing = [(!fold(name) || same) && t("orgUnit.rename.missingName"), taken && t("orgUnit.add.taken", { parent: place.parent!.name }), ...gov.missing].filter((x): x is string => Boolean(x));
  const reasonId = "dept-rename-reason";
  return (
    <Sheet
      open
      kicker={<><Network size={14} aria-hidden />{[...place.path, d.name].join(" › ")}</>}
      title={t("orgUnit.rename.titleGoverned", { name: d.name })}
      onClose={onClose}
      pending={submit.isPending}
      notice={<CommandError error={submit.error} />}
      consequence={
        missing.length ? (
          <span id={reasonId} className={css.footReason}><Lock size={14} aria-hidden />{t("orgUnit.gov.missing", { list: missing.join(", ") })}</span>
        ) : (
          <span>{t("orgUnit.rename.consequence", { from: d.name, name: fold(name), date: gov.g.date })}</span>
        )
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {missing.length === 0 && <Button onClick={() => submit.mutate(false)}>{t("orgUnit.gov.saveDraft")}</Button>}
          {missing.length === 0 ? (
            <Button variant="primary" onClick={() => submit.mutate(true)}>{gov.words.submit(1)}</Button>
          ) : (
            <Button variant="primary" aria-disabled aria-describedby={reasonId}>{gov.words.submit(1)}</Button>
          )}
        </>
      }
    >
      <Field
        label={t("orgUnit.rename.newName")}
        required
        error={taken ? t("orgUnit.add.taken", { parent: place.parent!.name }) : undefined}
      >
        {(p) => <TextInput {...p} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <GovernFields s={gov} />
    </Sheet>
  );
}
