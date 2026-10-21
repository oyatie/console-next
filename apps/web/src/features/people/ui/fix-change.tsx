import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, label } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { reasonCodesQuery, reasonOptions } from "../../../lib/reason-codes";
import { Button } from "../../../ui/button/button";
import { Segmented } from "../../../ui/button/segmented";
import { Card as Surface } from "../../../ui/card/card";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { DateInput } from "../../../ui/date/date-input";
import { TextInput } from "../../../ui/field/field";
import { Tag } from "../../../ui/record/record-section";
import { RecordRows } from "../../../ui/record/rows";
import { Sheet } from "../../../ui/sheet/sheet";
import { jobTitlesQuery, recordLifecycleEvent, type LifecycleRequest } from "../api";
import { CATALOG_KIND, isDate, nextMonthFirst, periods, type FixField } from "../domain/fix";
import { isDemotion, DEMOTION_REASON } from "../domain/titles";
import { fmtDay } from "../present";
import { currentOf, useCatalogPending } from "./use-fix-draft";
import type { Card } from "./use-card";
import s from "./card.module.css";
import { Who } from "./card-who";
import { CatalogPicker } from "./catalog-picker";
import { Muted } from "../../../ui/muted/muted";

type Act = "PROMOTE" | "APPOINT" | "EMPLOYMENT_TYPE_CHANGE";
type Ev = NonNullable<Card["planned"]>;
/** The before/after a recorded act holds for `field` (ids are named by the tenant's lists). */
const SIDES: Partial<Record<FixField, (x: Ev, title: Card["title"]) => [string | null | undefined, string | null | undefined] | null>> = {
  grade: (x, n) => (x.to_grade_id ? [n(x.from_grade_id), n(x.to_grade_id)] : null),
  position: (x) => (x.event_type === "PROMOTE" && x.to_position ? [x.from_position, x.to_position] : null),
  title: (x, n) => (x.to_position_kind_id ? [n(x.from_position_kind_id), n(x.to_position_kind_id)] : null),
  job: (x, n) => (x.to_job_id || x.to_job ? [n(x.from_job_id) ?? x.from_job, n(x.to_job_id) ?? x.to_job] : null),
  family: (x, n) => (x.to_job_family_id ? [n(x.from_job_family_id), n(x.to_job_family_id)] : null),
  employment_type: (x) => (x.to_employment_type ? [x.from_employment_type && label(EMPLOYMENT_TYPE, x.from_employment_type), label(EMPLOYMENT_TYPE, x.to_employment_type)] : null),
};
const TYPES = ["REGULAR", "CONTRACT", "PART_TIME", "INTERN"] as const;

/**
 * change of a dated field (E4-grade-change): the new value (from the tenant's catalog), from when (today · first of next
 * month · typed; none preselected), why, and the periods side by side. A date ahead is a reservation that applies on
 * that day; recorded as the personnel action it is (PROMOTE · APPOINT · employment-type conversion).
 */
