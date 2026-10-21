import { useId, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { t } from "@console/i18n";
import { depts, type Node } from "../../../reference/org/domain/structure";
import { TextInput } from "../../../ui/field/field";
import { TreeView } from "../../../ui/tree/tree";
import s from "./target-tree.module.css";

/**
 * The canonical pick-a-unit control (S6-merge, S8, org-21): one legal entity's workplaces and their departments, one to
 * choose, searchable by name (a match keeps the path down to it). A place that cannot take the change stays visible,
 * disabled, with its reason as text (`why`); other entities are not listed at all. `workplaces` says whether a
 * workplace itself can be chosen (a move can, a merge cannot).
 */
export function TargetTree({ label, entity, show, why, right, workplaces, value, onChange, hint }: {
  label: string;
  entity: Node;
  /** Which departments are listed (their sub-departments with them). */
  show: (n: Node) => boolean;
  why: (n: Node) => string | undefined;
  right: (n: Node) => string;
  workplaces: boolean;
  value: string | null;
  onChange: (id: string) => void;
  hint?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const q = query.trim().normalize("NFC");
  // A searched name keeps its whole path visible; everything else under it goes.
  const hit = (n: Node): boolean => !q || n.name.normalize("NFC").includes(q) || depts(n).filter(show).some(hit);
  const sites = entity.children.filter((w) => w.kind === "WORKPLACE" && !w.chips.includes("closed") && hit(w));
  const kids = (n: Node): Node[] => (n.kind === "LEGAL_ENTITY" ? sites : depts(n).filter((c) => show(c) && hit(c)));
  const all = [entity, ...sites.flatMap(function walk(n: Node): Node[] { return [n, ...kids(n).flatMap(walk)]; })];
  const [expanded, setExpanded] = useState(() => new Set(all.map((n) => n.id)));
  const reason = (n: Node) => (n.kind === "LEGAL_ENTITY" ? undefined : why(n));
  const disabled = new Set(all.filter((n) => n.kind === "LEGAL_ENTITY" || (n.kind === "WORKPLACE" && !workplaces) || reason(n)).map((n) => n.id));
  return (
    <div className={s.box}>
      <span className="field__label">{label}</span>
      <label htmlFor={searchId} className="sr-only">{t("orgUnit.target.search", { label })}</label>
      <TextInput id={searchId} type="search" value={query} placeholder={t("orgUnit.target.searchHint")} onChange={(e) => setQuery(e.target.value)} />
      {sites.length === 0 && <p className={s.hint}>{t("orgUnit.target.noMatch", { query: q })}</p>}
      <div className={s.list}>
        <TreeView
          label={label}
          roots={[entity]}
          childrenOf={kids}
          textValue={(n) => [n.name, reason(n) ?? (n.kind === "LEGAL_ENTITY" ? "" : right(n))].filter(Boolean).join(" ")}
          row={(n) => (
            <span className={s.row} data-kind={n.kind} data-checked={value === n.id || undefined}>
              {n.kind !== "LEGAL_ENTITY" && <span className={s.dot} aria-hidden />}
              <span className={n.kind === "DEPARTMENT" ? undefined : s.strong}>{n.name}</span>
              {n.kind !== "LEGAL_ENTITY" && <span className={s.right}>{reason(n) ?? right(n)}</span>}
            </span>
          )}
          selected={value ?? undefined}
          onSelect={(id) => id && !disabled.has(id) && onChange(id)}
          expanded={q ? new Set(all.map((n) => n.id)) : expanded}
          onExpandedChange={setExpanded}
          disabled={disabled}
        />
      </div>
      {hint != null && <p className={s.hint}><Info size={14} aria-hidden />{hint}</p>}
    </div>
  );
}
