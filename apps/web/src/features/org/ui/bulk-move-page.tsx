import { useState } from "react";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { Lock, Network, Plus } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Composer } from "../../../ui/composer/composer";
import { Dialog } from "../../../ui/dialog";
import { applySetup, STRUCTURE_READS } from "../../../reference/org/api";
import { bulkPlan, type Resolution } from "../domain/bulk-move";
import { collapse, descendants, targetsFor, type Node, type Place } from "../../../reference/org/domain/structure";
import { BulkMoveTable } from "./bulk-move-table";
import { useEiUnit } from "../../../reference/entity/ui/use-ei-unit";
import { GovernFields } from "./govern-fields";
import { useGovern, useGovernSubmit } from "./use-govern";
import { MiniTree, TreeLegend } from "./mini-tree";
import { TargetTree } from "./target-tree";
import { useStructure } from "../../../reference/org/ui/use-structure";
import s from "./bulk-move.module.css";
import { Muted } from "../../../ui/muted/muted";

const route = getRouteApi("/app/org/move");

/**
 * S8 bulk move: a full page in three columns — the valid-only target tree, what changes with exact counts, and
 * the target workplace after. A chosen department inside another chosen one travels with it (the title counts both). Setup
 * applies at once and can be undone; after go-live it is one proposal with one item per move and rename.
 */
export function BulkMovePage() {
  const { ids } = route.useSearch();
  const chosen = (ids ?? "").split(",").filter(Boolean);
  const st = useStructure();
  return <QueryState q={st.q} layout="form">{() => <Body chosen={chosen} places={st.places} setup={st.setup} company={st.tenant} />}</QueryState>;
}

function Body({ chosen, places, setup, company }: { chosen: string[]; places: Map<string, Place>; setup: boolean; company: string }) {
  const nav = useNavigate();
  const { roots, carried } = collapse(places, chosen);
  const { entity, excluded } = targetsFor(places, roots);
  const first = roots[0] && places.get(roots[0].id);
  const ei = useEiUnit(entity?.id);
  const [to, setTo] = useState<string | null>(null);
  const [res, setRes] = useState<Map<string, Resolution>>(new Map());
  const target = to ? places.get(to) : undefined;
  const plan = target ? bulkPlan(places, roots, target, res, ei) : undefined;
  const gov = useGovern();
  const close = () => void nav({ to: "/org", search: { sel: roots.length === 1 ? roots[0]!.id : undefined } });
  const run = useCommand({
    run: (_: undefined, key: string) => applySetup(key, plan!.setupOps()),
    invalidates: STRUCTURE_READS,
    announce: () => t("bulkMove.done", { n: plan!.totals.units, m: plan!.totals.members, to: target!.node.name }),
    onSuccess: () => void nav({ to: "/org", search: { sel: target!.node.org_unit_id ?? target!.node.id } }),
  });
  // org-25: the change is named by what it does, here and in the list.
  const moveTitle = () =>
    roots.length === 1 ? t("orgChange.title.move", { name: roots[0]!.name, parent: target!.node.name }) : t("orgChange.title.moveMany", { name: roots[0]!.name, count: roots.length - 1, parent: target!.node.name });
  const submit = useGovernSubmit(() => ({ kind: "REORG", target: { kind: "ORG_UNIT", ref: roots[0]!.id, label: moveTitle() }, proposal: plan!.govOps(company) }), gov);
  if (!first || !entity) return <Unmovable mixed={roots.length > 1} onClose={close} />;
  const count = roots.length + carried.length;
  const total = roots.reduce((n, r) => n + 1 + descendants(r).length, 0);
  const here = (n: Node) => roots.every((r) => places.get(r.id)?.parent?.id === n.id);
  const blockers = [
    !plan && t("bulkMove.pickTarget"),
    plan && plan.unresolved > 0 && t("bulkMove.unresolved", { count: plan.unresolved }),
    plan && setup && plan.setupBlocked && t("bulkMove.mergeMembersUnserved"),
    !setup && gov.missing.join(", "),
  ].filter((x): x is string => Boolean(x));
  const items = plan ? plan.items.moves + plan.items.renames + plan.items.merges : 0;
  return (
    <Composer
      layout="page"
      title={count === 1 ? t("bulkMove.titleOne", { name: roots[0]!.name }) : t("bulkMove.title", { n: count })}
      kicker={<span className={s.crumb}><Network size={14} aria-hidden />{t("bulkMove.from")} · {[t("orgStructure.title"), ...first.path].join(" › ")}</span>}
      subtitle={t("bulkMove.titleSub", { m: total })}
      tools={<><AddMore entity={entity} chosen={chosen} /><Chip tone={setup ? "ok" : "info"}>{t(setup ? "bulkMove.phaseSetup" : "bulkMove.phaseOperating")}</Chip></>}
      onClose={close}
      pending={run.isPending || submit.isPending}
      action={{ kind: "orgMove", mode: !setup && gov.routed ? "request" : !setup && gov.mode === "schedule" ? "schedule" : "apply", count }}
      onSubmit={() => { if (blockers.length === 0) { if (setup) run.mutate(undefined); else submit.mutate(true); } }}
      blocked={blockers.length ? { reason: blockers.join(", ") } : undefined}
      onSaveDraft={!setup && blockers.length === 0 ? () => submit.mutate(false) : undefined}
      notice={<CommandError error={run.error ?? submit.error} />}
      sections={{
        preflight: blockers.length || carried.length ? <>
          {blockers.length > 0 && <span className={s.reason}><Lock size={14} aria-hidden />{blockers[0]}</span>}
          {carried.length > 0 && <p className={s.lead}>{t("bulkMove.collapsed", { names: carried.map((c) => c.name).join("·"), parent: carried.map((c) => places.get(c.id)?.parent?.name).join("·"), n: roots.length })}</p>}
        </> : null,
        effects: !blockers.length ? <>
          <span>{t(setup ? "bulkMove.consequence" : "bulkMove.consequenceGoverned", { n: count, m: total, p: plan!.totals.members, to: target!.workplace!.name, date: gov.g.date, items, moves: plan!.items.moves, renames: plan!.items.renames })}</span>
          <Muted>{t(setup ? "bulkMove.consequenceSetupNote" : "bulkMove.consequenceGovNote", { p: plan!.totals.siteChanged })}</Muted>
        </> : null,
        approvals: !setup && gov.routed ? t("orgPropose.route") : null,
      }}
    >
      <div className={s.cols}>
        <section className={`card ${s.col}`} aria-label={t("bulkMove.where")}>
          <TargetTree
            label={t("bulkMove.where")}
            entity={entity}
            show={() => true}
            why={(n) => excluded.has(n.id) ? t("bulkMove.addTaken") : here(n) ? t("orgUnit.target.here") : undefined}
            right={(n) => (n.kind === "WORKPLACE" ? t("orgUnit.target.depts", { count: descendants(n).length }) : "")}
            workplaces
            value={to}
            onChange={setTo}
          />
        </section>
        <section className={`card ${s.col}`} aria-labelledby="bulk-what">
          <h2 id="bulk-what" className={s.colTitle}>{t("bulkMove.what")}</h2>
          {plan ? <BulkMoveTable plan={plan} targetLabel={target!.node.name} onResolve={(id, r) => setRes((m) => { const n = new Map(m); if (r) n.set(id, r); else n.delete(id); return n; })} /> : <p className="muted">{t("bulkMove.pickFirst")}</p>}
          {!setup && (
            <div className={s.gov}>
              <h3 className="field__label">{t("bulkMove.draft")}</h3>
              <GovernFields s={gov} />
            </div>
          )}
        </section>
        <section className={`card ${s.col}`} aria-labelledby="bulk-after">
          <h2 id="bulk-after" className={s.colTitle}>{target ? t("bulkMove.after", { site: target.workplace!.name }) : t("bulkMove.afterNone")}</h2>
          <TreeLegend tags={["movedIn", "movedRenamed", "merged"]} />
          {plan && <MiniTree label={t("bulkMove.after", { site: target!.workplace!.name })} root={plan.after} />}
        </section>
      </div>
    </Composer>
  );
}

