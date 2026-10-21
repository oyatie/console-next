import { useState } from "react";
import { Lock, MapPin, Trash2 } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { voidWorkplace } from "../api";
import { STRUCTURE_READS } from "../../../reference/org/api";
import { descendants, direct, type Place } from "../../../reference/org/domain/structure";
import { ownRefusal } from "../../../reference/crud/present";
import css from "../../../reference/org/ui/structure.module.css";

const REASONS = ["DUPLICATE", "TEST_ENTRY", "NOT_OURS"] as const;

/**
 * workplace delete: a mistaken workplace nothing ever used is removed (in either phase; one that was used is closed instead,
 * CRUD). Anything still there — its department or people placed directly — is named first, and the delete waits until it
 * has been moved. The server's refusal is said in words.
 */
export function WorkplaceDeleteSheet({ place, onClose, onDone }: { place: Place; onClose: () => void; onDone: () => void }) {
  const n = place.node;
  const [reason, setReason] = useState<string | null>(null);
  const units = descendants(n).length;
  const people = direct(n);
  const blocked = units + people > 0;
  const run = useCommand({
    run: (_: undefined, key: string) => voidWorkplace(key, n.id, reason!),
    invalidates: STRUCTURE_READS,
    announce: () => t("orgStructure.wp.deleted", { name: n.name }),
    onSuccess: onDone,
  });
  const reasonId = "wp-delete-reason";
  const ready = !blocked && reason !== null;
  return (
    <Sheet
      open
      kicker={<><MapPin size={14} aria-hidden />{[...place.path].join(" › ")}</>}
      title={t("orgStructure.wp.deleteTitle", { name: n.name })}
      onClose={onClose}
      pending={run.isPending}
      notice={<EntityError error={run.error} own={ownRefusal} />}
      consequence={
        ready ? (
          <span>{t("orgStructure.wp.deleteConsequence", { name: n.name, entity: place.entity.name })}</span>
        ) : (
          <span id={reasonId} className={blocked ? css.footWarn : css.footReason}>
            <Lock size={14} aria-hidden />
            {blocked ? t("orgStructure.wp.deleteBlocked", { depts: units, people }) : t("orgStructure.wp.deleteReasonNeeded")}
          </span>
        )
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgStructure.cancel")}</Button>
          {ready ? (
            <Button variant="danger" onClick={() => run.mutate(undefined)}><Trash2 size={16} aria-hidden />{t("orgStructure.wp.deleteTitle", { name: n.name })}</Button>
          ) : (
            <Button variant="danger" aria-disabled aria-describedby={reasonId}><Trash2 size={16} aria-hidden />{t("orgStructure.wp.deleteTitle", { name: n.name })}</Button>
          )}
        </>
      }
    >
      <ChoiceField label={t("orgStructure.wp.deleteWhyLabel")} required options={REASONS.map((r) => ({ value: r, label: t(`orgStructure.void.${r}`) }))} value={reason} onChange={setReason} />
    </Sheet>
  );
}
