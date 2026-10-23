import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { DerivedValue } from "../../../ui/field/derived-value";
import type { Unit } from "../domain/proposal";
import { preview } from "../domain/preview";
import { NameField } from "./propose-fields";
import type { Kit } from "./proposal-form";
import { StructureDiff } from "./structure-diff";
import type { UnitKit } from "./use-unit-kit";
import s from "./propose.module.css";

type Summary = components["schemas"]["OrgChangeSummary"];
type Op = components["schemas"]["OrgProposalOp"];
export type Row = { label: string; value: ReactNode; basis?: string };

/** The card's context: values derived by rule with their basis, then the facts as a list, then `note` once. */
export function Context({ rows, note }: { rows: Row[]; note?: string }) {
  const facts = rows.filter((r) => r.basis === undefined);
  return (
    <>
      {rows.filter((r) => r.basis !== undefined).map((r) => <DerivedValue key={r.label} label={r.label} value={r.value} basis={r.basis} />)}
      {facts.length > 0 && (
        <dl className="kv">
          {facts.map((r) => [<dt key={`${r.label}-t`}>{r.label}</dt>, <dd key={`${r.label}-d`}>{r.value}</dd>])}
        </dl>
      )}
      {note && <p className={s.note}>{note}</p>}
    </>
  );
}

export function ChangeLink({ c, children }: { c: Summary; children: ReactNode }) {
  return <Link to="/org/changes/$id" params={{ id: c.id }}>{children}</Link>;
}

/** The name input, with a caution (never a block) when a sibling or an open change already uses the name. */
/** `kind`: the kind of the unit being named, which picks the example (a team name for a team). */
export function NameInput({ kit, k, kind, label, siblings, parent, hint }: { kit: Kit; k: UnitKit; kind: Unit["kind"]; label: string; siblings: Unit[]; parent?: Unit; hint?: ReactNode }) {
  const same = parent ? k.namesake(siblings, parent.id) : { unit: undefined, change: undefined };
  const caution = same.unit ? (
    <>{t("orgPropose.field.name.duplicate", { parent: parent!.name, count: same.unit.headcount })} <Link to="/org" search={{ sel: same.unit.id }}>{t("orgPropose.openUnit", { name: same.unit.name })}</Link></>
  ) : same.change ? (
    <>{t("orgPropose.field.name.duplicateDraft", { code: same.change.code })} <ChangeLink c={same.change}>{t("orgPropose.openChange", { code: same.change.code })}</ChangeLink></>
  ) : undefined;
  return kit.wrap("name", <NameField label={label} value={kit.v.name} onChange={(x) => kit.set("name", x)} error={kit.error("name")} hint={hint} caution={caution} example={t(`orgPropose.field.name.example.${kind}`)} />);
}

/** Before and after the op the card sends, from today's tree. */
export function UnitDiff({ units, op, summary, then, note }: { units: Unit[]; op: Op; summary: string; then: string; note?: string }) {
  return <StructureDiff summary={summary} then={then} note={note} {...preview(units, op)} />;
}
