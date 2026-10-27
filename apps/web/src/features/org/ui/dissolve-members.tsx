import { useState } from "react";
import { ArrowRight, Users } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import type { Node, Place } from "../../../reference/org/domain/structure";
import type { Group, Member } from "../domain/dissolve-plan";
import { TargetTree } from "./target-tree";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * Where a closing department's members go (org-06): everyone to one place, chosen once (the parent by default, or the
 * workplace itself), and any one person elsewhere through the same searchable tree. Groups are drawn by destination, so
 * what will happen reads before it is applied.
 */
export function DissolveMembers({ place, groups, to, onTo, overrides, onOverride, workplaceName }: {
  place: Place;
  groups: Group[];
  to: Node;
  onTo: (id: string) => void;
  overrides: ReadonlyMap<string, Node>;
  onOverride: (person: Member, to: string | null) => void;
  workplaceName: (n: Node) => string | undefined;
}) {
  const [picking, setPicking] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const d = place.node;
  const tree = (value: string | null, onChange: (id: string) => void, label: string) => (
    <TargetTree
      label={label}
      entity={place.entity}
      show={() => true}
      why={(n) => (n.id === d.id ? t("orgUnit.dissolve.self") : undefined)}
      right={(n) => (n.kind === "WORKPLACE" ? t("orgUnit.dissolve.siteDirect", { site: n.name }) : t("orgStructure.peopleCount", { count: n.headcount }))}
      workplaces
      value={value}
      onChange={onChange}
    />
  );
  return (
    <div className={css.stack}>
      <p className="row">
        <Users size={14} aria-hidden />
        <span className="grow">{t("orgUnit.dissolve.allTo", { n: groups.reduce((n, g) => n + g.people.length, 0), to: label(to, workplaceName) })}</span>
        <Button variant="ghost" size="sm" id="dissolve-change-to" aria-expanded={changing} onClick={() => setChanging((x) => !x)}>{t("orgUnit.dissolve.changeTo")}</Button>
      </p>
      {changing && tree(to.id, (id) => { onTo(id); setChanging(false); }, t("orgUnit.dissolve.toLabel"))}
      {groups.map((g) => (
        <section key={g.to.id} aria-label={t("orgUnit.dissolve.group", { to: label(g.to, workplaceName), count: g.people.length })}>
          <h4 className="row"><ArrowRight size={14} aria-hidden />{t("orgUnit.dissolve.group", { to: label(g.to, workplaceName), count: g.people.length })}</h4>
          <ul className={css.list}>
            {g.people.map((m) => (
              <li key={m.employeeId} className={css.stack}>
                <span className="row">
                  <span className={css.av} aria-hidden>{m.name.slice(0, 1)}</span>
                  <b className="grow">{m.name}</b>
                  {overrides.has(m.employeeId) && <Button variant="ghost" size="sm" onClick={() => onOverride(m, null)}>{t("orgUnit.dissolve.backToAll")}</Button>}
                  <Button variant="ghost" size="sm" aria-expanded={picking === m.employeeId} onClick={() => setPicking((x) => (x === m.employeeId ? null : m.employeeId))}>
                    {t("orgUnit.dissolve.elsewhere", { name: m.name })}
                  </Button>
                </span>
                {picking === m.employeeId && tree(overrides.get(m.employeeId)?.id ?? null, (id) => { onOverride(m, id); setPicking(null); }, t("orgUnit.dissolve.personTo", { name: m.name }))}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A destination by name: a workplace reads as its direct, a department with its workplace. */
const label = (n: Node, workplaceName: (n: Node) => string | undefined) =>
  n.kind === "WORKPLACE" ? t("orgUnit.dissolve.siteDirect", { site: n.name }) : [workplaceName(n), n.name].filter(Boolean).join(" › ");
