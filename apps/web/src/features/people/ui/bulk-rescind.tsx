import { useState } from "react";
import { t } from "@console/i18n";
import { useNeedsNote } from "../../../lib/reason-codes";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { failureOf, rescindBatch } from "../api";
import { LifecycleFrame } from "./lifecycle-frame";
import s from "./lifecycle.module.css";

const NOTE_MAX = 1000;

/**
 * Rescinds a whole bulk appointment (BW-11), all or nothing: every person goes back to how they stood before it, and
 * each gets a rescission row with the reason. The first press asks the server which reservations it would re-check;
 * when there are some they are counted before a second press, otherwise one press rescinds.
 */
export function BulkRescind({ batchId, count, onClose, onDone }: { batchId: string; count: number; onClose: () => void; onDone: (rescinded: number) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);
  const [cascades, setCascades] = useState<number | null>(null);
  const needsNote = useNeedsNote("lifecycle_cancel", code);
  const missing = { code: !code, note: needsNote && !note.trim() };
  const run = useCommand({
    run: async () => {
      if (cascades === null) {
        const preview = await rescindBatch(batchId, { reason_code: code!, note: note.trim(), confirm: false });
        const n = preview.reduce((k, p) => k + p.cascades.length, 0);
        if (n > 0) return { n, done: 0 };
      }
      const out = await rescindBatch(batchId, { reason_code: code!, note: note.trim(), confirm: true });
      return { n: 0, done: out.filter((o) => o.rescinded).length };
    },
    invalidates: ["/api/v1/employees", "/api/v1/org-units"],
    onSuccess: (r) => (r.done ? onDone(r.done) : setCascades(r.n)),
  });
  // Undone already (by someone else meanwhile): a dated batch answers 404, an applied one refuses each person's
  // event as voided. Either way nothing is left to undo, and it is said so.
  const f = failureOf(run.error);
  const gone = f.kind === "refused" && f.refusals.length > 0 && f.refusals.every((r) => r.code === "lifecycle_event_voided");
  return (
    <LifecycleFrame
      title={t("bulk.rescind.title")}
      subtitle={t("bulk.rescind.subtitle", { count })}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={(c) => (c === "not_found" || gone ? t("bulk.rescind.gone") : undefined)} />}
      consequence={
        <>
          <span>{t("bulk.rescind.consequence", { count })}</span>
          {cascades ? <span className={s.interim}>{t("lifecycle.rescind.cascades", { count: cascades })}</span> : null}
        </>
      }
      commit={{ label: cascades ? t("lifecycle.rescind.confirm", { count: cascades }) : t("bulk.rescind.commit", { count }), tone: "danger" }}
      missing={tried ? Object.values(missing).filter(Boolean).length : 0}
      onSubmit={() => {
        setTried(true);
        if (Object.values(missing).some(Boolean)) return false;
        run.mutate(undefined);
      }}
    >
      <ReasonCodeField domain="lifecycle_cancel" label={t("lifecycle.rescind.reason")} value={code} onChange={(c) => (run.reset(), setCode(c))} error={tried && missing.code ? t("reason.field.missing") : undefined} />
      <Field label={t("lifecycle.rescind.note")} required={needsNote} hint={t("lifecycle.reason.count", { count: note.length, max: NOTE_MAX })} error={tried && missing.note ? t("lifecycle.reason.missing") : undefined}>
        {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </LifecycleFrame>
  );
}
