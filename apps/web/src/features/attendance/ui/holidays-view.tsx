import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { Sheet } from "../../../ui/sheet/sheet";
import { Table } from "../../../ui/table";
import { holidaysQuery, retireHoliday, type ContractualHoliday, type ScheduleTree } from "../api";
import { refusalText, ruleText } from "../present";
import { HolidaySheet } from "./holiday-sheet";
import { YearStepper } from "./year-stepper";


/**
 * company holiday (A2-holidays, +add): the company's own rest days from the work rules or a collective agreement. Unlike public holiday they are this
 * tenant's records: added with a preview, stopped from a year on (retire), and every change stays in history.
 */
export function HolidaysView({ tree, onDone }: { tree: ScheduleTree; onDone: (message: string) => void }) {
  const [year, setYear] = useState(Number(todayKst().slice(0, 4)));
  const q = useQuery({ ...holidaysQuery(year), placeholderData: keepPreviousData });
  const [adding, setAdding] = useState(false);
  const [retiring, setRetiring] = useState<ContractualHoliday | null>(null);
  return (
    <>
      <Card
        title={t("attendanceHolidays.holidays.title")}
        meta={t("attendanceHolidays.holidays.meta")}
        flush
        tools={!q.error &&
          <>
            <YearStepper year={year} onYear={setYear} />
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> {t("attendanceHolidays.holidays.add")}</Button>
          </>
        }
      >
        <QueryState q={q} layout="list" empty={(d) => (d.contractual.length ? null : <EmptyState title={t("attendanceHolidays.holidays.none", { year })} reason={t("attendanceHolidays.holidays.none.reason")} actions={<Button variant="primary" onClick={() => setAdding(true)}>{t("attendanceHolidays.holidays.add")}</Button>} />)}>
          {(d) => (
            <Table
              label={t("attendanceHolidays.holidays.title")}
              rows={d.contractual}
              rowId={(h) => h.id}
              columns={[
                { header: t("attendanceHolidays.holidays.col.name"), cell: (h) => <strong>{h.name}</strong> },
                { header: t("attendanceHolidays.holidays.col.rule"), cell: (h) => <span className="num">{ruleText(h)}</span> },
                { header: t("attendanceHolidays.holidays.col.paid"), cell: (h) => t(h.paid ? "attendanceHolidays.holiday.paid" : "attendanceHolidays.holiday.unpaid"), fit: true },
                { header: t("attendanceHolidays.holidays.col.scope"), cell: (h) => h.scope_name },
                { header: t("attendanceHolidays.holidays.col.basis"), cell: (h) => <span className="muted">{t(`attendanceHolidays.basis.${h.basis_kind}`)} {h.basis_ref}</span> },
                { header: t("attendanceHolidays.holidays.col.years"), cell: (h) => (h.end_year ? t("attendanceHolidays.holiday.years", { from: h.start_year, to: h.end_year }) : t("attendanceHolidays.holiday.since", { from: h.start_year })), fit: true },
                { header: t("attendanceHolidays.holidays.col.actions"), fit: true, cell: (h) => (h.end_year ? null : <Button size="sm" variant="ghost" onClick={() => setRetiring(h)} aria-label={t("attendanceHolidays.holidays.retireOne", { name: h.name })}>{t("attendanceHolidays.holidays.retire")}</Button>) },
              ]}
            />
          )}
        </QueryState>
      </Card>
      <HolidaySheet open={adding} tree={tree} onClose={() => setAdding(false)} onAdded={(message) => (setAdding(false), onDone(message))} />
      <RetireSheet holiday={retiring} onClose={() => setRetiring(null)} onRetired={(message) => (setRetiring(null), onDone(message))} />
    </>
  );
}

function RetireSheetOpen({ holiday, onClose, onRetired }: { holiday: ContractualHoliday | null; onClose: () => void; onRetired: (message: string) => void }) {
  const now = Number(todayKst().slice(0, 4));
  const [from, setFrom] = useState("");
  const run = useCommand({
    run: (h: ContractualHoliday) => retireHoliday(h.id, Number(from)),
    invalidates: ["/api/v1/attendance"],
    onSuccess: (h) => (onRetired(t("attendanceHolidays.holidays.retired", { name: h.name, year: from }))),
  });
  const label = from ? t("attendanceHolidays.holidays.retireCommit", { year: from }) : t("attendanceHolidays.holidays.retire");
  return (
    <Sheet
      open={!!holiday}
      kicker={holiday?.name}
      title={t("attendanceHolidays.holidays.retire")}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={refusalText} />}
      consequence={holiday && from ? t("attendanceHolidays.holidays.retireConsequence", { name: holiday.name, year: from }) : t("attendanceHolidays.holidays.retirePick")}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {from ? (
            <Button variant="danger" disabled={run.isPending} onClick={() => holiday && run.mutate(holiday)}>{label}</Button>
          ) : (
            <DisabledReason reason={t("attendanceHolidays.holidays.retirePick")} control={(p) => <Button {...p} variant="danger">{label}</Button>} />
          )}
        </>
      }
    >
      <Field label={t("attendanceHolidays.holidays.retireFrom")} required hint={t("attendanceHolidays.holidays.retireHint")}>
        {(p) => (
          <SelectInput {...p} value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">{t("attendanceHolidays.holidays.yearPick")}</option>
            {[now, now + 1, now + 2].map((y) => <option key={y} value={y}>{t("attendanceHolidays.year", { year: y })}</option>)}
          </SelectInput>
        )}
      </Field>
    </Sheet>
  );
}

function RetireSheet(p: { holiday: ContractualHoliday | null; onClose: () => void; onRetired: (message: string) => void }) {
  return p.holiday ? <RetireSheetOpen {...p} /> : null;
}
