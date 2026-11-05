import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { Banner } from "../banner/banner";
import { Button, ToggleButton } from "../button/button";
import { DateField } from "../date/date-field";
import { isDate } from "../date/days";
import { Skeleton } from "../skeleton/skeleton";
import { DisabledReason } from "../disabled-reason/disabled-reason";
import { PopoverButton } from "../popover/popover-button";

import { isKnowledgeDate, nearestDate } from "./dates";
import styles from "./asof-control.module.css";

export function AsOfControl({ today, value, knownAt, onChange, changeDates, loadingDates = false, entity = false }: {
  today: string;
  value: string;
  knownAt?: string;
  onChange: (value: string, knownAt?: string) => void;
  changeDates?: readonly string[];
  loadingDates?: boolean;
  entity?: boolean;
}) {
  const [date, setDate] = useState(value);
  const [source, setSource] = useState({ value, knownAt });
  if (source.value !== value || source.knownAt !== knownAt) {
    setSource({ value, knownAt });
    setDate(value);
  }
  const dates = [...new Set((changeDates ?? []).filter(isDate))].sort();
  const center = dates.findIndex((d) => d >= value);
  const anchor = center < 0 ? dates.length : center;
  const start = Math.max(0, anchor - 4);
  const markers = dates.slice(start, anchor + 5);
  const ribbon = changeDates !== undefined || loadingDates;
  const previous = nearestDate(dates, value, "previous");
  const next = nearestDate(dates, value, "next");
  const apply = (asOf: string, knowledge?: string) => {
    if (isDate(asOf) && (!knowledge || isKnowledgeDate(knowledge))) onChange(asOf, knowledge || undefined);
  };
  const chooseDate = (chosen: string) => {
    setDate(chosen);
    apply(chosen, knownAt);
  };
  const returnToday = () => {
    setDate(today);
    onChange(today);
  };
  const past = isDate(value) && value < today;
  const future = isDate(value) && value > today;
  const historic = past || future || Boolean(knownAt);
  const isToday = isDate(value) && !historic;
  const label = !isDate(value) || (knownAt && !isKnowledgeDate(knownAt))
    ? t("asof.dateInvalid")
    : knownAt ? t("asof.known", { date: fmtDate(value), known: knownAt.includes("T") ? fmtDateTime(knownAt) : fmtDate(knownAt) })
    : t(past ? (entity ? "asof.recordPast" : "asof.past") : "asof.future", { date: fmtDate(value) });
  return (
    <section className={styles.control} aria-label={t("asof.label")} data-asof={past ? "past" : future ? "future" : "today"}>
      <PopoverButton chip label={`${t("asof.label")} · ${!isDate(value) ? t("asof.dateInvalid") : isToday ? `${t("asof.today")} · ${fmtDate(value)}` : fmtDate(value)}`} title={t("asof.label")} wide
        trigger={<><CalendarDays size={16} aria-hidden />{t("asof.label")} · {isDate(value) ? <>{isToday && `${t("asof.today")} · `}<time dateTime={value}>{fmtDate(value)}</time></> : t("asof.dateInvalid")}</>}>
        {(close) => {
          const choose = (chosen: string) => { chooseDate(chosen); if (isDate(chosen)) close(); };
          return <>
            <div className="row">
              {ribbon && <span className={styles.navigation} data-reason={t("asof.noPrevious")}>{previous ?
                <Button onClick={() => choose(previous)}>{t("asof.previous")}</Button>
                : <DisabledReason reason={t(loadingDates ? "common.loading" : "asof.noPrevious")} control={(p) => <Button {...p}>{t("asof.previous")}</Button>} />}</span>}
              <DateField label={t("asof.label")} required={null} today={today} value={date} onChange={choose} error={!isDate(date) ? t("asof.dateInvalid") : undefined} />
              <Button onClick={() => { returnToday(); close(); }}>{t("asof.today")}</Button>
              {ribbon && <span className={styles.navigation} data-reason={t("asof.noNext")}>{next ?
                <Button onClick={() => choose(next)}>{t("asof.next")}</Button>
                : <DisabledReason reason={t(loadingDates ? "common.loading" : "asof.noNext")} control={(p) => <Button {...p}>{t("asof.next")}</Button>} />}</span>}
            </div>
            {ribbon && <div className={`row ${styles.ribbon}`} role="group" aria-label={t("asof.ribbon")} aria-busy={loadingDates || undefined}>
              {loadingDates ? <Skeleton bones={["line"]} label={t("asof.ribbon")} /> : dates.length ? markers.map((marker, i) => <ToggleButton key={marker} data-slot={start + i - anchor + 5} data-change-date={marker} pressed={value === marker} onClick={() => choose(marker)}>{fmtDate(marker)}</ToggleButton>) : <span className="muted">{t("asof.noChanges")}</span>}
            </div>}
          </>;
        }}
      </PopoverButton>
      {historic && <Banner tone={past ? "past" : "info"} placement="page" title={label} actions={<Button onClick={returnToday}>{t("asof.returnToday")}</Button>} />}
    </section>
  );
}
