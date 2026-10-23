import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { LIFECYCLE_EVENT, actor, label } from "../../../lib/labels";
import { useNeedsNote } from "../../../lib/reason-codes";
import { keepsKey, useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Receipt } from "../../../ui/receipt/receipt";
import { eventsQuery, mySub, rescindEvent, type Cascade, type LifecycleEvent } from "../api";
import { describeEvent, fmtDay } from "../present";
import { Composer } from "../../../ui/composer/composer";
import { LifecycleRefusal } from "./lifecycle-refusal";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { useDraft } from "./use-lifecycle-draft";
import s from "./lifecycle.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
type Result = Awaited<ReturnType<typeof rescindEvent>> | { notRecorded: true };
const NOTE_MAX = 1000;

/**
 * Rescinds the employee's latest applied change (BW-11): the record goes back to how it stood before, and a
 * rescission row with its reason joins the history; the original stays, struck. The server first lists the
 * reservations it will re-check against the restored record; when there are some the user sees them before a
 * second press, otherwise one press rescinds. The command takes no idempotency key, so a lost response is checked
 * against the history, never sent again blindly.
 */
export function RescindSheet({ d, x, act, onClose, onRecorded, onOpen }: {
  d: Detail;
  x: LifecycleEvent;
  act: string;
  onClose: () => void;
  onRecorded: (out: LifecycleEvent) => void;
  onOpen: (act: string, back?: string) => void;
}) {
  const e = d.employee;
  const f = useDraft(e.id, act, {});
  const v = f.draft;
  const [tried, setTried] = useState(false);
  const [cascades, setCascades] = useState<Cascade[] | null>(null);
  const [notRecorded, setNotRecorded] = useState(false);
  const events = useQuery(eventsQuery(e.id));
  const needsNote = useNeedsNote("lifecycle_cancel", v.voidCode);
  const action = label(LIFECYCLE_EVENT, x.event_type);
  const missing = { code: !v.voidCode, note: needsNote && !v.voidNote.trim() };
  const count = Object.values(missing).filter(Boolean).length;
  const body = (confirm: boolean) => ({ reason_code: v.voidCode ?? "", note: v.voidNote.trim(), confirm });
  const done = (out: LifecycleEvent) => {
    f.done();
    onRecorded(out);
  };
  const run = useCommand({
    run: async (): Promise<Result> => {
      // The first press previews; with nothing to re-check it rescinds at once.
      if (cascades === null) {
        const preview = await rescindEvent(x, body(false));
        const named = preview.cascades as unknown as Cascade[];
        if (named.length > 0) return { cascades: named, rescinded: null };
      }
      return rescindEvent(x, body(true));
    },
    verify: async (): Promise<Result> => {
      const result = await events.refetch();
      if (result.isError) throw result.error;
      const row = result.data?.items.find((y) => y.voids_event_id === x.id && y.event_type === "RESCIND" && y.created_by === mySub());
      return row ? { cascades: [], rescinded: row } : { notRecorded: true };
    },
    // Rescinding a workplace move moves the placement and the counts back (UX-R1 PLACEMENT).
    invalidates: ["/api/v1/employees", "/api/v1/org-units", "/api/v1/employment-assignments", "/api/v1/org-structure", "/api/v1/legal-entities"],
    onSuccess: (out) => {
      if ("notRecorded" in out) return setNotRecorded(true);
      if (out.rescinded) done(out.rescinded);
      else setCascades(out.cascades as unknown as Cascade[]);
    },
  });
  const checking = run.isError && keepsKey(run.error) && !notRecorded;
  const set = (patch: Parameters<typeof f.set>[0]) => {
    run.reset();
    setNotRecorded(false);
    f.set(patch);
  };
  const show = (k: keyof typeof missing) => tried && missing[k];
  return (
    <Composer
      title={t("lifecycle.rescind.title", { action })}
      subtitle={[e.name, e.employee_number].filter(Boolean).join(" · ")}
      onClose={onClose}
      localDraft
      onSaveDraft={onClose}
      pending={(run.isPending && !run.isChecking) || events.isRefetching}
      locked={checking}
      notice={
        checking ? <Receipt state="checking" message={t("lifecycle.checking.unkeyed")} />
        : notRecorded ? <p className={s.changed} role="status">{t("lifecycle.rescind.notRecorded")}</p>
        : run.isError && (
          <LifecycleRefusal error={run.error} kind="RESCIND" onLeave={false} target="" onCancelEvent={(id) => onOpen(`cancel:${id}`, act)} onClose={onClose} onFocusTarget={onClose} />
        )
      }
      consequence={
        <>
          <span>{t("lifecycle.rescind.consequence", { name: e.name, action })}</span>
          {cascades && cascades.length > 0 && <span className={s.interim}>{t("lifecycle.rescind.cascades", { count: cascades.length })}</span>}
        </>
      }
      action={{ kind: x.event_type, mode: "revoke", count: 1 }}
      tone="danger"
      missing={tried ? count : 0}
      recovery={
        checking ? (
          <>
            <Button onClick={onClose}>{t("composer.dismiss")}</Button>
            <Button variant="primary" onClick={() => run.check()}>{t("lifecycle.checking.ask")}</Button>
          </>
        ) : undefined
      }
      onSubmit={() => {
        setTried(true);
        if (count > 0) return false;
        run.mutate(undefined);
      }}
    >
      <div className={s.block}>
        <p className={s.fact}>{t("lifecycle.rescind.fact", { date: fmtDay(x.effective_date), action })}</p>
        <p className={s.note}>{describeEvent(x, e.name).title} · {t("person.history.recorded", { actor: actor(x.created_by_name), at: fmtDateTime(x.created_at) })}</p>
      </div>
      {cascades && cascades.length > 0 && (
        <div className={s.block} role="group" aria-label={t("lifecycle.rescind.cascadesTitle")}>
          <p className={s.fact}>{t("lifecycle.rescind.cascadesTitle")}</p>
          <ul className={s.lines}>
            {cascades.map((c) => (
              <li key={c.lifecycle_event_id} className={s.line}>{t("lifecycle.rescind.cascade", { date: fmtDay(c.effective_date), action: label(LIFECYCLE_EVENT, c.event_type) })}</li>
            ))}
          </ul>
        </div>
      )}
      <ReasonCodeField domain="lifecycle_cancel" label={t("lifecycle.rescind.reason")} value={v.voidCode} onChange={(voidCode) => set({ voidCode })} error={show("code") ? t("reason.field.missing") : undefined} />
      <Field label={t("lifecycle.rescind.note")} required={needsNote} hint={t("lifecycle.reason.count", { count: v.voidNote.length, max: NOTE_MAX })} error={show("note") ? t("lifecycle.reason.missing") : undefined}>
        {(p) => <TextArea {...p} maxLength={NOTE_MAX} value={v.voidNote} onChange={(ev) => set({ voidNote: ev.target.value })} />}
      </Field>
    </Composer>
  );
}
