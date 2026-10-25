import { ArrowDown, ArrowUp } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { reorder, STRUCTURE_READS } from "../api";
import { moved, orderOf } from "../domain/order";
import type { Node } from "../domain/structure";
import css from "./structure.module.css";

/**
 * Reorder one child (review R15): one place up or down among its siblings, at once in either phase (a label,
 * never a version bump). The order drives the structure read, the lists and the chart. A sibling list or order
 * changed by someone else meanwhile is refused (children_changed, pinned to the order read) and says to reopen.
 */
export function OrderButtons({ parent, node, kind, editing = false }: { parent: Node; node: Node; kind: "WORKPLACE" | "DEPARTMENT"; editing?: boolean }) {
  const { parent: key, ids } = orderOf(parent, kind);
  const at = ids.indexOf(node.id);
  const move = useCommand({
    run: (step: -1 | 1, k: string) => reorder(k, { ...key, children: moved(ids, node.id, step), expected_children: ids }),
    invalidates: STRUCTURE_READS,
    announce: (_, step) => t(step < 0 ? "orgStructure.order.upDone" : "orgStructure.order.downDone", { name: node.name }),
  });
  if (!editing || ids.length < 2 || at < 0) return null;
  return (
    <span className={css.order}>
      {at > 0 && <Button variant="ghost" className="btn--sm" disabled={move.isPending} onClick={() => move.mutate(-1)} aria-label={t("orgStructure.order.up", { name: node.name })}><ArrowUp size={14} aria-hidden /></Button>}
      {at < ids.length - 1 && <Button variant="ghost" className="btn--sm" disabled={move.isPending} onClick={() => move.mutate(1)} aria-label={t("orgStructure.order.down", { name: node.name })}><ArrowDown size={14} aria-hidden /></Button>}
      <CommandError error={move.error} />
    </span>
  );
}
