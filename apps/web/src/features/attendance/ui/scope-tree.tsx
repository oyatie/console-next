import { useMemo, useState } from "react";
import { t } from "@console/i18n";
import { EmptyState } from "../../../ui/empty-state";
import { Button } from "../../../ui/button/button";
import { SearchField } from "../../../ui/search/search-field";
import { TreeView } from "../../../ui/tree/tree";
import type { ScheduleTree } from "../api";
import { buildTree, pathTo, type TreeNode } from "../domain/tree";
import { peopleText } from "../present";
import { PersonScope } from "./person-scope";
import { inField, useKeys } from "./use-keys";
import s from "./attendance.module.css";

/** What a node holds: its own layer, else what it follows (the level above decides). */
const holds = (n: TreeNode) =>
  n.layer?.pattern_name ?? t(n.kind === "LEGAL_ENTITY" ? "attendanceSchedule.tree.noEntityDefault" : n.kind === "WORKPLACE" ? "attendanceSchedule.tree.followsEntity" : "attendanceSchedule.tree.followsWorkplace");

/**
 * The scope tree of A2 calendar (legal entity › workplace › department, crew under their workplace): each row says what decides its work schedule.
 * `/` jumps to the find box; a search keeps the matches and the way to them, and an empty result offers a filter reset.
 */
export function ScopeTree({ tree, selected, onSelect, onPerson }: { tree: ScheduleTree; selected?: string; onSelect: (n: TreeNode) => void; onPerson: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const found = useMemo(() => buildTree(tree.nodes as TreeNode[], query), [tree.nodes, query]);
  const all = useMemo(() => buildTree(tree.nodes as TreeNode[]), [tree.nodes]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(selected ? pathTo(all.byId, selected) : all.roots.map((r) => r.id)));
  // A search opens every kept node, so a match is never folded away.
  const shown = query ? new Set(found.byId.keys()) : expanded;
  // `/` jumps to the find box while focus is in the tree column.
  const keys = useKeys<HTMLDivElement>((e) => {
    if (e.key !== "/" || inField(e)) return false;
    (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("input[type=search]")?.focus();
    return true;
  });
  return (
    <div ref={keys} className={s.treeCol}>
      <SearchField label={t("attendanceSchedule.tree.find")} value={query} onChange={setQuery} />
      <PersonScope onPerson={onPerson} />
      {found.roots.length === 0 ? (
        <EmptyState title={t("attendanceSchedule.tree.noMatch")} reason={t("attendanceSchedule.tree.noMatch.reason", { query })} actions={<Button size="sm" onClick={() => setQuery("")}>{t("attendanceSchedule.tree.clear")}</Button>} />
      ) : (
        <TreeView
          label={t("attendanceSchedule.tree.label")}
          roots={found.roots}
          childrenOf={found.childrenOf}
          textValue={(n) => n.name}
          row={(n) => (
            <span className={s.treeRow}>
              <span className={s.grow}>{n.name}</span>
              <span className="muted">{holds(n)}</span>
            </span>
          )}
          selected={selected}
          onSelect={(id) => {
            const n = id ? all.byId.get(id) : undefined;
            if (n) onSelect(n);
          }}
          expanded={shown}
          onExpandedChange={setExpanded}
        />
      )}
      <p className="muted">
        {tree.people_unscheduled > 0 ? t("attendanceSchedule.tree.unscheduled", { count: tree.people_unscheduled }) : t("attendanceSchedule.tree.allScheduled", { people: peopleText(tree.people_total) })}
      </p>
    </div>
  );
}
