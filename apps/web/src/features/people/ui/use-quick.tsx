import { useCallback, useEffect, useState } from "react";
import { t } from "@console/i18n";
import { failureText } from "../../../lib/refusal";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { useKeys } from "../../../lib/react/use-keys";
import { Toast } from "../../../ui/toast/toast";
import { correctEmployee, isStale, type CorrectionChanges } from "../api";
import type { FieldConflict } from "./inline-conflict";
import type { Card } from "./use-card";

/** The ledger reason of a quick edit (Class I): the change itself is the record, with no reason asked. */
const QUICK = "QUICK_EDIT";
/** How long the receipt offers undo (spec §1.4; UNVERIFIED design default). */
const UNDO_MS = 10_000;

/** `at`: the version of the read that drew the value edited (a facts list), when that is not the card's own read. */
type Edit = { field: string; changes: CorrectionChanges; undo: CorrectionChanges; at?: string };

/**
 * quick edit (Class I): the value is sent at once and shown as sending (a gutter tick, no layout shift) until the
 * server answers; then a receipt with undo ⌘Z for ten seconds, which writes the old value back as its own
 * ledgered correction. A refusal keeps nothing and says why.
 */
export function useQuick(c: Card) {
  const [last, setLast] = useState<{ edit: Edit; at: number } | null>(null);
  const [pending, setPending] = useState<{ field: string; changes: CorrectionChanges; undo: CorrectionChanges } | null>(null);
  const run = useCommand({
    run: (x: Edit) => correctEmployee(c.e.id, x.at ?? c.e.updated_at, x.changes, QUICK),
    invalidates: ["/api/v1/employees"],
    settle: true,
    onSuccess: (_, x) => {
      setPending(null);
      setLast({ edit: x, at: Date.now() });
    },
  });
  const save = (field: string, changes: CorrectionChanges, undo: CorrectionChanges, at?: string) => {
    run.reset();
    setPending({ field, changes, undo });
    run.mutate({ field, changes, undo, at });
  };
  const undo = () => {
    if (!last) return;
    const { field, changes, undo: back } = last.edit;
    setLast(null);
    save(field, back, changes);
  };
  // ⌘Z / Ctrl+Z outside a field undoes the last receipt (inside a field it is the text's own undo).
  useKeys({ "quick.undo": undo });
  useEffect(() => {
    if (!last) return;
    const id = setTimeout(() => setLast(null), UNDO_MS - (Date.now() - last.at));
    return () => clearTimeout(id);
  }, [last]);
  const dismiss = useCallback(() => setLast(null), []);
  // E12-conflict: someone saved this person first. Nothing was overwritten; the field itself asks (InlineConflict).
  const stale = run.isError && isStale(run.error) && pending ? pending : null;
  const conflictFor = (field: string): FieldConflict | undefined =>
    stale?.field === field
      ? { mine: String(Object.values(stale.changes)[0] ?? ""), before: String(Object.values(stale.undo)[0] ?? ""), onKeep: () => run.mutate({ field: stale.field, changes: stale.changes, undo: {} }), onTheirs: () => (run.reset(), setPending(null)) }
      : undefined;
  const toast = run.isPending ? (
    <Toast state="sending">{t("empCard.quick.sending", { field: pending?.field ?? "" })}</Toast>
  ) : stale ? null : run.isError ? (
    <Toast state="error" actions={<Button variant="ghost" onClick={() => run.reset()}>{t("empCard.quick.dismiss")}</Button>}>{t("empCard.quick.failed", { field: pending?.field ?? "" })} · {failureText(run.error)}</Toast>
  ) : last ? (
    <Toast state="done" actions={<Button variant="ghost" onClick={undo}>{t("empCard.quick.undo")}</Button>}>{t("empCard.quick.done", { field: last.edit.field })}</Toast>
  ) : null;
  return { save, pending: run.isPending ? pending : null, toast, dismiss, conflictFor };
}
export type Quick = ReturnType<typeof useQuick>;
