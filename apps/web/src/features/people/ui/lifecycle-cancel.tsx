import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { LIFECYCLE_EVENT, actor, label } from "../../../lib/labels";
import { keepsKey, useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { Field } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { Receipt } from "../../../ui/receipt/receipt";
import { cancelScheduledEvent, eventsQuery, mySub, refusalOf, type LifecycleEvent } from "../api";
import { describeEvent, fmtDay } from "../present";
import { LifecycleFrame } from "./lifecycle-frame";
import { LifecycleRefusal } from "./lifecycle-refusal";
import { useDraft } from "./use-lifecycle-draft";
import s from "./lifecycle.module.css";

type Detail = components["schemas"]["EmployeeDetail"];
const REASON_MAX = 1000;

/**
 * Withdraws a reservation before its date. The employee's record does not change; the withdrawal and its reason stay
 * in the history. It cannot be undone (a new reservation is a new record), so the commit is red. A later reservation
 * that depends on this one is named with its own "cancel that one".
 * The cancel command takes no idempotency key, so a lost response is never sent again: "check whether it was recorded" reads the
 * history and says whether my withdrawal was recorded, someone else's was, or none was (and the form unlocks).
 * A 409 invalid_transition is checked the same way, since my own first press may have recorded it.
 */
export function CancelSheet({ d, x, act, onClose, onRecorded, onOpen }: {
  d: Detail;
  x: LifecycleEvent;
  act: string;
  onClose: () => void;
  onRecorded: () => void;
  onOpen: (act: string, back?: string) => void;
}) {
  const e = d.employee;
  const f = useDraft(e.id, act, {});
  const [tried, setTried] = useState(false);
  const [elsewhere, setElsewhere] = useState<LifecycleEvent | null>(null);
  const [notRecorded, setNotRecorded] = useState(false);
  const events = useQuery(eventsQuery(e.id));
  const action = label(LIFECYCLE_EVENT, x.event_type);
  const reason = f.draft.comment;
  const run = useCommand({
    run: async () => { await cancelScheduledEvent({ x, reason: reason.trim() }); return true; },
    verify: async () => {
      const result = await events.refetch();
      if (result.isError) throw result.error;
      const now = result.data?.items.find((y) => y.id === x.id);
      if (!now) throw new Error("record_not_found");
      if (now.state === "CANCELLED" && now.cancelled_by === mySub()) return true;
      if (now.state !== "SCHEDULED") setElsewhere(now);
      return false;
    },
    invalidates: ["/api/v1/employees"],
    settle: true,
    onSuccess: (recorded) => {
      if (!recorded) return setNotRecorded(true);
      f.done();
      onRecorded();
    },
  });
  const unknown = run.isError && (keepsKey(run.error) || refusalOf(run.error)?.code === "invalid_transition");
  const checking = unknown && !elsewhere && !notRecorded;
  return (
    <LifecycleFrame
      title={t("lifecycle.cancel.title", { action })}
      subtitle={[e.name, e.employee_number].filter(Boolean).join(" · ")}
      onClose={onClose}
      onSaveDraft={onClose}
      pending={run.isSending || events.isRefetching}
      locked={checking || elsewhere !== null}
      notice={
        checking ? <Receipt state="checking" message={t("lifecycle.checking.unkeyed")} />
        : elsewhere ? (
          <p className={s.changed} role="status">
            {t("lifecycle.cancel.elsewhere", { actor: actor(elsewhere.cancelled_by_name), at: elsewhere.cancelled_at ? fmtDateTime(elsewhere.cancelled_at) : "—" })}
          </p>
        )
        : notRecorded ? <p className={s.changed} role="status">{t("lifecycle.cancel.notRecorded")}</p>
        : run.isError && (
          <LifecycleRefusal
            error={run.error}
            kind="CANCEL"
            onLeave={false}
            target=""
            onCancelEvent={(id) => onOpen(`cancel:${id}`, act)}
            onClose={onClose}
            onFocusTarget={onClose}
          />
        )
      }
      consequence={<span>{t("lifecycle.cancel.consequence", { name: e.name })}</span>}
      commit={{ label: t("lifecycle.cancel.title", { action }), tone: "danger" }}
      missing={tried && !reason.trim() ? 1 : 0}
      actions={
        checking ? (
          <>
            <Button onClick={onClose}>{t("lifecycle.close")}</Button>
            <Button variant="primary" onClick={() => run.check()}>{t("lifecycle.checking.ask")}</Button>
          </>
        )
        : elsewhere ? <Button onClick={onClose}>{t("lifecycle.close")}</Button>
        : undefined
      }
      onSubmit={() => {
        setTried(true);
        if (!reason.trim()) return false;
        setNotRecorded(false);
        run.mutate(undefined);
      }}
    >
      <div className={s.block}>
        <p className={s.fact}>{t("lifecycle.cancel.fact", { date: fmtDay(x.effective_date), action })}</p>
        <p className={s.note}>{describeEvent(x, e.name).title} · {t("person.history.recorded", { actor: actor(x.created_by_name), at: fmtDateTime(x.created_at) })}</p>
      </div>
      <Field
        label={t("lifecycle.cancel.reason")}
        required
        hint={t("lifecycle.reason.count", { count: reason.length, max: REASON_MAX })}
        error={tried && !reason.trim() ? t("lifecycle.reason.missing") : undefined}
      >
        {(p) => (
          <TextArea
            {...p}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(ev) => {
              run.reset();
              setNotRecorded(false);
              f.set({ comment: ev.target.value });
            }}
          />
        )}
      </Field>
    </LifecycleFrame>
  );
}
