import { EnumCode } from "../../../ui/enum-value";
import { QueryState } from "../../../lib/react/query-state";
import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, LEAVE_TYPE, LIFECYCLE_EVENT, label } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { Segmented } from "../../../ui/button/segmented";
import { Kbd, Tag } from "../../../ui/record/record-section";
import { Spine, type SpineItem } from "../../../ui/record/spine";
import type { LifecycleEvent } from "../api";
import { cancellable, verbStates } from "../domain/lifecycle";
import { retirementDate } from "../domain/employment";
import { describeEvent, eventLine } from "../present";
import { focusSoon } from "../../../lib/react/announce";
import { NextBox } from "./person-next";
import { rowVerbs } from "./history-verbs";
import type { Card } from "./use-card";
import s from "./card.module.css";

type View = "all" | "acts" | "fixes";
const tone = (x: LifecycleEvent): SpineItem["tone"] =>
  x.state === "SCHEDULED" ? "plan" : x.event_type === "ONBOARD" ? "new" : x.event_type === "RESCIND" || x.voids_event_id ? "fix" : x.event_type === "TERMINATE" ? "end" : "rev";

/**
 * "now + history" beside the record (E2): today's placement in one box, then every dated fact newest first, reservations
 * on top with their reservation cancel. correction rows come from the corrections ledger, which the server does not serve as a read
 * yet (backend-followups EMP-UI): the correction view says so instead of showing an empty history.
 */
export function CardSpine({ c, onAct, onLedger, onHistory }: { c: Card; onAct: (act: string) => void; onLedger: () => void; onHistory: () => void }) {
  const [view, setView] = useState<View>("all");
  const { e, d } = c;
  const all = (c.events.data?.items ?? []).filter((x) => x.state !== "CANCELLED");
  const byId = (id: string) => all.find((x) => x.id === id);
  const events = c.events.data?.items ?? [];
  const verbs = c.editable && e.status !== "EXITED" ? verbStates(d, events) : [];
  const offered = (type: string) => verbs.some((v) => v.verb === type && v.enabled);
  const sorted = [...all].sort((a, b) => b.effective_date.localeCompare(a.effective_date));
  const items: SpineItem[] = view === "fixes" ? [] : sorted.map((x) => {
    const { title, detail } = describeEvent(x, e.name, byId);
    const by = x.created_by_name && t("empCard.next.by", { who: x.created_by_name, date: fmtDateTime(x.created_at) });
    return {
      key: x.id,
      tone: tone(x),
      when: <>{fmtDate(x.event_type === "TERMINATE" || x.event_type === "OFFBOARD" ? retirementDate(x.effective_date) : x.effective_date)} {x.state === "SCHEDULED" && <Tag kind="plan">{t("empCard.spine.planned")}</Tag>} {x.batch_id && <Tag>{t("empCard.spine.batch")}</Tag>}</>,
      what: <b>{eventLine(x, c.title) ?? title} <EnumCode e={LEAVE_TYPE} value={x.leave_type} /></b>,
      // The ribbon's verbs on the default view (trunk's person page had them there): withdraw a reservation, record a failed one
      // again, correct or rescind the latest change in force.
      meta: x.state === "SCHEDULED" && cancellable(x) ? (
        <>
          {by ?? detail} · <Button variant="link" onClick={() => onAct(`cancel:${x.id}`)}>{t("empCard.spine.cancel")}</Button>
          {c.editable && offered(x.event_type) && <Button variant="link" onClick={() => onAct(`edit:${x.id}`)}>{t("person.history.edit", { action: label(LIFECYCLE_EVENT, x.event_type) })}</Button>}
        </>
      ) : <>{x.state === "SCHEDULED" ? by ?? detail : detail}{c.editable && rowVerbs(x, { employee: e, all: events, offered, onAct })}</>,
    };
  });
  const now = [c.place.workplace, c.place.path.at(-1) ?? e.org_unit, c.title(d.classification.grade_id) ?? e.position, c.title(d.classification.position_kind_id), d.employment?.employment_type && label(EMPLOYMENT_TYPE, d.employment.employment_type)].filter(Boolean).join(" · ");
  return (
    <QueryState q={c.events}>{() => <Spine
      title={t("empCard.spine.title")}
      tools={
        <Segmented label={t("empCard.spine.view")} value={view} onChange={setView} items={(["all", "acts", "fixes"] as const).map((v) => ({ id: v, label: t(`empCard.spine.${v}`) }))} />
      }
      nowKey={t("empCard.spine.now", { date: fmtDate(todayKst()) })}
      now={now || "—"}
      // What is due next (trunk's next box): it lands with the history, so nothing already drawn moves for it.
      next={c.events.isSuccess && <NextBox d={d} events={events} verbs={verbs} today={todayKst()} onAct={onAct} onShow={(id) => (onHistory(), focusSoon(`ev-${id}`, "history"))} />}
      items={items}
      empty={<p className={s.note}>{view === "fixes" ? t("empCard.spine.fixesUnserved") : t("empCard.spine.empty")}</p>}
      // The foot holds controls: it lands once the history has, so it never moves under the pointer.
      foot={
        c.events.isSuccess && <>
          {t("empCard.spine.foot", { acts: all.filter((x) => x.state === "APPLIED").length, planned: all.filter((x) => x.state === "SCHEDULED").length })}
          <span>{"·"}</span> <Kbd k="H" /> {t("empCard.spine.keyH")} <span>{"·"}</span>
          <Button variant="link" onClick={onLedger}>{t("empCard.spine.ledger")}</Button>
        </>
      }
    />}</QueryState>
  );
}
