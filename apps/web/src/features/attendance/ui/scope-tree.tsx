import { useMemo, useState } from "react";
import { t } from "@console/i18n";
import { Link } from "@tanstack/react-router";
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

/** The server resolves inheritance on the tree's date, including an absent winner. */
const holds = (n: TreeNode) =>
  n.layer?.pattern_name ?? (n.effective
    ? t("attendanceSchedule.tree.inherited", { pattern: n.effective.pattern_name, from: t(`attendance.level.${n.effective.from}`) })
    : n.unscheduled ? null : t("attendanceSchedule.tree.noSchedule"));

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
          keyboardNavigationBehavior="tab"
          textValue={(n) => [n.name, holds(n), peopleText(n.people), n.unscheduled ? t("attendanceSchedule.tree.missing", { count: n.unscheduled }) : null].filter(Boolean).join(" · ")}
          row={(n) => (
            <div className={s.treeRow}>
              <div className={s.treeName}>{n.name}</div>
              {holds(n) && <span className={n.layer || n.effective ? "muted" : "t-warn"}>{holds(n)}</span>}
              <span className="muted">{peopleText(n.people)}</span>
              {(n.unscheduled ?? 0) > 0 && (n.kind === "WORKPLACE" || n.kind === "DEPARTMENT"
                ? <Link className="link t-warn" to="/attendance" search={{ tab: "day", date: tree.date, unscheduled: true, wp: n.kind === "WORKPLACE" ? n.id : n.workplace_id ?? undefined, unit: n.kind === "DEPARTMENT" ? n.id : undefined }}>{t("attendanceSchedule.tree.missing", { count: n.unscheduled! })}</Link>
                : <span className="t-warn">{t("attendanceSchedule.tree.missing", { count: n.unscheduled! })}</span>)}
            </div>
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
      {tree.people_unscheduled === 0 && <p className="muted">{t("attendanceSchedule.tree.allScheduled", { people: peopleText(tree.people_total) })}</p>}
    </div>
  );
}
