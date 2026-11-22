// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { inOrder } from "../../../lib/pure/in-order";
import { todayKst } from "../../../lib/pure/today";
import { readGroup } from "../../../lib/react/query-view";
import { useKeys } from "../../../lib/react/use-keys";
import { checklistRef, entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { entityNameText } from "../../../reference/entity/present";
import { unitsQuery } from "../../../reference/org/api";
import { isDate } from "../../../ui/date/days";
import { placeOptions } from "../domain/register-place";
import { groupBySource, suggest } from "../domain/unplaced";
import { placeText, sourceText } from "../present";
import { PlacePath } from "./place-path";
import { usePlacePeople, type Held, type Placed } from "./use-place-people";
import { personOf, useUnplacedQueue } from "./use-unplaced-queue";

type Employee = components["schemas"]["Employee"];
export const UNPLACED_NONE = "none";

export function useUnplacedWorkspace() {
  const queue = useUnplacedQueue();
  const unitsQ = useQuery({ ...unitsQuery, refetchOnMount: "always" });
  const units = unitsQ.data?.items ?? [];
  const entitiesQ = useQuery(entitiesRef);
  const entities = entitiesQ.data?.items ?? [];
  const structureQ = useQuery({ ...orgStructureRef, retry: false });
  const roots = structureQ.data?.entities ?? [];
  const checklistQ = useQuery({ ...checklistRef, retry: false });
  const setup = checklistQ.data?.phase === "SETUP";
  const [date, setDate] = useState("");
  const [invalidDate, setInvalidDate] = useState(false);
  const today = todayKst();
  const all = (queue.data?.items ?? []).map(personOf);
  const ids = [...new Set(all.map((e) => e.legal_entity_id ?? UNPLACED_NONE))];
  const tabs = [...inOrder(ids.filter((id) => id !== UNPLACED_NONE), entities.map((e) => e.id)), ...ids.filter((id) => id === UNPLACED_NONE)];
  const [tabPick, setTab] = useState<string | null>(null);
  const tab = tabPick && tabs.includes(tabPick) ? tabPick : (tabs[0] ?? UNPLACED_NONE);
  const entity = entities.find((e) => e.id === tab);
  const groups = groupBySource(all.filter((e) => (e.legal_entity_id ?? UNPLACED_NONE) === tab));
  const [gValue, setGValue] = useState<string | null>(null);
  const found = groups.findIndex((x) => x.value === gValue);
  const g = found >= 0 ? found : 0;
  const setG = (i: number) => setGValue(groups[i]?.value ?? null);
  const group = groups[g];
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [placements, setPlacements] = useState<{ tab: string; value: string; people: Employee[]; place: string }[]>([]);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
  const options = placeOptions(units, roots, entities, null).filter((o) => tab === UNPLACED_NONE || o.entityId === tab);
  const pathOf = (id: string) => {
    const o = options.find((x) => x.unit.id === id);
    return o ? placeText(units, o).split(" › ").slice(1).join(" › ") : "";
  };
  const suggestions = group ? suggest(group.value, options.map((o) => ({ unit: o.unit, text: placeText(units, o) })), recent) : [];
  const picked = group?.people.filter((e) => sel.has(e.id)) ?? [];
  const sites = options.filter((o) => o.unit.kind === "SITE");
  const top = options.find((o) => o.unit.id === suggestions[0]?.unit.id);
  const site = sites.find((o) => top?.workplaceId && o.workplaceId === top.workplaceId) ?? (sites.length === 1 ? sites[0] : undefined);

  const placer = usePlacePeople(({ people, target, effectiveDate }: Placed) => {
    const unit = units.find((u) => u.id === target.unitId);
    const before = unit?.headcount ?? 0;
    const scheduled = effectiveDate > today;
    if (group && !scheduled) setPlacements((d) => [...d, { tab, value: group.value, people, place: pathOf(target.unitId) }]);
    setRecent((r) => [target.unitId, ...r.filter((x) => x !== target.unitId)].slice(0, 5));
    setReceipt(
      scheduled
        ? t("unplaced.scheduled", { n: people.length, place: pathOf(target.unitId), date: fmtDate(effectiveDate) })
        : t("unplaced.done", { value: sourceText(group?.value ?? ""), n: people.length, place: pathOf(target.unitId), before, after: before + people.length }),
    );
    setSel((x) => new Set([...x].filter((id) => !people.some((p) => p.id === id))));
    setChosen("");
    setHeld(null);
  }, setHeld);

  const place = (unitId: string) => {
    const o = options.find((x) => x.unit.id === unitId);
    if (picked.length && o && checklistQ.isSuccess && (setup || (isDate(date) && !invalidDate))) {
      placer.mutate({ people: picked, target: { unitId, entityId: o.entityId, workplaceId: o.workplaceId }, setup, effectiveDate: setup ? today : date });
    }
  };
  const move = (step: number) => (setG(Math.max(0, Math.min(groups.length - 1, g + step))), setSel(new Set()));

  useKeys({
    "unplaced.next": () => move(1),
    "unplaced.prev": () => move(-1),
    "unplaced.place": (_, n) => {
      const suggestion = suggestions[Number(n) - 1];
      if (suggestion) place(suggestion.unit.id);
    },
  });

  const open = new Set(groups.map((x) => x.value));
  const tabDone = [...new Set(placements.filter((d) => d.tab === tab && !open.has(d.value)).map((d) => d.value))].map((value) => {
    const ps = placements.filter((d) => d.tab === tab && d.value === value);
    const where = ps.map((d, i) => (i === 0 ? `${d.place} ${d.people.length}` : t("unplaced.alonePart", { n: d.people.length }))).join(" · ");
    return { value, count: ps.reduce((a, d) => a + d.people.length, 0), place: where, people: ps.flatMap((d) => d.people.map((e) => ({ e, place: d.place }))) };
  });
  const placedCount = placements.reduce((a, d) => a + d.people.length, 0);
  const name = (id: string) => {
    const e = entities.find((x) => x.id === id);
    return e ? entityNameText(e) : t("entity.name.unconfirmed");
  };
  const parts = tabs.map((x) => t("unplaced.sumPart", { name: x === UNPLACED_NONE ? t("unplaced.noEntity") : name(x), n: all.filter((e) => (e.legal_entity_id ?? UNPLACED_NONE) === x).length })).join(" + ");

  return {
    queue,
    pageRead: readGroup([queue, unitsQ, entitiesQ, structureQ, checklistQ]),
    units,
    entities,
    setup,
    today,
    date,
    setDate,
    invalidDate,
    setInvalidDate,
    all,
    tabs,
    tab,
    selectTab: (next: string) => (setTab(next), setGValue(null), setSel(new Set())),
    entity,
    groups,
    g,
    pickGroup: (i: number) => (setG(i), setSel(new Set())),
    group,
    sel,
    setSel,
    chosen,
    setChosen,
    tabDone,
    placedCount,
    receipt,
    setReceipt,
    held,
    setHeld,
    placer,
    place,
    move,
    pathOf,
    suggestions,
    picked,
    site,
    parts,
    blockReason: !setup && (!isDate(date) || invalidDate) ? t("unplaced.disabled.date") : picked.length === 0 ? t("unplaced.disabled.pick") : null,
    targetOptions: options.map((o) => ({ id: o.unit.id, text: placeText(units, o), content: PlacePath({ option: o, units }), count: t("unplaced.target.count", { n: o.unit.headcount }) })),
    groupHint: (x: (typeof groups)[number]) => {
      const a = suggest(x.value, options.map((o) => ({ unit: o.unit, text: placeText(units, o) })), []);
      const at = options.find((o) => o.unit.id === a[0]?.unit.id);
      return at ? t("unplaced.groupAlike", { name: at.site }) : t("unplaced.groupNone");
    },
  };
}
