import { useState } from "react";
import { Check, CircleAlert, Info } from "lucide-react";
import { i18n, t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { SectionHead } from "../../../ui/card/section-head";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { ItemList, type Item } from "../../../ui/item-list/item-list";
import { Sheet } from "../../../ui/sheet/sheet";
import { createHoliday, previewHoliday, type HolidayInput, type ScheduleTree } from "../api";
import { dateText, monthText, peopleText, refusalText } from "../present";
import { usePreview } from "./use-preview";

type Form = { name: string; rule: "DATE" | "YEARLY" | null; date: string; month: string; day: string; paid: "yes" | "no" | null; scopeKind: "LEGAL_ENTITY" | "WORKPLACE" | null; scope: string; basis: "WORK_RULES" | "COLLECTIVE_AGREEMENT" | null; ref: string; year: string };
const EMPTY: Form = { name: "", rule: null, date: "", month: "", day: "", paid: null, scopeKind: null, scope: "", basis: null, ref: "", year: "" };
const pick = (k: string) => t("attendanceHolidays.holidaySheet.pick", { field: k });

/** Add a company holiday (A2-holidays--add, +preview): nothing chosen; the server previews who it touches before the primary. */
function HolidaySheetOpen({ open, tree, onClose, onAdded }: { open: boolean; tree: ScheduleTree; onClose: () => void; onAdded: (message: string) => void }) {
  const [f, setF] = useState<Form>(EMPTY);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const now = Number(todayKst().slice(0, 4));
  const scopes = tree.nodes.filter((n) => n.kind === f.scopeKind);
  const missing = [
    !f.name.trim() && t("attendanceHolidays.holidaySheet.name"),
    !f.rule && t("attendanceHolidays.holidaySheet.rule"),
    f.rule === "DATE" && !f.date && t("attendanceHolidays.holidaySheet.date"),
    f.rule === "YEARLY" && (!f.month || !f.day) && t("attendanceHolidays.holidaySheet.monthDay"),
    !f.paid && t("attendanceHolidays.holidaySheet.paid"),
    !f.scope && t("attendanceHolidays.holidaySheet.scope"),
    !f.basis && t("attendanceHolidays.holidaySheet.basis"),
    !f.ref.trim() && t("attendanceHolidays.holidaySheet.ref"),
    !f.year && f.rule === "YEARLY" && t("attendanceHolidays.holidaySheet.year"),
  ].filter((x): x is string => !!x);
  const input: HolidayInput | null = missing.length
    ? null
    : {
        name: f.name.trim(),
        rule_kind: f.rule!,
        on_date: f.rule === "DATE" ? f.date : undefined,
        month: f.rule === "YEARLY" ? Number(f.month) : undefined,
        day: f.rule === "YEARLY" ? Number(f.day) : undefined,
        paid: f.paid === "yes",
        scope_kind: f.scopeKind!,
        scope_id: f.scope,
        basis_kind: f.basis!,
        basis_ref: f.ref.trim(),
        start_year: f.rule === "DATE" ? Number(f.date.slice(0, 4)) : Number(f.year),
      };
  const preview = usePreview(input, previewHoliday);
  const p = preview.data;
  const run = useCommand({ run: (b: HolidayInput, key: string) => createHoliday(b, key), invalidates: ["/api/v1/attendance"], onSuccess: (h) => onAdded(t("attendanceHolidays.holidays.added", { name: h.name, year: h.start_year })) });
  const ready = input && p && !p.refusals.length && !preview.pending;
  const label = input ? t("attendanceHolidays.holidaySheet.commit", { year: input.start_year }) : t("attendanceHolidays.holidays.add");
  const why = missing.length ? t("attendanceSchedule.assign.missing", { fields: new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(missing) }) : p?.refusals[0] ? (refusalText(p.refusals[0].code) ?? "") : t("attendanceSchedule.assign.previewing");
  const lines: Item[] = p
    ? [
        ...p.refusals.map((r) => ({ key: `r-${r.code}`, tone: "danger" as const, mark: <CircleAlert size={14} aria-hidden />, text: refusalText(r.code) ?? r.code })),
        { key: "first", tone: "ok", mark: <Check size={14} aria-hidden />, text: t("attendanceHolidays.holidaySheet.first", { date: dateText(p.first_date), people: peopleText(p.people) }) },
        p.closed_months.length
          ? { key: "closed", tone: "danger", mark: <CircleAlert size={14} aria-hidden />, text: t("attendanceSchedule.preview.closed", { months: p.closed_months.map(monthText).join(" · ") }) }
          : { key: "closed", tone: "ok", mark: <Check size={14} aria-hidden />, text: t("attendanceSchedule.preview.notClosed") },
        p.overlaps_public.length
          ? { key: "overlap", mark: <Info size={14} aria-hidden />, text: t("attendanceHolidays.holidaySheet.overlap", { list: p.overlaps_public.map((o) => `${dateText(o.date)} ${o.name}`).join(" · ") }) }
          : { key: "overlap", mark: <Info size={14} aria-hidden />, text: t("attendanceHolidays.holidaySheet.noOverlap") },
        { key: "work", mark: <Info size={14} aria-hidden />, text: t("attendanceHolidays.holidaySheet.work") },
      ]
    : [];
  return (
    <Sheet
      open={open}
      title={t("attendanceHolidays.holidays.add")}
      onClose={onClose}
      pending={run.isPending}
      notice={<CommandError error={run.error} own={refusalText} />}
      consequence={input && p ? t("attendanceHolidays.holidaySheet.consequence", { name: input.name, people: peopleText(p.people), year: input.start_year }) : t("attendanceHolidays.holidaySheet.consequenceEmpty")}
      actions={
        <>
          <Button onClick={onClose}>{t("attendance.close")}</Button>
          {ready ? <Button variant="primary" disabled={run.isPending} onClick={() => run.mutate(input)}>{label}</Button> : <DisabledReason reason={why} control={(c) => <Button {...c} variant="primary">{label}</Button>} />}
        </>
      }
    >
      <div className="form">
        <Field label={t("attendanceHolidays.holidaySheet.name")} required example={t("attendanceHolidays.holidaySheet.name.example")}>
          {(c) => <TextInput {...c} value={f.name} maxLength={40} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
        <ChoiceField label={t("attendanceHolidays.holidaySheet.rule")} required value={f.rule} onChange={(v) => set({ rule: v as Form["rule"] })} options={[{ value: "YEARLY", label: t("attendanceHolidays.holidaySheet.rule.yearly") }, { value: "DATE", label: t("attendanceHolidays.holidaySheet.rule.date") }]} />
        {f.rule === "DATE" && <DateField label={t("attendanceHolidays.holidaySheet.date")} required value={f.date} onChange={(date) => set({ date })} today={todayKst()} />}
        {f.rule === "YEARLY" && (
          <div className="grid-3">
            <Field label={t("attendanceHolidays.holidaySheet.month")} required>
              {(c) => <SelectInput {...c} value={f.month} onChange={(e) => set({ month: e.target.value })}><option value="">{pick(t("attendanceHolidays.holidaySheet.month"))}</option>{Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{t("attendanceHolidays.monthN", { n: i + 1 })}</option>)}</SelectInput>}
            </Field>
            <Field label={t("attendanceHolidays.holidaySheet.day")} required>
              {(c) => <SelectInput {...c} value={f.day} onChange={(e) => set({ day: e.target.value })}><option value="">{pick(t("attendanceHolidays.holidaySheet.day"))}</option>{Array.from({ length: 31 }, (_, i) => <option key={i} value={i + 1}>{t("attendanceHolidays.dayN", { n: i + 1 })}</option>)}</SelectInput>}
            </Field>
            <Field label={t("attendanceHolidays.holidaySheet.year")} required>
              {(c) => <SelectInput {...c} value={f.year} onChange={(e) => set({ year: e.target.value })}><option value="">{pick(t("attendanceHolidays.holidaySheet.year"))}</option>{[now - 1, now, now + 1, now + 2].map((y) => <option key={y} value={y}>{t("attendanceHolidays.year", { year: y })}</option>)}</SelectInput>}
            </Field>
          </div>
        )}
        <ChoiceField label={t("attendanceHolidays.holidaySheet.paid")} required value={f.paid} onChange={(v) => set({ paid: v as Form["paid"] })} options={[{ value: "yes", label: t("attendanceHolidays.holiday.paid") }, { value: "no", label: t("attendanceHolidays.holiday.unpaid") }]} />
        <ChoiceField label={t("attendanceHolidays.holidaySheet.scopeKind")} required value={f.scopeKind} onChange={(v) => set({ scopeKind: v as Form["scopeKind"], scope: "" })} options={[{ value: "LEGAL_ENTITY", label: t("attendance.level.LEGAL_ENTITY") }, { value: "WORKPLACE", label: t("attendance.level.WORKPLACE") }]} />
        {f.scopeKind && (
          <Field label={t("attendanceHolidays.holidaySheet.scope")} required>
            {(c) => <SelectInput {...c} value={f.scope} onChange={(e) => set({ scope: e.target.value })}><option value="">{pick(t(f.scopeKind === "WORKPLACE" ? "attendance.level.WORKPLACE" : "attendance.level.LEGAL_ENTITY"))}</option>{scopes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</SelectInput>}
          </Field>
        )}
        <ChoiceField label={t("attendanceHolidays.holidaySheet.basis")} required value={f.basis} onChange={(v) => set({ basis: v as Form["basis"] })} options={[{ value: "WORK_RULES", label: t("attendanceHolidays.basis.WORK_RULES") }, { value: "COLLECTIVE_AGREEMENT", label: t("attendanceHolidays.basis.COLLECTIVE_AGREEMENT") }]} />
        <Field label={t("attendanceHolidays.holidaySheet.ref")} required example={t("attendanceHolidays.holidaySheet.ref.example")}>
          {(c) => <TextInput {...c} value={f.ref} maxLength={100} onChange={(e) => set({ ref: e.target.value })} />}
        </Field>
        <section aria-labelledby="att-hol-preview" aria-busy={preview.pending}>
          <SectionHead id="att-hol-preview" level={3}>{t("attendanceSchedule.preview.title")}</SectionHead>
          {input ? (p ? <ItemList label={t("attendanceSchedule.preview.title")} items={lines} /> : <p className="muted" role="status">{t("attendanceSchedule.preview.loading")}</p>) : <p className="muted">{t("attendanceSchedule.preview.wait")}</p>}
        </section>
      </div>
    </Sheet>
  );
}

export function HolidaySheet(p: { open: boolean; tree: ScheduleTree; onClose: () => void; onAdded: (message: string) => void }) {
  return p.open ? <HolidaySheetOpen {...p} /> : null;
}
