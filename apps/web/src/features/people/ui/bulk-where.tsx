import { Building2, MapPin, Network } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Field, TextInput } from "../../../ui/field/field";
import { PathList, type PathItem } from "../../../ui/path-list/path-list";
import type { Kind } from "../domain/bulk";
import type { JobTitle } from "../domain/titles";
import { SelectInput } from "../../../ui/field/select-input";
import s from "./bulk-page.module.css";

type Unit = components["schemas"]["OrgUnitHead"];

/**
 * The places a whole batch can go, as a tree under the people's company (spec E6-move, where to): each workplace says
 * whether moving there keeps the workplace, each unit its headcount; the unit the people are in now is listed but
 * not pickable. Other companies are hidden (a change of company is a group transfer, one by one).
 */
function places(units: readonly Unit[], from: ReadonlySet<string>, site: string | undefined, entity: string, hidden: number): PathItem[] {
  const kids = (id: string | null) => units.filter((u) => u.parentId === id && u.status === "ACTIVE" && u.kind !== "COMPANY");
  const root = units.find((u) => u.kind === "COMPANY");
  const out: PathItem[] = [{ id: "entity", name: entity, depth: 0, icon: <Building2 size={14} aria-hidden />, note: hidden ? t("bulk.page.otherEntities", { n: hidden }) : undefined, header: true }];
  const walk = (u: Unit, depth: number) => {
    const here = from.has(u.id);
    out.push({
      id: u.id,
      name: u.name,
      depth,
      icon: u.kind === "SITE" ? <MapPin size={14} aria-hidden /> : <Network size={14} aria-hidden />,
      note: u.kind === "SITE" ? t(u.name === site ? "bulk.page.siteSame" : "bulk.page.siteMove") : t("register.place.count", { n: u.headcount }),
      disabled: here ? t("bulk.page.here") : undefined,
    });
    for (const c of kids(u.id)) walk(c, depth + 1);
  };
  for (const top of kids(root?.id ?? null)) walk(top, 1);
  return out;
}

/** The left pane: where to (a transfer) or the new title (a promotion). */
export function BulkWhere({ kind, units, titles = [], from, site, entity, hidden, unitId, onUnit, position, onPosition, count, unitError, positionError, positionOptional = false }: {
  kind: Kind | null;
  units: readonly Unit[];
  titles?: readonly JobTitle[];
  /** The units the people are in now. */
  from: ReadonlySet<string>;
  /** Their workplace now, when they share one. */
  site?: string;
  entity: string;
  /** Other companies, hidden. */
  hidden: number;
  unitId: string;
  onUnit: (id: string) => void;
  position: string;
  onPosition: (v: string) => void;
  count: number;
  unitError?: string;
  positionError?: string;
  /** Each person's title is picked on their row: this field only fills the people left without one. */
  positionOptional?: boolean;
}) {
  return (
    <section className={s.pane} aria-labelledby="bulk-where">
      <div className={s.paneHead}>
        <h2 id="bulk-where" className={s.paneTitle}>{kind === "PROMOTE" ? t("bulk.page.position") : t("bulk.page.where")}</h2>
        <small>{kind === "PROMOTE" ? t("bulk.page.positionNote") : t("bulk.page.whereNote", { n: count })}</small>
      </div>
      {kind === "PROMOTE" ? (
        <div className={s.paneBody}>
          <Field label={t(positionOptional ? "bulk.page.positionRest" : "bulk.page.position")} required={!positionOptional} error={positionError}>
            {(p) => titles.length ? <SelectInput {...p} value={position} onChange={(e) => onPosition(e.target.value)}><option value="">{t("bulk.promote.none")}</option>{titles.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</SelectInput> : <TextInput {...p} value={position} onChange={(e) => onPosition(e.target.value)} />}
          </Field>
        </div>
      ) : (
        <>
          <PathList items={places(units, from, site, entity, hidden)} value={unitId} onChange={onUnit} label={t("bulk.page.where")} searchLabel={t("bulk.page.findLabel")} placeholder={t("bulk.page.find")} />
          {unitError && <p className={s.err}>{unitError}</p>}
        </>
      )}
    </section>
  );
}
