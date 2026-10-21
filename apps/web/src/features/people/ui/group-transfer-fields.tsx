import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { useQuery } from "@tanstack/react-query";
import { entitiesRef } from "../../../reference/entity/api";
import { entityNameText } from "../../../reference/entity/present";
import { EmptyState } from "../../../ui/empty-state";
import { Marker } from "../../../ui/field/field";
import { buttonClass } from "../../../ui/button/button-class";
import { Button } from "../../../ui/button/button";
import type { GroupInput, GroupTargets } from "../domain/group-transfer";
import { ConsentFields, ContinuityFields, type ShowFact } from "../../../reference/group-transfer/ui/group-facts";
import { UnitTarget } from "./transfer-target";
import s from "./lifecycle.module.css";

type Unit = components["schemas"]["OrgUnitHead"];

/**
 * Why a group transfer cannot start here, with the way on (no dead end): register another legal entity (a whole-tenant holder), see or
 * request access (a holder scoped to their own legal entity), add a workplace to a legal entity that has none, or place the person first.
 * A move inside the person's own legal entity is a transfer or relocation, offered from every state.
 */
export function GroupBlocked({ targets, onTransfer }: { targets: Exclude<GroupTargets, { kind: "ready" }>; onTransfer: () => void }) {
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const name = (id: string) => { const e = entities.find((x) => x.id === id); return e ? entityNameText(e) : t("entity.name.unconfirmed"); };
  const key = targets.kind === "none" ? (targets.scoped ? "scoped" : "solo") : targets.kind;
  const links: ReactNode =
    targets.kind === "unplaced" ? <Link to="/people/unplaced" className={buttonClass("primary")}>{t("groupTransfer.blocked.unplaced.do")}</Link>
    : targets.kind === "noPlace" ? targets.entities.map((e) => <Link key={e.id} to="/org/entities/$id/workplaces/new" params={{ id: e.id }} className={buttonClass("primary")}>{t("groupTransfer.blocked.noPlace.do", { entity: name(e.id) })}</Link>)
    : targets.scoped ? <Link to="/account" className={buttonClass("primary")}>{t("groupTransfer.blocked.scoped.do")}</Link>
    : <Link to="/org/entities/new" className={buttonClass("primary")}>{t("groupTransfer.blocked.solo.do")}</Link>;
  return (
    <EmptyState
      title={t(`groupTransfer.blocked.${key}`)}
      reason={t(`groupTransfer.blocked.${key}.why`)}
      actions={<>{links}{targets.kind !== "unplaced" && <Button onClick={onTransfer}>{t("groupTransfer.sameEntity")}</Button>}</>}
    />
  );
}

type Show = (k: "target" | Parameters<ShowFact>[0]) => boolean;

/**
 * The group transfer's own facts (spec E5-group-transfer): the consent first, the receiving unit at another legal entity's workplace,
 * the date, and what carries over (each dimension chosen, nothing preselected).
 */
export function GroupFields({ v, set, options, units, today, show, onTransfer, dateSlot, hire, date }: {
  v: GroupInput;
  set: (patch: Partial<GroupInput>) => void;
  options: Extract<GroupTargets, { kind: "ready" }>["options"];
  units: Unit[];
  today: string;
  show: Show;
  onTransfer: () => void;
  dateSlot: ReactNode;
  hire?: string;
  date: string;
}) {
  return (
    <>
      <section className={s.section} aria-labelledby="gt-consent">
        <h3 id="gt-consent" className={s.flabel}>{t("groupTransfer.consent")}<Marker required /></h3>
        <ConsentFields v={v} set={set} today={today} show={show} />
      </section>
      <section className={s.section} aria-label={t("groupTransfer.where")}>
        <UnitTarget
          label={t("groupTransfer.where")}
          icon={<Building2 size={16} aria-hidden />}
          options={options}
          units={units}
          value={v.unit}
          onChange={(unit) => set({ unit, workplaceId: options.find((o) => o.unit.id === unit)?.workplaceId ?? "" })}
          error={show("target") ? t("groupTransfer.where.missing") : undefined}
        />
        <Button variant="ghost" onClick={onTransfer}>{t("groupTransfer.sameEntity")}</Button>
      </section>
      <section className={s.section} aria-labelledby="lc-when">
        <h3 id="lc-when" className="sr-only">{t("lifecycle.section.when")}</h3>
        {dateSlot}
      </section>
      <section className={s.section} aria-label={t("groupTransfer.continuity")}>
        <ContinuityFields v={v} set={set} today={today} show={show} date={date} hire={hire} />
      </section>
    </>
  );
}