/**
 * Adds another department of the same entity to what moves (the keyboard twin of Shift+click on the chart), through the
 * canonical searchable tree (org-21): only department not chosen yet can be picked.
 */
function AddMore({ entity, chosen }: { entity: Node; chosen: string[] }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const taken = new Set(chosen);
  if (!entity.children.some((w) => descendants(w).some((n) => !taken.has(n.id)))) return null;
  return (
    <>
      <Button aria-haspopup="dialog" onClick={() => setOpen(true)}><Plus size={16} aria-hidden />{t("bulkMove.addMore")}</Button>
      <Dialog open={open} title={t("bulkMove.addMore")} onClose={() => setOpen(false)}>
        <TargetTree
          label={t("bulkMove.addMore")}
          entity={entity}
          show={() => true}
          why={(n) => (taken.has(n.id) ? t("bulkMove.addTaken") : undefined)}
          right={(n) => (n.kind === "DEPARTMENT" ? t("orgStructure.peopleCount", { count: n.headcount }) : "")}
          workplaces={false}
          value={null}
          onChange={(id) => { setOpen(false); void nav({ to: "/org/move", search: { ids: [...chosen, id].join(",") } }); }}
        />
      </Dialog>
    </>
  );
}

/** Nothing to move, or units of different legal entity together: said plainly, with the way back. */
function Unmovable({ mixed, onClose }: { mixed: boolean; onClose: () => void }) {
  return (
    <div className="page">
      <p className="alert" role="alert">{t(mixed ? "bulkMove.mixedEntities" : "bulkMove.nothing")}</p>
      <div><Button onClick={onClose}>{t("composer.dismiss")}</Button></div>
    </div>
  );
}
