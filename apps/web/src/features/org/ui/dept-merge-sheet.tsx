import { useState } from "react";
import { GitMerge, Lock } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Sheet } from "../../../ui/sheet/sheet";
import { applySetup, STRUCTURE_READS } from "../../../reference/org/api";
import { mergePlan } from "../domain/structure-plans";
import { descendants, direct, type Place } from "../../../reference/org/domain/structure";
import { useEiUnit } from "../../../reference/entity/ui/use-ei-unit";
import { GovernFields } from "./govern-fields";
import { useGovern, useGovernSubmit } from "./use-govern";
import { MiniTree, TreeLegend } from "./mini-tree";
import { Stats } from "../../../reference/org/ui/panel-shell";
import { TargetTree } from "./target-tree";
import css from "../../../reference/org/ui/structure.module.css";
import { Muted } from "../../../ui/muted/muted";

/**
 * department merge (S6-merge): the target tree hides other legal entity and disables the unit's own subtree; the right side shows
 * the totals and the target's workplace after. Setup applies at once; after go-live it is one proposal.
 */
export function DeptMergeSheet({ place, places, setup, company, onClose, onDone }: { place: Place; places: Map<string, Place>; setup: boolean; company: string; onClose: () => void; onDone: (target: string) => void }) {
  const a = place.node;
  const ei = useEiUnit(place.entity.id);
  const [to, setTo] = useState<string | null>(null);
  const target = to ? places.get(to) : undefined;
  const own = new Set(descendants(a).map((x) => x.id));
  const plan = target ? mergePlan(place, target, ei, company) : undefined;
  const gov = useGovern();
  const run = useCommand({
    run: (_: undefined, key: string) => applySetup(key, plan!.setupOps),
    invalidates: STRUCTURE_READS,
    announce: () => t("orgUnit.merge.done", { a: a.name, b: target!.node.name }),
    onSuccess: () => onDone(target!.node.id),
  });
  const title = target ? t("orgChange.title.merge", { name: a.name, into: target.node.name }) : a.name;
  const submit = useGovernSubmit(() => ({ kind: "DISSOLVE", target: { kind: "ORG_UNIT", ref: a.id, label: title }, proposal: plan!.govOps, select: target!.node.id }), gov);
  const membersBlock = setup && direct(a) > 0;
  const blockers = [!target && t("orgUnit.merge.pick"), membersBlock && t("orgUnit.merge.membersUnserved", { count: direct(a) }), !setup && gov.missing.join(", ")].filter((x): x is string => Boolean(x));
  const reasonId = "merge-reason";
  const label = target ? t("orgUnit.merge.submit", { name: target.node.name, n: a.headcount }) : t("orgUnit.act.merge");
  const pending = run.isPending || submit.isPending;
  return (
    <Sheet
      open
      wide
      kicker={<><GitMerge size={14} aria-hidden />{[...place.path, a.name].join(" › ")}</>}
      title={t("orgUnit.merge.title", { name: a.name })}
      subtitle={t("orgUnit.merge.subtitle", { name: a.name })}
      onClose={onClose}
      pending={pending}
      notice={<CommandError error={run.error ?? submit.error} />}
      consequence={
        <>
          {plan && target && <span>{t("orgUnit.merge.consequence", { a: a.name, b: [target.workplace!.name, target.node.name].join(" › "), n: plan.totals.children, m: plan.totals.members })}</span>}
          {plan && target && plan.totals.siteChanged > 0 && <Muted>{t("orgUnit.merge.siteChange", { from: place.workplace!.name, to: target.workplace!.name, n: plan.totals.siteChanged })}</Muted>}
          {blockers.length > 0 && <span id={reasonId} className={membersBlock ? css.footWarn : css.footReason}><Lock size={14} aria-hidden />{blockers[0]}</span>}
        </>
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {!setup && blockers.length === 0 && <Button onClick={() => submit.mutate(false)}>{t("orgUnit.gov.saveDraft")}</Button>}
          {blockers.length === 0 ? (
            <Button variant="primary" onClick={() => (setup ? run.mutate(undefined) : submit.mutate(true))}><GitMerge size={16} aria-hidden />{setup ? label : gov.words.submit(plan!.govOps.length)}</Button>
          ) : (
            <Button variant="primary" aria-disabled aria-describedby={reasonId}><GitMerge size={16} aria-hidden />{label}</Button>
          )}
        </>
      }
    >
      <div className={css.two}>
        <TargetTree
          label={t("orgUnit.merge.where")}
          entity={place.entity}
          show={() => true}
          why={(n) => (n.id === a.id ? t("orgUnit.merge.self") : own.has(n.id) ? t("orgUnit.merge.own") : n.id === place.workplace?.id ? t("orgUnit.target.here") : undefined)}
          right={(n) => (n.kind === "DEPARTMENT" ? t("orgStructure.peopleCount", { count: n.headcount }) : "")}
          workplaces={false}
          value={to}
          onChange={setTo}
        />
        <div className={css.stack}>
          <span className="field__label">{t("orgUnit.merge.after")}</span>
          {plan ? (
            <>
              <Stats
                items={[
                  { label: t("orgUnit.merge.stat.children"), value: plan.totals.children },
                  { label: t("orgUnit.merge.stat.members"), value: plan.totals.members },
                  { label: t("orgUnit.merge.stat.site"), value: plan.totals.siteChanged },
                  { label: t("orgUnit.merge.stat.ei"), value: plan.totals.eiChanged },
                ]}
              />
              <div className="row">
                <span className="field__label grow">{t("orgUnit.merge.afterTree", { site: target!.workplace!.name })}</span>
                <TreeLegend tags={["merged", "movedIn"]} />
              </div>
              <MiniTree label={t("orgUnit.merge.afterTree", { site: target!.workplace!.name })} root={plan.after} />
            </>
          ) : (
            <p className={css.note}>{t("orgUnit.merge.pickFirst")}</p>
          )}
        </div>
      </div>
      {!setup && <GovernFields s={gov} />}
    </Sheet>
  );
}
