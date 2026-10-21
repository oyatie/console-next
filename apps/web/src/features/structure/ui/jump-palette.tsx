import { useDeferredValue, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Building2, ClipboardPaste, FileText, MapPin, Network, Plus, UserPlus, UserRound } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { CommandPalette, type PaletteItem, type PaletteSection } from "../../../ui/command-palette/command-palette";
import { peopleSearchQuery } from "../api";
import { pathTo, type ChartNode } from "../domain/model";
import { findHits } from "../domain/search";
import { useStructure } from "./use-structure";

const ICON = { entity: Building2, site: MapPin, dept: Network, tenant: Network } as const;
const MAX = 6;

/**
 * ⌘K (spec S1-jump): entities, workplaces and departments by name or registration number, people by name or employee number (server), and
 * the tasks for the first place found. Enter on a place opens the chart there with it selected.
 */
export function JumpPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const { s } = useStructure();
  const people = useQuery({ ...peopleSearchQuery(query), enabled: query.length > 0 });
  const hits = useMemo(() => (s && query ? findHits(s, query).ids.map((id) => s.byId.get(id)!) : []), [s, query]);
  const go = (n: ChartNode) => {
    const at = n.kind === "dept" ? n.siteId : n.kind === "site" ? n.entityId : undefined;
    void navigate({ to: "/org", search: { focus: at, sel: n.id } });
  };
  const place = (n: ChartNode): PaletteItem => {
    const Icon = ICON[n.kind];
    const path = s ? pathTo(s, n.id).slice(1, -1).map((x) => x.name).join(" › ") : "";
    return { id: n.id, icon: <Icon size={16} aria-hidden />, label: n.name, detail: [path, n.kind === "entity" ? n.brn : undefined].filter(Boolean).join(" · "), meta: t("common.headcount", { count: n.headcount }), onAction: () => go(n) };
  };
  const first = hits.find((n) => n.kind === "site" || n.kind === "dept");
  const tasks: PaletteItem[] = [
    ...(first && s?.phase === "SETUP" ? [{ id: "task:add", icon: <Plus size={16} aria-hidden />, label: t("structure.jump.addUnder", { name: first.name }), detail: t("structure.level.dept"), onAction: () => void navigate({ to: "/org", search: { focus: first.id, sel: first.id } }) }] : []),
    ...(first?.unitId ? [{ id: "task:register", icon: <UserPlus size={16} aria-hidden />, label: t("structure.tools.registerLabel", { name: first.name }), onAction: () => void navigate({ to: "/people/new", search: { unit: first.unitId } }) }] : []),
    ...(first?.kind === "site" && first.entityId ? [{ id: "task:open", icon: <FileText size={16} aria-hidden />, label: t("structure.jump.open", { name: first.name }), onAction: () => void navigate({ to: "/org/entities/$id", params: { id: first.entityId! }, search: { wp: first.id } }) }] : []),
    { id: "task:entity", icon: <Plus size={16} aria-hidden />, label: t("structure.tools.addEntity"), onAction: () => void navigate({ to: "/org/entities/new" }) },
    { id: "task:paste", icon: <ClipboardPaste size={16} aria-hidden />, label: t("structure.setup.paste"), onAction: () => void navigate({ to: "/org", search: { view: "outline" } }) },
  ].filter((x) => !query || x.id !== "task:entity" || t("structure.tools.addEntity").includes(query));
  const sections: PaletteSection[] = [
    { id: "entity", title: t("structure.level.entity"), items: hits.filter((n) => n.kind === "entity").slice(0, MAX).map(place) },
    { id: "site", title: t("structure.level.site"), items: hits.filter((n) => n.kind === "site").slice(0, MAX).map(place) },
    { id: "dept", title: t("structure.level.dept"), items: hits.filter((n) => n.kind === "dept").slice(0, MAX).map(place) },
    {
      id: "people",
      title: t("structure.jump.people"),
      items: (people.data?.items ?? []).map((p) => ({
        id: `person:${p.id}`,
        icon: <UserRound size={16} aria-hidden />,
        label: p.name,
        detail: [p.org_unit, p.employee_number && t("structure.jump.number", { n: p.employee_number })].filter(Boolean).join(" · "),
        onAction: () => void navigate({ to: "/people/$id", params: { id: p.id } }),
      })),
    },
    { id: "tasks", title: t("structure.jump.tasks"), items: tasks },
  ];
  return (
    <CommandPalette
      open
      onClose={onClose}
      label={t("structure.jump.label")}
      placeholder={t("structure.jump.placeholder")}
      query={q}
      onQuery={setQ}
      sections={sections}
      empty={t("structure.find.none", { q: query })}
      footer={<span>{t("structure.jump.keys", { total: fmtNumber(hits.length) })}</span>}
    />
  );
}
