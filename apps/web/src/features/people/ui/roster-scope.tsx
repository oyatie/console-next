import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronDown, Layers, MapPin, Network } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { entitiesRef, orgStructureRef } from "../../../reference/entity/api";
import { entityName } from "../../../reference/entity/domain/names";
import { unitsQuery } from "../../../reference/org/api";
import { PathList } from "../../../ui/path-list/path-list";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { workplaceCountsQuery } from "../api/record";
import { scopeRows } from "../domain/scope";
import s from "./roster.module.css";

const ICON = [Building2, MapPin, Network, Network] as const;
const ALL = "all";

/**
 * The roster's scope (E1-scope): everyone in the reader's grant, one legal entity, one workplace or one department with everything under
 * it, picked from the structure with each node's headcount (the exited not counted). Typing narrows the tree.
 */
export function RosterScope({ value, onChange }: { value?: string; onChange: (v: string | null) => void }) {
  // The structure node carries the legal name only; the entity record gives the name every other surface shows (0h). The
  // node's legal name stands in only once the records have come back without that entity, never while their first read is in flight.
  const recordsQ = useQuery(entitiesRef);
  const records = recordsQ.data?.items ?? [];
  const entities = (useQuery(orgStructureRef).data?.entities ?? []).map((e) => ({ id: e.id, name: entityName(records.find((r) => r.id === e.id)) || (recordsQ.isLoading ? "" : e.name), workplaces: e.children.filter((w) => w.kind === "WORKPLACE").map((w) => ({ id: w.id, name: w.name, orgUnitId: w.org_unit_id })) }));
  const units = useQuery(unitsQuery).data?.items ?? [];
  // Headcount = active + on leave (G2): the counts leave out the exited and those starting later, as the status chips do.
  const facets = useQuery(workplaceCountsQuery(undefined, ["ACTIVE", "ON_LEAVE"])).data;
  const all = scopeRows(entities, units, facets?.legal_entity ?? [], facets?.workplace ?? []);
  const current = all.find((r) => r.value === value);
  const total = facets?.total ?? 0;
  const name = current?.name ?? t("roster.scope.all");
  return (
    <PopoverButton wide label={t("roster.scope.open", { scope: name })} trigger={<><Layers size={14} aria-hidden /> {t("roster.scope.label")} <b>{name}</b> <ChevronDown size={14} aria-hidden /></>} title={t("roster.scope.title")}>
      {(close) => {
        const pick = (v: string | null) => (onChange(v), close());
        return (
          <div className={s.scopePick}>
            <PathList
              label={t("roster.scope.title")}
              searchLabel={t("roster.scope.find")}
              placeholder={t("roster.scope.find")}
              value={value ?? ALL}
              onChange={(v) => pick(v === ALL ? null : v)}
              items={[
                { id: ALL, name: t("roster.scope.all"), depth: 0, note: fmtNumber(total) },
                ...all.map((r) => {
                  const Icon = ICON[r.depth];
                  const meta = r.meta && t("roster.scope.meta", { sites: r.meta.sites ?? 0, units: r.meta.units ?? 0 });
                  return { id: r.value, name: r.name, depth: r.depth, icon: <Icon size={14} aria-hidden />, note: [meta, r.count === undefined ? "" : fmtNumber(r.count)].filter(Boolean).join(" · ") };
                }),
              ]}
            />
            {/* G8: the arithmetic on screen — the companies add up to everyone. */}
            <p className={s.said}>{t("roster.scope.sum", { list: all.filter((r) => r.depth === 0).map((r) => fmtNumber(r.count ?? 0)).join(" + "), n: fmtNumber(total) })}</p>
          </div>
        );
      }}
    </PopoverButton>
  );
}
