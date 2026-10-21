import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Network } from "lucide-react";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { SearchField } from "../../../ui/search/search-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { TreeView } from "../../../ui/tree/tree";
import { orgStructureRef } from "../../../reference/entity/api";
import { filterRows, find, flatten, nodeScope, offered, reach, scopeKind, type KindRule, type OrgKind, type OrgNode, type Scope } from "../domain/scope";
import { scopeLabel } from "../present";
import s from "./access.module.css";

/** The tree's top row: the whole company, over every legal entity. */
const TENANT = "tenant";
type Item = { id: string; name: string; headcount: number; kind: OrgKind | "TENANT"; children: Item[] };
const below = (n: Item): string[] => n.children.flatMap((c) => [c.id, ...below(c)]);

/** The scope a line has, as its button shows it: the place and today's headcount, or the call to pick one (mockup M4). */
export function ScopeButton({ id, value, error, onOpen }: { id: string; value: Scope | null; error?: string; onOpen: () => void }) {
  const tree = useQuery(orgStructureRef);
  const roots = (tree.data?.entities ?? []) as OrgNode[];
  return (
    <div className={s.stack}>
      <span id={`${id}-l`} className="sr-only">{t("access.grant.scope")}</span>
      <Button id={id} className={s.pick} data-empty={value ? undefined : true} aria-labelledby={`${id}-l ${id}`} aria-haspopup="dialog" aria-invalid={error ? true : undefined} onClick={onOpen}>
        <Network size={16} aria-hidden />
        <span>{value ? scopeLabel(roots, value) : t("access.scope.pick")}</span>
        <ChevronDown size={14} aria-hidden className={s.chev} />
      </Button>
      {error && <span className="field__error">{error}</span>}
    </div>
  );
}

/**
 * scope (mockup M3): whole company or one node of the entity > workplace tree, always with the units below (marked included). Only kinds
 * the server enforces are offered (the catalog's scope_kinds; departments wait for the door re-key), so no pick is refused later.
 */
function ScopeTree({ rules, value, onChange }: { rules: readonly KindRule[]; value: Scope | null; onChange: (v: Scope) => void }) {
  const tree = useQuery(orgStructureRef);
  const [q, setQ] = useState("");
  const all = (tree.data?.entities ?? []) as OrgNode[];
  const roots = offered(all, rules);
  const tenantOk = rules.some((r) => r.kind === "TENANT" && r.enforceable);
  const top: Item[] = tenantOk ? [{ id: TENANT, name: t("access.scope.tenant"), headcount: reach(all, { kind: "TENANT", include_descendants: true }) ?? 0, kind: "TENANT", children: roots }] : roots;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(flatten(top as OrgNode[]).filter((r) => r.node.children.length).map((r) => r.node.id)));
  const shown = new Set([TENANT, ...filterRows(flatten(roots), q).map((r) => r.node.id)]);
  const selected = value?.kind === "TENANT" ? TENANT : (value?.node_id ?? undefined);
  const sel = selected ? flatten(top as OrgNode[]).find((r) => r.node.id === selected)?.node : undefined;
  const included = new Set(sel ? below(sel as Item) : []);
  return (
    <div className={s.stack}>
      <SearchField label={t("access.scope.search")} value={q} onChange={setQ} />
      <div className={s.tree}>
        <TreeView
          label={t("access.scope.tree")}
          roots={top.filter((r) => shown.has(r.id))}
          childrenOf={(n) => n.children.filter((c) => shown.has(c.id))}
          textValue={(n) => `${n.name} ${n.kind === "TENANT" ? "" : t(`access.scope.kind.${scopeKind(n.kind)}`)} ${t("access.people", { count: n.headcount })}`}
          row={(n) => (
            <span className={s.node}>
              <span className={s.kind}>{n.kind === "TENANT" ? "" : t(`access.scope.kind.${scopeKind(n.kind)}`)}</span>
              <span>{n.name}</span>
              {included.has(n.id) && <Chip>{t("access.scope.included")}</Chip>}
              <span className={s.count}>{t("access.people", { count: n.headcount })}</span>
            </span>
          )}
          selected={selected}
          onSelect={(id) => {
            if (id === TENANT) return onChange({ kind: "TENANT", node_id: null, include_descendants: true });
            const n = id ? find(roots, id)?.node : undefined;
            if (n) onChange(nodeScope(n));
          }}
          expanded={q ? shown : expanded}
          onExpandedChange={setExpanded}
        />
      </div>
    </div>
  );
}

/** What a pick covers, in the sheet's foot: the place with today's headcount, then the units it brings along. */
function Summary({ value }: { value: Scope | null }) {
  const tree = useQuery(orgStructureRef);
  if (!value) return <span className="muted">{t("access.scope.none")}</span>;
  const all = (tree.data?.entities ?? []) as OrgNode[];
  const count = reach(all, value) ?? 0;
  const node = value.node_id ? find(all, value.node_id)?.node : undefined;
  const names = (value.kind === "TENANT" ? all : (node?.children ?? [])).map((c) => c.name);
  return (
    <>
      <strong>{value.kind === "TENANT" ? t("access.scope.summary.tenant", { count }) : t("access.scope.summary", { name: node?.name ?? "", count })}</strong>
      <span className="muted">{names.length ? t("access.scope.summary.below", { names: names.join(", ") }) : t("access.scope.summary.leaf")}</span>
    </>
  );
}

/**
 * Picking a scope as its own sheet view (mockup M3): the grant sheet hands over to it and gets it back, so no sheet ever
 * sits over another (design §9.1). `subtitle` names whose line is being scoped. Cancel keeps the line's scope.
 */
export function ScopeSheet({ rules, value, subtitle, onDone, onCancel }: { rules: readonly KindRule[]; value: Scope | null; subtitle: string; onDone: (v: Scope) => void; onCancel: () => void }) {
  const tree = useQuery(orgStructureRef);
  const [pick, setPick] = useState<Scope | null>(value);
  return (
    <Sheet
      open
      wide
      title={t("access.scope.pick")}
      subtitle={subtitle}
      onClose={onCancel}
      consequence={<Summary value={pick} />}
      actions={
        <>
          <Button variant="ghost" onClick={onCancel}>{t("access.cancel")}</Button>
          <Button variant="primary" disabled={!pick} onClick={() => pick && onDone(pick)}>{t("access.scope.done")}</Button>
        </>
      }
    >
      <QueryState q={tree}>{() => <ScopeTree rules={rules} value={pick} onChange={setPick} />}</QueryState>
    </Sheet>
  );
}
