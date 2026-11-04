import { EntityName } from "../../../reference/entity/ui/entity-name";
import { useEffect, useMemo, useState } from "react";
import { Building2, ChevronDown, ChevronRight, MapPin, Network, PencilLine } from "lucide-react";
import { t } from "@console/i18n";
import { Button, ToggleButton } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { Muted } from "../../../ui/muted/muted";
import { place } from "../../../ui/org-canvas/place";
import { HeadcountBasis } from "../../../reference/org/ui/headcount-basis";
import { type ChartNode, type Structure } from "../domain/model";
import { registryRows, vacantHeads, type Level, type ListFilter } from "../domain/registry";
import { temporalLabel, unitCounts } from "../present";
import { AddUnit } from "./add-unit";
import { InlineUnitInput, type OutlineEdit } from "./outline-rows";
import { HeadCell, OrderCell, RegistryActions, RegistryFilters } from "./registry-bar";
import { useStructureGesturesBare } from "./use-outline-edit";
import type { Commands } from "./use-structure-commands";
import css from "./chart.module.css";

const ICON = { entity: Building2, site: MapPin, dept: Network } as const;

/**
 * list (spec S2-registry): every level in one table, "all levels" as an indented tree or one level flat, a find and
 * quick filters that keep each hit's path, the same selection as the chart with its acts, each level's head and a
 * department's code (CS-BE), direct/total people, and the rows as an org sheet. A workplace's manager is not served;
 * the table says nothing it cannot show.
 */
