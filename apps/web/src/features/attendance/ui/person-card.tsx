import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { todayKst } from "../../../lib/pure/today";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { ItemList } from "../../../ui/item-list/item-list";
import { StatRow } from "../../../ui/key-value/key-value";
import { personMonthQuery, type Day } from "../api";
import { duration } from "../domain/minutes";
import { pageState, type PageState } from "../domain/month-state";
import { dateText, entryText, monthStateText, monthText, shiftText } from "../present";
import { DayBar } from "./day-bar";
import { MarkChip } from "./mark-chip";
import s from "./records.module.css";

const route = getRouteApi("/app/attendance");

/**
 * person card (A7-card): one person's month exactly as the close will take it (provisional until closed). Not a tab: it
 * opens from a name and its crumb goes back to the grid or board with the scope, month and selection as they were.
 */
export function PersonCard({ id, month }: { id: string; month?: string }) {
  const m = month ?? todayKst().slice(0, 7);
  const q = useQuery(personMonthQuery(id, m));
  const search = route.useSearch();
  const back = { ...search, person: undefined };
  return (
    <QueryState q={q}>
      {(p) => {
        const work = p.days.filter((d) => d.plan.kind === "WORK").length;
        const worked = p.days.filter((d) => d.recognition.recognised > 0).length;
        const decisions = p.days.reduce((n, d) => n + d.marks.filter((x) => x === "UNAPPROVED_EXCESS" || x === "WORK_ON_REST_DAY").length, 0);
        return (
          <div className={s.dayPage}>
            <Crumbs items={[<Link key="b" to="/attendance" search={back}>{t(`attendance.tab.${search.tab ?? "month"}`)}</Link>]} current={`${p.name} ${p.employee_number ?? ""}`} />
            <div className={s.inline}>
              <h2>{p.name} <span className="muted num">{p.employee_number}</span></h2>
              {p.month_state.state === "OPEN" ? p.provisional && <Chip tone="warn">{t("attendanceRecords.card.provisional", { month: monthText(m) })}</Chip> : <MonthStateChip state={pageState([p.month_state])} month={m} />}
            </div>
            <p className="muted">{t("attendanceRecords.card.payNote")}</p>
            <StatRow
              label={t("attendanceRecords.card.strip")}
              items={[
                { key: "sched", label: t("attendanceRecords.card.scheduledDays"), value: t("attendanceRecords.card.days", { count: work }) },
                { key: "worked", label: t("attendanceRecords.card.workedDays"), value: t("attendanceRecords.card.days", { count: worked }) },
                { key: "rec", label: t("attendanceRecords.total.recognisedLong"), value: duration(p.totals.recognised) },
                { key: "unrec", label: t("attendanceRecords.total.unrecognisedLong"), value: duration(p.totals.unrecognised) },
                { key: "nw", label: t("attendanceRecords.total.notWorked"), value: duration(p.totals.not_worked) },
                { key: "dec", label: t("attendanceRecords.card.decisions"), value: decisions },
              ]}
            />
            <Card title={t("attendanceRecords.card.daysTitle")} flush>
              <ItemList label={t("attendanceRecords.card.daysTitle")} items={p.days.map((d) => ({ key: d.date, text: <DayLine day={d} /> }))} />
            </Card>
            <Card title={t("attendanceRecords.card.historyTitle")}>
              {p.history.length ? (
                <ItemList
                  label={t("attendanceRecords.card.historyTitle")}
                  items={p.history.map((h) => ({
                    key: h.entry.id,
                    text: <>{dateText(h.date)} · {h.entry.kind === "VOID" || h.entry.undone ? <s>{entryText(h.entry.kind, h.entry.segments)}</s> : entryText(h.entry.kind, h.entry.segments)} · {t(`attendanceRecords.source.${h.entry.source}`)}{h.entry.reason && <> · {h.entry.reason}</>}</>,
                    end: <span className="muted">{h.entry.created_by_name}</span>,
                  }))}
                />
              ) : (
                <p className="muted">{t("attendanceRecords.day.noHistory")}</p>
              )}
            </Card>
          </div>
        );
      }}
    </QueryState>
  );
}

function DayLine({ day }: { day: Day }) {
  const r = day.recognition;
  return (
    <span className={s.boardRow}>
      <span className="num">{day.date.slice(8)}</span>
      <span>{day.plan.shift ? shiftText(day.plan.shift) : t(`attendance.dayKind.${day.plan.kind}`)}</span>
      <DayBar day={day} />
      <span>{day.entry ? t("attendanceRecords.card.pair", { recorded: entryText(day.entry.kind, day.entry.segments), recognised: duration(r.recognised) }) : t("attendanceRecords.day.none")}</span>
      <span>{day.marks.map((m) => <MarkChip key={m} mark={m} />)}</span>
    </span>
  );
}

/** A closed or reopened month on the card: its state, and the way to the lock behind it (the card itself never edits). */
function MonthStateChip({ state, month }: { state: PageState; month: string }) {
  const { link, unlock } = monthStateText(state, month);
  const label = state.state === "CLOSED" ? t("attendanceRecords.card.closed", { month: monthText(month) })
    : state.relockAt ? t("attendanceRecords.card.reopened", { at: fmtDateTimeShort(state.relockAt) }) : t("attendanceRecords.card.reopenedOpenEnded");
  return (
    <>
      <Chip tone={state.state === "CLOSED" ? "info" : "warn"}>{label}</Chip>
      <Link to="/people/period-locks" search={unlock ? { unlock } : {}}>{link}</Link>
    </>
  );
}
