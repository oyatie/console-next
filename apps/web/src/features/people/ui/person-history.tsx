import { OutcomeLink } from "../../../lib/react/outcome-link";
import { ActorBadge } from "../../../ui/timeline-lanes/actor-badge";
import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { QueryState } from "../../../lib/react/query-state";
import { actor } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Receipt } from "../../../ui/receipt/receipt";
import { TimelineLanes, type LaneItem } from "../../../ui/timeline-lanes/timeline-lanes";
import { lanes, type VerbState } from "../domain/lifecycle";
import { describeEvent, fmtDay, fmtGutter } from "../present";
import type { LifecycleEvent } from "../api";
import { rowVerbs } from "./history-verbs";
import { LifecycleReceiptActions } from "./lifecycle-receipt";
import type { Done } from "./person-act";
import s from "./person.module.css";

type Employee = components["schemas"]["Employee"];
type Events = UseQueryResult<{ items: LifecycleEvent[]; head_version: number }>;

/** One colour per kind of act; the title always names the act too. */
const TONE: Partial<Record<LifecycleEvent["event_type"], LaneItem["tone"]>> = {
  ONBOARD: "ok",
  TRANSFER: "info",
  PROMOTE: "ok",
  LEAVE_OF_ABSENCE: "warn",
  RETURN_FROM_LEAVE: "info",
  TERMINATE: "danger",
  OFFBOARD: "danger",
  EXIT_REVERSAL: "warn",
  RESCIND: "warn",
};

/**
 * The employee's records on one effective-date ribbon (design §3.5): reservations above today, the rest
 * below, newest first by the date each takes effect. A reservation can be changed or withdrawn; a record
 * that failed to apply can be recorded again; the latest change in force can be corrected or rescinded (BW-11),
 * which leaves it struck beside the record that voided it. The last commit's receipt docks beside the panel.
 */
export function PersonHistory({ employee, events, verbs, manage, today, done, onAct, onDismiss }: {
  employee: Employee;
  events: Events;
  verbs: VerbState[];
  manage: boolean;
  today: string;
  done: Done | null;
  onAct: (act: string) => void;
  onDismiss: () => void;
}) {
  const [showCancelled, setShowCancelled] = useState(false);
  const offered = (type: string) => verbs.some((v) => v.verb === type && v.enabled);
  const all = events.data?.items ?? [];
  const byId = (id: string) => all.find((y) => y.id === id);
  const row = (x: LifecycleEvent): LaneItem => {
    const v = describeEvent(x, employee.name, byId);
    const due = x.state === "SCHEDULED" && x.effective_date <= today;
    return {
      key: x.id,
      id: `ev-${x.id}`,
      date: fmtGutter(x.effective_date, today),
      tone: TONE[x.event_type],
      title: v.title,
      state: due ? <Chip tone="warn">{t("person.history.dueToday")}</Chip> : v.state && <Chip tone={v.state.tone}>{v.state.label}</Chip>,
      detail: v.detail,
      meta: <>{t("person.history.recorded", { actor: actor(x.created_by_name), at: fmtDateTime(x.created_at) })}<ActorBadge kind={x.actor_kind} /><OutcomeLink id={x.command_id} /></>,
      struck: x.state === "CANCELLED" || Boolean(x.voided_by),
      highlight: done?.eventId === x.id,
      verbs: manage ? rowVerbs(x, { employee, all, offered, onAct }) : undefined,
    };
  };
  return (
    <section className={`card ${s.history}`} aria-labelledby="history">
      <div className="panel__head">
        <h2 id="history" className="panel__title" tabIndex={-1}>{t("people.employee.history")}</h2>
      </div>
      {/* Docked, not in the flow: a receipt landing never pushes the history under the pointer (stability gate). */}
      {done && (
        <Receipt
          placement="docked"
          state="recorded"
          message={done.message}
          actions={
            <>
              <Button variant="ghost" onClick={() => focusSoon(`ev-${done.eventId}`, "history")}>{t("person.history.show")}</Button>
              {done.again && manage && <Button variant="ghost" onClick={() => onAct(`again:${done.again}`)}>{t("person.history.again")}</Button>}
              <LifecycleReceiptActions done={done} employeeId={employee.id} onAct={onAct} />
              <Button variant="ghost" onClick={onDismiss}>{t("uiReceipt.dismiss")}</Button>
            </>
          }
        />
      )}
      <QueryState q={events}>
        {(ev) => {
          const l = lanes(ev.items, showCancelled);
          return (
            <>
              {l.cancelled > 0 && (
                <div className="row">
                  <Button variant="ghost" aria-pressed={showCancelled} onClick={() => setShowCancelled(!showCancelled)}>
                    {t("person.history.showCancelled", { count: l.cancelled })}
                  </Button>
                </div>
              )}
              <TimelineLanes
                labels={{ upcoming: t("person.history.upcoming"), today: t("person.history.today", { date: fmtDay(today) }), past: t("person.history.past") }}
                upcoming={l.upcoming.map(row)}
                past={l.past.map(row)}
              />
            </>
          );
        }}
      </QueryState>
    </section>
  );
}
