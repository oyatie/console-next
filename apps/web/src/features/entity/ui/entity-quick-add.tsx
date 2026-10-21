import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button } from "../../../ui/button/button";
import { Receipt } from "../../../ui/receipt/receipt";
import { ENTITY_READS, voidEntity } from "../api";
import { EntityQuickSheet, type QuickSaved } from "./entity-quick-sheet";

/** Why a quick-added entity was removed again: the creator's own undo during setup, not a correction. */
const UNDO_REASON = "UNDO_CREATE";

/**
 * The quick sheet with what follows it (spec S10 "receipt toast offers undo"): the receipt stays until replaced and
 * offers the record and an undo, which removes the entity while the tenant is in setup (the server refuses it after).
 * The chart's root box mounts this the same way.
 */
export function QuickAdd({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [done, setDone] = useState<QuickSaved | null>(null);
  const undo = useCommand({
    run: (r: QuickSaved, key: string) => voidEntity(key, r.id, UNDO_REASON),
    invalidates: ENTITY_READS,
    settle: true,
    announce: (_, r) => t("entityQuick.undone", { name: r.name }),
    onSuccess: () => setDone(null),
  });
  return (
    <>
      <EntityQuickSheet
        open={open}
        onClose={onClose}
        onSaved={(r, then) => {
          onClose();
          if (then === "workplace") void nav({ to: "/org/entities/$id/workplaces/new", params: { id: r.id } });
          else setDone(r);
        }}
      />
      {done && (
        <Receipt
          state="recorded"
          message={t("entityQuick.receipt", { name: done.name })}
          actions={
            <>
              <Link to="/org/entities/$id" params={{ id: done.id }} className="btn btn--ghost">{t("entityQuick.open")}</Link>
              <Button variant="ghost" disabled={undo.isPending} onClick={() => undo.mutate(done)}>{t("entityQuick.undo")}</Button>
            </>
          }
        />
      )}
      <EntityError error={undo.error} />
    </>
  );
}