export function RegistryView({ s, cmd, sel, onSelect, onVisibleRows }: { s: Structure; cmd: Commands; sel: ReadonlySet<string>; onSelect: (ids: ReadonlySet<string>) => void; onVisibleRows?: (rows: readonly ChartNode[]) => void }) {
  const g = useStructureGesturesBare(s, cmd);
  const [edit, setEdit] = useState<OutlineEdit | null>(null);
  const [level, setLevel] = useState<Level>("all");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<ReadonlySet<ListFilter>>(new Set());
  // Every row starts open (the mockup's "all levels"); folding is per row.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const open = { has: (id: string) => !closed.has(id) };
  const none = t("entityOps.info.none");
  const rows = useMemo(() => registryRows(s, { level, q, filters, closed }), [s, level, q, filters, closed]);
  useEffect(() => { onVisibleRows?.(rows); }, [onVisibleRows, rows]);
  const toggle = (id: string) => setClosed((o) => (o.has(id) ? new Set([...o].filter((x) => x !== id)) : new Set([...o, id])));
  const editTarget = edit ? s.byId.get(edit.kind === "new" ? edit.parent : edit.id) : undefined;
  const columns: LongColumn<ChartNode>[] = [
    {
      id: "name",
      rowHeader: true,
      card: "title",
      width: "3fr",
      minWidth: 232,
      header: t("structure.list.name"),
      cell: (n) => {
        const Icon = n.kind === "tenant" ? Network : ICON[n.kind];
        return (
          <span className={css.treeCell} ref={place({ "padding-left": level === "all" ? (n.depth - 1) * 16 : 0 })}>
            {level === "all" && n.children.length > 0 ? (
              <Button variant="ghost" className={css.chev} aria-expanded={open.has(n.id)} aria-label={t(open.has(n.id) ? "structure.node.collapseLabel" : "structure.node.expandLabel", { name: n.name })} onClick={() => toggle(n.id)}>
                {open.has(n.id) ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              </Button>
            ) : <span className={css.chev} />}
            {n.kind !== "dept" && <Icon size={14} aria-hidden />}
            <span className={n.kind === "dept" ? undefined : css.strong} onDoubleClick={() => g.canEdit && n.kind === "dept" && setEdit({ kind: "rename", id: n.id })}>{n.kind === "entity" ? <EntityName name={n.name} alias={n.alias} /> : n.name}</span>
            {temporalLabel(n) && <Chip>{temporalLabel(n)}</Chip>}
            {n.headOffice && <Chip>{t("structure.node.headOffice")}</Chip>}
            {n.primary && <Chip>{t("structure.node.primary")}</Chip>}
          </span>
        );
      },
    },
    { id: "code", card: "fact", width: 88, header: t("structure.list.code"), cell: (n) => (n.code ? <span className="code">{n.code}</span> : none) },
    // The head a level has: a legal entity's representatives, a department's head (a workplace's manager is not served).
    {
      id: "head",
      card: "fact",
      width: 160,
      header: t("structure.list.head"),
      cell: (n) =>
        n.kind === "entity" ? (n.reps ? t("structure.node.reps", { name: n.reps.first, more: n.reps.more }) : none)
        : n.kind === "dept" ? <HeadCell n={n} readOnly={s.readOnly} />
        : none,
    },
    { id: "people", card: "fact", cardHeader: t("structure.list.people"), width: 142, header: <HeadcountBasis>{t("structure.list.people")}</HeadcountBasis>, cell: (n) => <span className="num">{unitCounts(n)}</span> },
    { id: "site", card: "omit", width: 120, header: t("orgUnit.fact.place"), cell: (n) => n.kind === "site" ? n.name : n.siteId ? s.byId.get(n.siteId)?.name ?? none : none },
    { id: "chips", card: "status", width: "2fr", minWidth: 112, header: t("structure.list.chips"), cell: (n) => n.chips.length ? <span className="row">{n.chips.map((c) => <Chip key={c} tone="warn">{t(`structure.chip.${c}`)}</Chip>)}</span> : null },
    ...(!s.readOnly ? [{ id: "order", card: "action" as const, width: 64, header: t("structureChart.list.order"), cell: (n: ChartNode) => <OrderCell s={s} n={n} order={cmd.order} /> }] : []),
    ...(!s.readOnly ? [{
      id: "add",
      card: "action" as const,
      width: 196,
      header: t("orgStructure.tab.actions"),
      cell: (n: ChartNode) => (
        <span className={css.orderCell}>
          {g.canEdit && n.kind === "dept" && (
            <Button
              size="sm"
              icon
              variant="ghost"
              aria-label={`${n.name} ${t("orgUnit.rename.action")}`}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
              onKeyUp={(e) => { if (e.key === "Enter" || e.key === " ") e.stopPropagation(); }}
              onClick={(e) => { e.stopPropagation(); setEdit({ kind: "rename", id: n.id }); }}
            >
              <PencilLine size={14} aria-hidden />
            </Button>
          )}
          <AddUnit n={n} onAdd={g.canEdit ? () => { setClosed((o) => new Set([...o].filter((x) => x !== n.id))); setEdit({ kind: "new", parent: n.id }); } : undefined} />
        </span>
      ),
    }] : []),
  ];
  return (
    <div className={css.registry}>
      <div className={css.registryBar}>
        <div className={`${css.seg} card`} role="group" aria-label={t("structure.list.levels")}>
          {(["all", "entity", "site", "dept"] as const).map((l) => (
            <ToggleButton key={l} pressed={level === l} onClick={() => setLevel(l)}>
              {l === "all" ? t("structure.list.all") : t("structure.list.levelCount", { level: t(`structure.level.${l}`), count: s.counts[l === "entity" ? "entities" : l === "site" ? "sites" : "depts"] })}
            </ToggleButton>
          ))}
        </div>
        <RegistryFilters s={s} rows={rows} filters={filters} onFilters={setFilters} vacancyCount={vacantHeads(s).count} />
      </div>
      {edit && editTarget && (
        <Card look="outline" density="dense">
          <div className={css.registryBar}>
            <Muted>{edit.kind === "new" ? t("structure.outline.newUnder", { parent: editTarget.name }) : editTarget.name}</Muted>
            {edit.kind === "new" ? (
              <InlineUnitInput key={`new-${editTarget.id}`} setup={g.setup} asOf={s.asOf} parent={editTarget} pending={cmd.pending} onSave={(name, date, done) => g.create(editTarget, name, date, done)} onDone={() => setEdit(null)} />
            ) : (
              <InlineUnitInput key={`rename-${editTarget.id}`} setup={g.setup} asOf={s.asOf} parent={s.byId.get(editTarget.parentId!)!} renaming={editTarget} pending={cmd.pending} onSave={(name, date, done) => g.rename(editTarget, name, date, () => { done(); setEdit(null); })} onDone={() => setEdit(null)} />
            )}
          </div>
        </Card>
      )}
      <LongTable
        label={t("structure.list.label")}
        caption={<span className={css.registryCaption}>{t("structure.list.caption", { count: rows.length })}</span>}
        columns={columns}
        rows={rows}
        rowId={(n) => n.id}
        total={rows.length}
        hasMore={false}
        onLoadMore={() => undefined}
        density="compact"
        empty={q ? t("structure.find.none", { q }) : t("structureChart.list.none")}
        find={{ label: t("structure.find.placeholder"), onFind: setQ, defaultValue: q }}
        selection={{ kind: "ids", ids: sel }}
        onSelectionChange={(x) => x.kind === "ids" && onSelect(x.ids)}
        selectionActions={sel.size > 0 && <RegistryActions s={s} sel={sel} />}
      />
    </div>
  );
}
