import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { holidaysQuery } from "../api";
import { dateText } from "../present";
import { YearStepper } from "./year-stepper";

/**
 * public holiday (read-only, A2-holidays): the bundled reference data shipped with the release (the government-office holiday regulation §2 · §3
 * and Labor Day). There is no add or remove; a year the release carries no rows for says so, and nothing is guessed.
 */
export function PublicHolidaysView() {
  const [year, setYear] = useState(Number(todayKst().slice(0, 4)));
  const q = useQuery(holidaysQuery(year));
  return (
    <Card title={t("attendanceHolidays.public.title")} meta={t("attendanceHolidays.public.meta")} flush tools={<YearStepper year={year} onYear={setYear} />}>
      <QueryState q={q} empty={(d) => (d.loaded ? null : <EmptyState title={t("attendanceHolidays.public.notLoaded", { year })} reason={t("attendanceHolidays.public.notLoaded.reason")} />)}>
        {(d) => (
          <>
            <Table
              label={t("attendanceHolidays.public.title")}
              rows={d.public}
              rowId={(h) => h.date}
              columns={[
                { header: t("attendanceHolidays.public.col.date"), cell: (h) => <span className="num">{dateText(h.date)}</span>, fit: true },
                { header: t("attendanceHolidays.public.col.name"), cell: (h) => <strong>{h.name}</strong> },
                { header: t("attendanceHolidays.public.col.kind"), cell: (h) => (h.substitute_for ? t("attendanceHolidays.public.substituteFor", { date: dateText(h.substitute_for) }) : t(`attendanceHolidays.publicKind.${h.kind}`)) },
                { header: t("attendanceHolidays.public.col.basis"), cell: (h) => <span className="muted">{h.basis}</span> },
              ]}
            />
            <p className="muted">{t("attendanceHolidays.public.rule", { edition: d.edition ?? "" })}</p>
          </>
        )}
      </QueryState>
    </Card>
  );
}