export function FixChange({ c, field, act, onClose, onDone, onCorrect }: { c: Card; field: FixField; act: Act; onClose: () => void; onDone: (message: string) => void; onCorrect: () => void }) {
  const today = todayKst();
  const [to, setTo] = useState<string | null>(null);
  const [when, setWhen] = useState<"today" | "next" | "typed" | null>(null);
  const [typed, setTyped] = useState("");
  const [why, setWhy] = useState<string | null>(null);
  const [end, setEnd] = useState("");
  const [typedTo, setTypedTo] = useState("");
  const [also, setAlso] = useState<"both" | "only" | null>(null);
  const kind = CATALOG_KIND[field as keyof typeof CATALOG_KIND];
  const catalog = (useQuery({ ...jobTitlesQuery, enabled: Boolean(kind) }).data?.items ?? []).filter((x) => x.kind === kind && x.active !== false);
  const reasonsQ = useQuery({ ...reasonCodesQuery("lifecycle_promote"), enabled: act === "PROMOTE" });
  // The form draws once its lists are in (the promotion reasons draw a field of their own too).
  const loading = useCatalogPending(Boolean(kind)) || (act === "PROMOTE" && reasonsQ.isPending);
  const allReasons = reasonOptions("lifecycle_promote", reasonsQ.data?.items);
  const now = currentOf(c, field);
  const fieldName = t(`empFix.field.${field}`);
  const from = when === "today" ? today : when === "next" ? nextMonthFirst(today) : isDate(typed) ? typed : null;
  const k = c.d.classification;
  const nowId = { grade: k.grade_id, position: k.job_title_id, title: k.position_kind_id, job: k.job_id, family: k.job_family_id }[field as "grade"];
  const demotion = act === "PROMOTE" && isDemotion(catalog.find((x) => x.id === nowId), catalog.find((x) => x.id === to));
  const reasons = demotion ? allReasons.filter((x) => x.value === DEMOTION_REASON) : allReasons;
  const options = act === "EMPLOYMENT_TYPE_CHANGE"
    ? TYPES.filter((x) => x !== c.d.employment?.employment_type).map((x) => ({ value: x, label: label(EMPLOYMENT_TYPE, x) }))
    : [];
  // position with no catalog yet: typed, as the promotion takes it (to_position).
  const free = field === "position" && act === "PROMOTE" && catalog.length === 0 && !to;
  const target = free ? (typedTo.trim() || null) : to;
  const toText = free ? typedTo.trim() : catalog.find((o) => o.id === to)?.label ?? options.find((o) => o.value === to)?.label ?? "";
  const needEnd = act === "EMPLOYMENT_TYPE_CHANGE" && to === "CONTRACT";
  // A grade change where the position reads the same word: whether the position follows is asked, never assumed.
  const askTitle = field === "grade" && act === "PROMOTE" && Boolean(c.e.position) && c.e.position === c.title(k.grade_id) && Boolean(target);
  const missing = !target ? "to" : !from ? "when" : act === "PROMOTE" && reasons.length && !reasons.some((x) => x.value === why) ? "why" : askTitle && !also ? "title" : needEnd && !isDate(end) ? "end" : null;
  const body = (): LifecycleRequest => {
    const base = { effective_date: from!, comment: why ? reasons.find((r) => r.value === why)?.label ?? "" : "" };
    if (act === "PROMOTE") return { ...base, event_type: act, reason_code: why, ...(free ? { to_position: target } : field === "grade" ? { to_grade_id: to, ...(askTitle && also === "both" && { to_position: toText }) } : { to_job_title_id: to }) };
    if (act === "APPOINT") return { ...base, event_type: act, ...(field === "title" ? { to_position_kind_id: to } : field === "job" ? { to_job_id: to } : { to_job_family_id: to }) };
    return { ...base, event_type: act, to_employment_type: to as LifecycleRequest["to_employment_type"], contract_end_date: needEnd ? end : undefined };
  };
  const run = useCommand({
    run: (_: undefined, key: string) => recordLifecycleEvent(c.e.id, body(), key),
    invalidates: ["/api/v1/employees"],
    settle: true,
    onSuccess: () => onDone(t(from! > today ? "empFix.change.done.planned" : "empFix.change.done.now", { field: fieldName, to: toText, date: fmtDate(from!) })),
  });
  const press = () => (missing ? document.getElementById(`chg-${missing}`)?.querySelector<HTMLElement>("input")?.focus() : run.mutate(undefined));
  // By period from the hire date (D-17): the act that set today's value dates it, and what it replaced comes first.
  const side = SIDES[field];
  const last = side && (c.events.data?.items ?? []).filter((x) => x.state === "APPLIED" && side(x, c.title)).sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0];
  const before = last && side(last, c.title)?.[0];
  const hire = c.e.hire_date ?? null;
  const table = from && target ? periods({ from: last?.effective_date ?? hire, value: now.text }, { from, value: toText }, before && hire ? { from: hire, value: before } : undefined) : [];
  const verb = t(`empFix.change.verb.${act}`);
  return (
    <Sheet
      open
      kicker={<Who c={c} />}
      title={t("empFix.change.title", { field: fieldName })}
      subtitle={t("empFix.revise.now", { field: fieldName, value: now.text })}
      onClose={onClose}
      pending={run.isPending}
      loading={loading}
      notice={run.isError && <CommandError error={run.error} own={(code) => code === "job_title_unknown" ? t("empFix.catalog.unavailable") : code === "demotion_reason_required" ? t("lifecycle.promote.demotionMissing") : undefined} />}
      consequence={
        <>
          <span><b>{target && from ? t(from > today ? "empFix.change.cons.planned" : "empFix.change.cons.now", { name: c.e.name, field: fieldName, from: now.text, to: toText, date: fmtDate(from) }) : t("empFix.change.cons.pick")}</b></span>
          <span className={s.s12}>{t("empFix.change.cons.rule")}</span>
        </>
      }
      actions={
        <>
          <Button variant="ghost" onClick={onClose}>{t("empFix.cancel")}</Button>
          <Button variant="primary" aria-disabled={missing ? true : undefined} onClick={press}>{from && from > today ? t("empFix.change.commit.planned", { verb, date: fmtDate(from) }) : t("empFix.change.commit.now", { verb })}</Button>
        </>
      }
    >
      <div className="row">
        <Segmented label={t("empFix.change.how")} value="change" onChange={onCorrect} items={[{ id: "change", label: t("empFix.change.chosen") }, { id: "correct", label: t("empFix.change.toCorrectSeg") }]} />
        <span className={s.s12}>{t("empFix.change.howNote", { value: now.text })}</span>
      </div>
      <div id="chg-to">
        {kind ? <CatalogPicker kind={kind} label={t("empFix.change.new", { field: fieldName })} currentId={nowId} value={to} onChange={setTo} /> : <ChipChoice label={t("empFix.change.new", { field: fieldName })} options={options} value={to} onChange={setTo} />}
        {free && <TextInput aria-label={t("empFix.change.new", { field: fieldName })} value={typedTo} onChange={(e) => setTypedTo(e.target.value)} />}
      </div>
      <div id="chg-when">
        <ChipChoice label={t("empFix.change.when")} options={[{ value: "today", label: t("empFix.change.today", { date: fmtDate(today) }) }, { value: "next", label: t("empFix.change.nextMonth", { date: fmtDate(nextMonthFirst(today)) }) }, { value: "typed", label: t("empFix.change.typed") }]} value={when} onChange={(x) => setWhen(x as typeof when)} />
        {when === "typed" && <DateInput label={t("empFix.change.typed")} value={typed} onChange={setTyped} />}
        {from && <p className={s.ok}>{t(from > today ? "empFix.change.echo.planned" : "empFix.change.echo.now", { date: fmtDay(from) })}</p>}
      </div>
      {needEnd && <div id="chg-end"><DateInput label={t("empFix.change.contractEnd")} value={end} onChange={setEnd} /></div>}
      {act === "PROMOTE" && reasons.length > 0 && <div id="chg-why"><ChipChoice label={t("empFix.change.why")} options={reasons} value={why} onChange={setWhy} /></div>}
      {askTitle && (
        <Surface id="chg-title" look="outline">
          <ChipChoice label={t("empFix.change.alsoTitle", { now: c.e.position ?? "" })} options={[{ value: "both", label: t("empFix.change.alsoTitle.both", { to: toText }) }, { value: "only", label: t("empFix.change.alsoTitle.only") }]} value={also} onChange={(v) => setAlso(v as "both" | "only")} />
        </Surface>
      )}
      {table.length > 0 && (
        <RecordRows
          label={t("empFix.change.periods")}
          rows={table}
          rowId={(r) => r.state}
          columns={[
            { header: t("empFix.change.span.head"), cell: (r) => <span className={s.num}>{t("empFix.change.span", { from: r.from ? fmtDate(r.from) : "…", to: r.to ? fmtDate(r.to) : "" })}</span> },
            { header: fieldName, cell: (r) => (r.state === "new" ? <b>{r.value}</b> : r.value) },
            { header: t("empFix.change.record"), cell: (r) => (r.state === "past" ? <Muted>{t("empFix.change.period.past")}</Muted> : <Tag kind={r.state === "new" ? "plan" : "rev"}>{t(`empFix.change.period.${r.state}`)}</Tag>) },
          ]}
        />
      )}
    </Sheet>
  );
}
