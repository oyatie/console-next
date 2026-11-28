// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime, fmtWeekday } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { todayKst } from "../../../lib/pure/today";
import { authzQuery } from "../../../reference/authz/api";
import { Button } from "../../../ui/button/button-base";
import { Dialog } from "../../../ui/dialog";
import { KeyValue } from "../../../ui/key-value/key-value";
import { MonthGrid } from "../../../ui/month-grid/month-grid";
import { monthWeeks } from "../../../ui/date/month-weeks";
import { MonthGridPattern } from "../../../ui/patterns/month-grid";
import { PeriodStepper } from "../../../ui/period-stepper/period-stepper";
import { createEvent, eventPages, eventsPath, type CalendarEvent } from "../api";
import { dayOfEvent, eventsOnDays } from "../domain/days";
import { EventForm } from "./event-form";
import s from "./calendar.module.css";

const audiences = { PERSONAL: "internalCalendar.personal", DEPARTMENT: "internalCalendar.department", TEAM: "internalCalendar.team", TENANT: "internalCalendar.organization", ORG: "internalCalendar.organization" } as const;
export function CalendarPage() {
  const today = todayKst(), desktop = useIsDesktop();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [selected, select] = useState<string | null>();
  const [eventId, inspect] = useState<string>();
  const [adding, add] = useState(false);
  const [receipt, saved] = useState<string>();
  const day = selected === undefined && desktop ? (today.startsWith(month) ? today : month + "-01") : selected;
  const weeks = useMemo(() => monthWeeks(month), [month]);
  const days = useMemo(() => weeks.flat(), [weeks]);
  const q = useInfiniteQuery(eventPages(days[0]!, days.at(-1)!));
  const access = useQuery(authzQuery);
  const grant = access.isSuccess ? access.data.capabilities.find(cap => cap.feature === "notice_manage" && cap.permission === "allow") : undefined;
  const eventsByDay = useMemo(() => {
    const items = q.data?.pages.flatMap(page => page.items) ?? [];
    return eventsOnDays(days, items);
  }, [days, q.data]);
  const active = day ? eventsByDay.get(day) ?? [] : [];
  const event = active.find(e => e.id === eventId);
  const command = useCommand({ run: createEvent, invalidates: [eventsPath], settle: true, announce: result => t("internalCalendar.saved", { name: result.title }),
    onSuccess: result => { const date = dayOfEvent(result.starts_at); setMonth(date.slice(0, 7)); select(date); inspect(result.id); add(false); saved(result.title); } });
  const pick = (date: string) => { select(date); inspect(undefined); };
  const turn = (value: string) => { setMonth(value); select(undefined); inspect(undefined); };
  const more = q.hasNextPage || q.isFetchNextPageError;
  const load = more && <Button disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{t("internalCalendar.next")}</Button>;
  return <MonthGridPattern q={q.isFetchNextPageError && q.data ? { ...q, error: null } : q} head={{ title: t("internalCalendar.title"),
    actions: <PeriodStepper unit="month" value={month} onChange={turn} label={t("internalCalendar.period")} />,
    primary: { id: "create-event", label: t("internalCalendar.create"), onAction: () => { command.reset(); saved(undefined); add(true); } } }}
    notes={<>{receipt && <p role="status">{t("internalCalendar.saved", { name: receipt })}</p>}
      {more ? <div>{q.isFetchNextPageError ? <CommandError error={q.error} /> : <p>{t("internalCalendar.more")}</p>}{load}</div>
        : q.isSuccess && q.data.pages.every(p => p.items.length === 0) && <p>{t("internalCalendar.empty")}</p>}</>}
    grid={<MonthGrid label={t("internalCalendar.title")} weeks={weeks} weekdays={weeks[0]!.map(d => fmtWeekday(d, "short"))}
      inMonth={d => d.startsWith(month)} selected={day ?? undefined} onSelect={pick}
      cell={d => { const count = eventsByDay.get(d)?.length ?? 0; return count === 1 ? t("internalCalendar.oneEvent") : count ? t("internalCalendar.count", { n: count }) : null; }} />}
    record={day ? { id: day, title: t("internalCalendar.day", { date: fmtDate(day) }), label: t("internalCalendar.events"), onClose: () => { select(null); inspect(undefined); },
      children: <div className={s.agenda}>{active.length ? active.map(row => <Button key={row.id} aria-pressed={eventId === row.id} onClick={() => inspect(row.id)}>{row.title}</Button>)
        : <p>{t(more ? "internalCalendar.partial" : "internalCalendar.dayEmpty")}</p>}{more && load}{event && <EventDetails event={event} />}</div> } : undefined}
    overlays={adding && <Dialog open title={t("internalCalendar.create")} dismissable={!command.isPending} onClose={() => add(false)}>
      <EventForm initial={day ?? (today.startsWith(month) ? today : month + "-01")} grant={grant} busy={command.isPending} save={command.mutate} />
      {command.error && <CommandError error={command.error} />}</Dialog>} />;
}
function EventDetails({ event }: { event: CalendarEvent }) {
  return <KeyValue label={t("internalCalendar.details")} items={[
    { key: "scope", label: t("internalCalendar.audience"), value: [t(audiences[event.scope_type]), ...(["TEAM", "DEPARTMENT"].includes(event.scope_type) && event.scope_ref ? [event.scope_ref] : [])].join(" · ") },
    { key: "start", label: t("internalCalendar.start"), value: fmtDateTime(event.starts_at) },
    { key: "end", label: t("internalCalendar.end"), value: fmtDateTime(event.ends_at) },
    ...(event.all_day ? [{ key: "day", label: t("internalCalendar.allDay"), value: fmtDate(dayOfEvent(event.starts_at)) }] : []),
    ...(event.description ? [{ key: "description", label: t("internalCalendar.description"), value: event.description }] : []),
    ...(event.object_type && event.object_id ? [{ key: "source", label: t("internalCalendar.source"), value: `${event.object_type} · ${event.object_id}` }] : []),
  ]} />;
}
