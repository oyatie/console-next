import { useState } from "react";
import { Lock, Network } from "lucide-react";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Field, TextInput } from "../../../ui/field/field";
import { Sheet } from "../../../ui/sheet/sheet";
import { createGovOp } from "../domain/structure-plans";
import { depts, unitIdOf, type Place } from "../../../reference/org/domain/structure";
import { GovernFields } from "./govern-fields";
import { useGovern, useGovernSubmit } from "./use-govern";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

const fold = (s: string) => s.normalize("NFC").trim();

/**
 * new-department proposal after go-live (S6-add-governed): the same "+ department" opens a proposal — name (checked against open
 * siblings as typed, I-5), effective date with no default, reason and the route. It shows on the chart as "planned" once approved.
 * Moving people into it on the same effective date needs per-person placement inside a proposal (not served yet).
 */
export function DeptAddGovernedSheet({ place, onClose }: { place: Place; onClose: () => void }) {
  const parent = place.node;
  const [name, setName] = useState("");
  const gov = useGovern();
  const taken = fold(name) !== "" && depts(parent).some((c) => fold(c.name) === fold(name));
  const submit = useGovernSubmit(() => ({ kind: "NEW", target: { kind: "ORG_UNIT", ref: unitIdOf(parent), label: fold(name) }, title: t("orgChange.title.create", { name: fold(name) }), proposal: [createGovOp(parent, name)], select: parent.id }), gov);
  const missing = [!fold(name) && t("orgUnit.gov.missingName"), taken && t("orgUnit.add.taken", { parent: parent.name }), ...gov.missing].filter((x): x is string => Boolean(x));
  const reasonId = "dept-add-gov-reason";
  return (
    <Sheet
      open
      wide
      kicker={<><Network size={14} aria-hidden />{t("orgUnit.gov.addKicker", { path: [place.workplace?.name, parent.kind === "WORKPLACE" ? undefined : parent.name].filter(Boolean).join(" › ") })}</>}
      title={t("orgUnit.gov.addTitle")}
      onClose={onClose}
      pending={submit.isPending}
      notice={<CommandError error={submit.error} />}
      consequence={
        missing.length ? (
          <span id={reasonId} className={css.footReason}><Lock size={14} aria-hidden />{t("orgUnit.gov.missing", { list: missing.join(", ") })}</span>
        ) : (
          <>
            <span>{t("orgUnit.gov.addConsequence", { name: fold(name), date: gov.g.date })}</span>
            <Muted>{t("orgUnit.gov.setupWouldApply")}</Muted>
          </>
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
        label={t("orgUnit.gov.name")}
        required
        error={taken ? t("orgUnit.add.taken", { parent: parent.name }) : undefined}
      >
        {(p) => <TextInput {...p} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <GovernFields s={gov} />
      <p className={css.note}>{t("orgUnit.governed.membersLater")}</p>
    </Sheet>
  );
}
