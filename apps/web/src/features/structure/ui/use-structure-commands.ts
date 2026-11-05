import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutationState } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { governed, inlineUnitBody, changeReceipt, STRUCTURE_READS, type InlineUnitSpec } from "../../../reference/org/api";
import { noteChange } from "../../../reference/org/ui/use-change-note";
import { applyBatch, reorder, undoBatch, type ReorderRequest, type SetupOp } from "../api";

/**
 * `moved`: the units a move landed and where they came from (each box is marked "just moved" until the receipt goes).
 * A setup batch is undone by its `batchId`; a reorder by `back`, the order it replaced pinned to the one it left.
 */
export type Applied = { batchId?: string; back?: ReorderRequest; message: string; undone?: boolean; moved?: ReadonlyMap<string, string> };
type Change = { ops: SetupOp[]; message: string; onDone?: (unitIds: string[]) => void; moved?: ReadonlyMap<string, string> };

/**
 * The setup writes behind every gesture (add, rename, move, delete; one or many): one batch each, applied at once,
 * with the latest receipt kept for undo until it is dismissed or replaced (D18). The failed change stays in
 * `error` for the screen to show beside where it happened.
 */
export function useStructureCommands(readOnly = false) {
  const nav = useNavigate();
  const [last, setLast] = useState<Applied | null>(null);
  // org-13: the receipt belongs to the latest action. Any other command that lands after it (a delete from the panel's
  // sheet, a close, a person moved) ends it, so its undo never reverses an earlier change silently. Ours are known by
  // the very inputs they were sent with.
  const own = useRef(new Set<unknown>());
  const [since] = useState(() => Date.now());
  const landed = useMutationState({ filters: { status: "success" }, select: (m) => ({ at: m.state.submittedAt, vars: m.state.variables }) });
  const newest = landed.reduce((a, b) => (b.at > a.at ? b : a), { at: 0, vars: undefined as unknown });
  useEffect(() => {
    if (newest.at > since && !own.current.has(newest.vars)) setLast(null);
  }, [newest.at, newest.vars, since]);
  const change = useCommand({
    run: (c: Change, key: string) => applyBatch(key, c.ops),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    announce: (_, c) => c.message,
    onSuccess: (r, c) => {
      setLast({ batchId: r.batch_id, message: c.message, moved: c.moved });
      c.onDone?.(r.units.map((u) => u.org_unit_id));
    },
  });
  const undo = useCommand({
    run: async (a: Applied, key: string): Promise<unknown> => (a.back ? reorder(key, a.back) : undoBatch(key, a.batchId!)),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    announce: () => t("structure.receipt.undone"),
    onSuccess: () => setLast((l) => l && { ...l, undone: true, message: t("structure.receipt.undone") }),
  });
  // The sibling order (CS-BE): applied at once in either phase, a label rather than a structure change. Its receipt
  // undoes it by putting back the order it replaced, pinned to the order it left (a later reorder by anyone is refused).
  const order = useCommand({
    run: (o: { body: ReorderRequest; message: string }, key: string) => reorder(key, o.body),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    announce: (_, o) => o.message,
    onSuccess: (r, o) => {
      const { children: _, expected_children: before, ...parent } = o.body;
      setLast(before ? { message: o.message, back: { ...parent, children: before, expected_children: r.children } } : null);
    },
  });
  const proposal = useCommand({
    run: (c: InlineUnitSpec, key: string) => governed(key, inlineUnitBody(c), c.submit),
    invalidates: STRUCTURE_READS,
    awaitFirstRead: true,
    onSuccess: (r, c) => {
      if (r.sent !== "sent") return void nav({ to: "/org/changes/$id", params: { id: r.id }, search: { done: "drafted", unsent: r.sent === "unsent" || undefined } });
      const title = c.kind === "create" ? t("orgChange.title.create", { name: c.name }) : t("orgChange.title.rename", { from: c.fromName, to: c.name });
      noteChange({ id: r.id, code: r.code, message: changeReceipt(r.status, title, r.code, c.effectiveDate) });
      return c.kind === "create" ? c.onDone?.(r.select ? [r.select] : []) : c.onDone?.();
    },
  });
  return {
    readOnly,
    apply: (c: Change) => !readOnly && (own.current.add(c), change.mutate(c)),
    propose: (c: InlineUnitSpec) => !readOnly && (own.current.add(c), proposal.mutate(c)),
    order: (body: ReorderRequest, message: string) => {
      if (readOnly) return;
      const o = { body, message };
      own.current.add(o);
      order.mutate(o);
    },
    pending: change.isPending || undo.isPending || order.isPending || proposal.isPending,
    error: change.error ?? undo.error ?? order.error ?? proposal.error,
    /** The change the server refused, as it was asked (a stale one is offered again from where things are now). */
    failed: change.error ? change.variables : undefined,
    reset: () => (change.reset(), undo.reset(), order.reset(), proposal.reset()),
    last,
    undo: () => !readOnly && last && !last.undone && (own.current.add(last), undo.mutate(last)),
    undoing: undo.isPending,
    dismiss: () => setLast(null),
  };
}
export type Commands = ReturnType<typeof useStructureCommands>;
