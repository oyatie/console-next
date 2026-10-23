import { CompanyMappings } from "./company-mappings";
import { PlacePath } from "./place-path";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { entityNameText } from "../../../reference/entity/present";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { inOrder } from "../../../lib/pure/in-order";
import { QueryState } from "../../../lib/react/query-state";
import { unitsQuery } from "../../../reference/org/api";
import { checklistRef, entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { Receipt } from "../../../ui/receipt/receipt";
import { ToggleButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { PhaseLine } from "../../../ui/page-head/phase-line";
import { placeOptions } from "../domain/register-place";
import { placeText } from "../present";
import { groupBySource, suggest } from "../domain/unplaced";
import { sourceText } from "../present";
import { UnplacedGroups } from "./unplaced-groups";
import { UnplacedRows } from "./unplaced-rows";
import { UnplacedTargets } from "./unplaced-targets";
import { usePlacePeople, type Held, type Placed } from "./use-place-people";
import { personOf, useUnplacedQueue } from "./use-unplaced-queue";
import { UnplacedDone } from "./unplaced-done";
import { UnplacedRefused } from "./unplaced-refused";
import s from "./unplaced.module.css";

type Employee = components["schemas"]["Employee"];
const NONE = "none";

/**
 * The unplaced screen (spec E8): people with no workplace or department, per company, grouped by the value their import gave;
 * pick people, then a place (a suggestion by number key, a search inside the company, or the workplace itself).
 * Unplaced is not an error, and leaving someone unplaced is an answer too.
 * Who is unplaced, and the facts shown, are the server's queue (BE-MIG: no workplace, or not in the department the file
 * named), read whole (r3:hire-21).
 */
export function UnplacedPage() {
  const queue = useUnplacedQueue();
  const units = useQuery({ ...unitsQuery, refetchOnMount: "always" }).data?.items ?? [];
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const roots = useQuery({ ...orgStructureRef, retry: false }).data?.entities ?? [];
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  const all = (queue.data?.items ?? []).map(personOf);
  // The stored legal-entity order (as on the chart); people with no legal entity last.
  const ids = [...new Set(all.map((e) => e.legal_entity_id ?? NONE))];
  const tabs = [...inOrder(ids.filter((id) => id !== NONE), entities.map((e) => e.id)), ...ids.filter((id) => id === NONE)];
  const [tabPick, setTab] = useState<string | null>(null);
  const tab = tabPick && tabs.includes(tabPick) ? tabPick : (tabs[0] ?? NONE);
  const entity = entities.find((e) => e.id === tab);
  const groups = groupBySource(all.filter((e) => (e.legal_entity_id ?? NONE) === tab));
  // The open group is kept by its value: placing some of its people re-sorts the list, never moves the user away.
  const [gValue, setGValue] = useState<string | null>(null);
  const found = groups.findIndex((x) => x.value === gValue);
  const g = found >= 0 ? found : 0;
  const setG = (i: number) => setGValue(groups[i]?.value ?? null);
  const group = groups[g];
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  // What this visit placed, per placement; a group whose people are all placed shows as done.
  const [placements, setPlacements] = useState<{ tab: string; value: string; people: Employee[]; place: string }[]>([]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const options = placeOptions(units, roots, entities, null).filter((o) => tab === NONE || o.entityId === tab);
  const pathOf = (id: string) => {
    const o = options.find((x) => x.unit.id === id);
    return o ? placeText(units, o).split(" › ").slice(1).join(" › ") : "";
  };
  const suggestions = group ? suggest(group.value, options.map((o) => ({ unit: o.unit, text: placeText(units, o) })), recent) : [];
  const picked = group?.people.filter((e) => sel.has(e.id)) ?? [];
  // Directly under a workplace: the one the top suggestion sits at, else the company's only one.
  const sites = options.filter((o) => o.unit.kind === "SITE");
  const top = options.find((o) => o.unit.id === suggestions[0]?.unit.id);
  const site = sites.find((o) => top?.workplaceId && o.workplaceId === top.workplaceId) ?? (sites.length === 1 ? sites[0] : undefined);

  const placer = usePlacePeople(({ people, target }: Placed) => {
    const unit = units.find((u) => u.id === target.unitId);
    const before = unit?.headcount ?? 0;
    if (group) setPlacements((d) => [...d, { tab, value: group.value, people, place: pathOf(target.unitId) }]);
    setRecent((r) => [target.unitId, ...r.filter((x) => x !== target.unitId)].slice(0, 5));
    setReceipt(t("unplaced.done", { value: sourceText(group?.value ?? ""), n: people.length, place: pathOf(target.unitId), before, after: before + people.length }));
    // Only the people just placed leave the pick: someone picked while it was being written stays picked.
    setSel((x) => new Set([...x].filter((id) => !people.some((p) => p.id === id))));
    setChosen("");
    setHeld(null);
  }, setHeld);
  const place = (unitId: string) => {
    const o = options.find((x) => x.unit.id === unitId);
    if (picked.length && o) placer.mutate({ people: picked, target: { unitId, entityId: o.entityId, workplaceId: o.workplaceId } });
  };
  const move = (step: number) => (setG(Math.max(0, Math.min(groups.length - 1, g + step))), setSel(new Set()));

  // Keys outside fields (spec section 3): J/K between groups, 1-5 place the picked people at that suggestion.
  const keys = useRef({ move, place, suggestions });
  useEffect(() => void (keys.current = { move, place, suggestions }));
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [role=combobox]")) return;
      if (e.key === "j" || e.key === "k") keys.current.move(e.key === "j" ? 1 : -1);
      const n = Number(e.key);
      if (n >= 1 && n <= 5 && keys.current.suggestions[n - 1]) keys.current.place(keys.current.suggestions[n - 1]!.unit.id);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [keys]);

  const open = new Set(groups.map((x) => x.value));
  const tabDone = [...new Set(placements.filter((d) => d.tab === tab && !open.has(d.value)).map((d) => d.value))].map((value) => {
    const ps = placements.filter((d) => d.tab === tab && d.value === value);
    // The first place with its count, then each person placed apart.
    const where = ps.map((d, i) => (i === 0 ? `${d.place} ${d.people.length}` : t("unplaced.alonePart", { n: d.people.length }))).join(" · ");
    return { value, count: ps.reduce((a, d) => a + d.people.length, 0), place: where, people: ps.flatMap((d) => d.people.map((e) => ({ e, place: d.place }))) };
  });
  const placedCount = placements.reduce((a, d) => a + d.people.length, 0);
  const name = (id: string) => { const e = entities.find((x) => x.id === id); return e ? entityNameText(e) : t("entity.name.unconfirmed"); };
  const parts = tabs.map((x) => t("unplaced.sumPart", { name: x === NONE ? t("unplaced.noEntity") : name(x), n: all.filter((e) => (e.legal_entity_id ?? NONE) === x).length })).join(" + ");
  return (
    <div className={s.page}>
      <PageHead
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("unplaced.crumbTodo")} />}
        title={t("unplaced.title")}
        meta={<PhaseLine phase={setup ? "setup" : "operating"}>{t(setup ? "unplaced.phaseSetup" : "unplaced.phaseOp")}</PhaseLine>}
        tools={
          <>
            {/* Counted only from an answered queue: a refused read never reads as nobody left. */}
            {queue.isSuccess && <span className={s.sum}>{t("unplaced.sum", { left: queue.data.count, parts, done: placedCount })}</span>}
            <Link to="/people" search={{}} className={buttonClass("ghost")}>{t("unplaced.back")}</Link>
          </>
        }
      />
      <CompanyMappings />
      <div role="group" aria-label={t("unplaced.tabs")} className={s.tabs}>
        {tabs.map((x) => (
          <ToggleButton key={x} pressed={x === tab} onClick={() => (setTab(x), setG(0), setSel(new Set()))}>
            {x === NONE ? t("unplaced.noEntity") : <EntityName entity={entities.find((e) => e.id === x)} />}
            <span className={s.count}>{all.filter((e) => (e.legal_entity_id ?? NONE) === x).length}</span>
          </ToggleButton>
        ))}
      </div>
      <QueryState q={queue}>
        {() =>
          all.length === 0 ? (
            <UnplacedDone placed={placedCount} />
          ) : (
            <div className={s.panes}>
              <UnplacedGroups groups={groups} done={tabDone} current={g} onPick={(i) => (setG(i), setSel(new Set()))} hint={(x) => { const a = suggest(x.value, options.map((o) => ({ unit: o.unit, text: placeText(units, o) })), []); const at = options.find((o) => o.unit.id === a[0]?.unit.id); return at ? t("unplaced.groupAlike", { name: at.site }) : t("unplaced.groupNone"); }} />
              <UnplacedRows group={group} sel={sel} onSel={setSel} done={tabDone} />
              <UnplacedTargets
                where={t("unplaced.target.where", { entity: entity ? entityNameText(entity) : t("unplaced.noEntity"), value: sourceText(group?.value ?? "") })}
                count={picked.length}
                suggestions={suggestions}
                options={options.map((o) => ({ id: o.unit.id, text: placeText(units, o), content: <PlacePath option={o} units={units} />, count: t("unplaced.target.count", { n: o.unit.headcount }) }))}
                sitePath={pathOf}
                chosen={chosen}
                onChoose={setChosen}
                onPlace={place}
                onSite={site ? () => place(site.unit.id) : null}
                onSkip={() => move(1)}
                pending={placer.isPending}
                entity={entity ? entityNameText(entity) : null}
                value={sourceText(group?.value ?? "")}
              />
            </div>
          )
        }
      </QueryState>
      <CommandError error={placer.error} />
      {held && <UnplacedRefused held={held} place={pathOf(held.target.unitId)} pending={placer.isPending} onRest={() => placer.mutate({ people: held.rest, target: held.target })} onCancel={() => setHeld(null)} />}
      {receipt && <div className={s.dock}><Receipt state="applied" message={receipt} onDismiss={() => setReceipt(null)} /></div>}
    </div>
  );
}
