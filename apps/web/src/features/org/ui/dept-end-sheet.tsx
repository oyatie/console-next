import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ban, Network, Trash2 } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { applySetup, STRUCTURE_READS } from "../../../reference/org/api";
import { depts, descendants, direct, type Place } from "../../../reference/org/domain/structure";
import { ownRefusal, refusalText } from "../../../reference/crud/present";
import { deletePlan, type ChildrenChoice } from "../domain/structure-plans";
import { dissolveUnit, eraseUnit, unitEndQuery } from "../api";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

type Plan = "erase" | "dissolve" | "raise";

/**
 * How a department ends (CRUD; design-language §6.4): the server decides by use, not by phase. A department nobody was ever
 * placed in or moved through is delete — it and its sub-departments leave the record (one audit row each says what went). One
 * that was used is dissolution — closed now, kept in the history. The sheet offers the one that applies and says why the other is
 * not offered, with the server's code; people still in it are moved first (or with the dissolution proposal, which moves them).
 * In setup, a department with sub-departments and no direct members asks first, nothing preselected (S6-delete): end them with
 * it, or move them one level up (then this one is dissolved in the same undoable batch, since they sat under it).
 */
export function DeptEndSheet({ place, setup, onClose, onDone, onPropose }: { place: Place; setup: boolean; onClose: () => void; onDone: () => void; onPropose: () => void }) {
  const d = place.node;
  const subs = depts(d);
  const q = useQuery({ ...unitEndQuery(d.id), refetchOnMount: "always" });
  const [children, setChildren] = useState<ChildrenChoice | null>(null);
  const done = { invalidates: STRUCTURE_READS, settle: true, onSuccess: onDone };
  const erase = useCommand({ ...done, run: (v: number, key: string) => eraseUnit(key, d.id, v), announce: () => t("crud.unit.erased", { name: d.name }) });
  const dissolve = useCommand({ ...done, run: (v: number, key: string) => dissolveUnit(key, d.id, v), announce: () => t("crud.unit.dissolved", { name: d.name }) });
  const raise = useCommand({ ...done, run: (_: number, key: string) => applySetup(key, deletePlan(place, "raise").ops), announce: () => t("crud.unit.dissolved", { name: d.name }) });
  const o = q.data;
  // org-15: after go-live a used department ends one way, the dated dissolve sheet that settles its members, head and grants;
  // this sheet hands over to it rather than refusing with "move them first". A held one stays here to name its change.
  const handOff = Boolean(o && o.phase === "OPERATING" && o.can_manage && !o.delete.allowed && !o.held_by);
  const handed = useRef(false);
  useEffect(() => {
    if (!handOff || handed.current) return;
    handed.current = true;
    onPropose();
  }, [handOff, onPropose]);
  // The sheet opens once the server has answered, so its actions land with it (no shift under the pointer).
  if (q.isPending || handOff) return null;
  const pending = erase.isPending || dissolve.isPending || raise.isPending;
  const sub = descendants(d).map((c) => c.name);
  const ask = setup && subs.length > 0 && direct(d) === 0;
  const whole: Plan | null = !o ? null : o.delete.allowed ? "erase" : o.dissolve.allowed ? "dissolve" : null;
  const plan: Plan | null = ask ? (children === "raise" ? "raise" : children === "cascade" ? whole : null) : whole;
  const run = { erase, dissolve, raise };
  const consequence = !o
    ? null
    : plan === "raise"
      ? t("orgUnit.delete.consequenceRaise", { name: d.name, sub: subs.map((c) => c.name).join("·"), parent: place.parent!.name })
      : ask && !children
        ? t("crud.unit.chooseChildren")
        : plan === "erase"
          ? t("crud.unit.eraseConsequence", { name: d.name, count: sub.length })
          : plan === "dissolve"
            ? t("crud.unit.dissolveConsequence", { name: d.name })
            : t("crud.unit.noneConsequence");
  return (
    <Sheet
      open
      kicker={<><Network size={14} aria-hidden />{[place.entity.name, place.workplace?.name].filter(Boolean).join(" › ")}</>}
      title={t("crud.unit.title", { name: d.name })}
      subtitle={t("crud.unit.subtitle")}
      onClose={onClose}
      pending={pending}
      notice={<CommandError error={erase.error ?? dissolve.error ?? raise.error} own={ownRefusal} />}
      consequence={<span id="crud-unit-consequence">{consequence}</span>}
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {o?.can_manage && (plan || (ask && !children)) && (
            <Button
              variant="danger"
              id={plan === "dissolve" ? "crud-unit-dissolve" : "crud-unit-erase"}
              disabled={pending}
              aria-disabled={plan ? undefined : true}
              aria-describedby={plan ? undefined : "crud-unit-consequence"}
              onClick={() => plan && run[plan].mutate(Number(o.version))}
            >
              {plan === "dissolve" ? <Ban size={16} aria-hidden /> : <Trash2 size={16} aria-hidden />}
              {t(plan === "dissolve" ? "crud.unit.dissolve" : "crud.unit.erase", { name: d.name })}
            </Button>
          )}
        </>
      }
    >
      <QueryState q={q}>
        {(read) => (
          <>
            {ask && (
              <ChoiceField
                label={t("orgUnit.delete.childrenLabel", { count: subs.length, list: subs.map((c) => t("orgUnit.delete.childItem", { name: c.name, n: c.headcount })).join(" · ") })}
                required
                columns={2}
                options={[
                  { value: "raise", label: t("orgUnit.delete.raise"), description: t("orgUnit.delete.raiseHint", { parent: place.parent!.name, n: subs.reduce((n, c) => n + c.headcount, 0) }) },
                  { value: "cascade", label: t("orgUnit.delete.cascade"), description: whole ? t("crud.unit.cascadeHint") : undefined, disabled: whole ? undefined : refusalText(read.dissolve.refusal, { count: read.members }) },
                ]}
                value={children}
                onChange={(v) => setChildren(v as ChildrenChoice)}
              />
            )}
            {read.held_by && (
              // org-16: the change that holds the unit is its one blocker, linked.
              <Banner tone="warn" actions={<Link to="/org/changes/$id" params={{ id: read.held_by.id }}>{t("crud.unit.openHeld", { code: read.held_by.code })}</Link>}>
                {t("crud.unit.heldBy", { code: read.held_by.code })}
              </Banner>
            )}
            {!read.held_by && <ul className={css.list} aria-label={t("crud.unit.ways")}>
              <Way
                label={t("crud.way.erase")}
                offered={read.delete.allowed}
                text={read.delete.allowed ? (sub.length ? t("crud.unit.eraseWith", { list: sub.join(" · ") }) : t("crud.unit.eraseAlone")) : refusalText(read.delete.refusal, { count: read.people_ever })}
                remedy={!read.delete.allowed && <Muted>{t("crud.unit.eraseNo")}</Muted>}
              />
              <Way
                label={t("crud.way.dissolve")}
                offered={read.dissolve.allowed}
                text={read.dissolve.allowed ? t("crud.unit.dissolveText") : refusalText(read.dissolve.refusal, { count: read.members })}
                remedy={
                  read.dissolve.refusal === "org_unit_has_members" ? (
                    <span className="row">
                      <Link to="/people" search={{ unit: d.id }}>{t("crud.unit.seeMembers", { count: read.members })}</Link>
                      {read.phase === "OPERATING" && <Button variant="ghost" className="btn--sm" id="crud-unit-propose" onClick={onPropose}>{t("crud.unit.moveAndDissolve")}</Button>}
                    </span>
                  ) : read.dissolve.refusal === "org_change_routed" ? (
                    <Button variant="ghost" className="btn--sm" id="crud-unit-propose" onClick={onPropose}>{t("crud.unit.propose")}</Button>
                  ) : null
                }
              />
              {!read.can_manage && <li className="muted">{t("crud.noPermission")}</li>}
            </ul>}
          </>
        )}
      </QueryState>
    </Sheet>
  );
}

/** One way to end it: offered (what happens) or not (why), with the way on when there is one. */
function Way({ label, offered, text, remedy }: { label: string; offered: boolean; text?: string; remedy?: ReactNode }) {
  return (
    <li className={css.stack}>
      <strong>{label} · {t(offered ? "crud.offered" : "crud.notOffered")}</strong>
      <span className={offered ? undefined : "muted"}>{text ?? t("crud.refused.unknown")}</span>
      {remedy}
    </li>
  );
}
