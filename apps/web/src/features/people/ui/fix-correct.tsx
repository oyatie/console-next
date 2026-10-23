import { useState, type ReactNode } from "react";
import { PencilLine } from "lucide-react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { Chip } from "../../../ui/chip";
import { Composer } from "../../../ui/composer/composer";
import { correctEmployee, isStale, type Correction, type CorrectionChanges } from "../api";
import { SheetConflict } from "./sheet-conflict";
import { serviceSpan } from "../domain/card";
import { CATALOG_FIELD, FIELD_CLASS, FIX_REASONS, HIGH_RISK, dayDiff, normalizeDate, type FixField } from "../domain/fix";
import { fmtDay } from "../present";
import { currentOf, draftText, toChange, useCatalogPending, type Draft } from "./use-fix-draft";
import { FixValue } from "./fix-value";
import type { Card } from "./use-card";
import { Card as Surface } from "../../../ui/card/card";
import s from "./card.module.css";
import { Who } from "./card-who";

/** The employee register item each field fills (Labor Standards Act Decree §20). */
const REGISTER_NO: Partial<Record<FixField, number>> = { name: 1, sex: 2, birth_date: 3, address: 4, job: 6, hire_date: 7, employment_type: 7 };

/**
 * correction of one field (E4-hire-correct): what it is now (struck) beside the value it becomes, with the date's weekday
 * and the shift; why (no default); what follows from it; then who confirms. A high-risk field goes to a second person
 * when one holds the grant (the value stays until then); a sole holder applies it after a passkey with a review flag.
 */
export function FixCorrect({ c, field, onClose, onDone, lead }: { c: Card; field: FixField; onClose: () => void; onDone: (out: Correction) => void; lead?: ReactNode }) {
  const [v, setV] = useState<Draft>(null);
  const [why, setWhy] = useState<string | null>(null);
  const now = currentOf(c, field);
  // The version the sheet opened against; only an explicit "keep mine" after a conflict sends the re-read one.
  const [opened] = useState({ text: now.text, at: c.e.updated_at });
  const [keep, setKeep] = useState<boolean | null>(null);
  const label = t(`empFix.field.${field}`);
  const catalogPending = useCatalogPending(field in CATALOG_FIELD);
  const change = toChange(field, v, c);
  const two = HIGH_RISK.has(field) && (field !== "group_service_start_date" || now.raw != null);
  const run = useCommand({
    run: () => correctEmployee(c.e.id, keep ? c.e.updated_at : opened.at, change as CorrectionChanges, why!),
    invalidates: ["/api/v1/employees", "/api/v1/change-requests"],
    settle: true,
    onSuccess: onDone,
  });
  const stale = run.isError && isStale(run.error);
  const missing = !change ? "value" : !why ? "why" : stale && keep === null ? "conflict" : null;
  const press = () => {
    if (missing) return void document.getElementById(`fix-${missing}`)?.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
    if (stale && keep === false) return onClose();
    run.mutate(undefined);
  };
  const isDateField = field.endsWith("date");
  const typedDate = isDateField && typeof v === "string" ? normalizeDate(v) : null;
  const shift = typedDate && typeof now.raw === "string" ? dayDiff(now.raw, typedDate) : null;
  const span = field === "hire_date" && typedDate && c.e.hire_date ? [serviceSpan(c.e.hire_date, todayKst()), serviceSpan(typedDate, todayKst())] : null;
  return (
    <Composer
      open
      kicker={<Who c={c} />}
      title={t("empFix.title", { field: label })}
      onClose={onClose}
      pending={run.isPending}
      loading={catalogPending}
      notice={stale ? <div id="fix-conflict"><SheetConflict field={label} opened={opened.text} now={now.text} mine={draftText(field, v, c)} error={run.error} onChoose={setKeep} /></div> : run.isError && <CommandError error={run.error} own={(code) => code === "job_title_unknown" ? t("empFix.catalog.unavailable") : undefined} />}
      consequence={
        <>
          <span><b>{change ? t("empFix.cons.what", { field: label, from: now.text, to: draftText(field, v, c) }) : t("empFix.cons.pick")}</b></span>
          <span className={s.s12}>{t(two ? "empFix.cons.two" : "empFix.cons.now")} {missing && t("empFix.cons.press")}</span>
        </>
      }
      action={{ kind: "profile", mode: "correct", count: 1 }}
      incomplete={Boolean(missing)}
      recovery={stale && keep === false ? <Button onClick={onClose}>{t("composer.dismiss")}</Button> : undefined}
      onSubmit={press}
    >
      {lead}
      <div className="row"><Chip tone="warn">{t("uiRecord.mark.cor")}</Chip>{REGISTER_NO[field] && <Chip>{t("empFix.registerItem", { no: REGISTER_NO[field] })}</Chip>}{two && <Chip tone="info">{t("empFix.second")}</Chip>}</div>
      {FIELD_CLASS[field] !== "rev" && <Surface look="dashed"><span className={s.stackHead}><PencilLine size={13} aria-hidden /> {t(`empFix.explain.${field === "hire_date" ? "hire" : "other"}`, { field: label })}</span></Surface>}
      <Surface look="outline"><div className={s.nowNew}>
        <span className={s.s12}>{t("empFix.now")}</span>
        <span><s className={s.num}>{now.text}</s></span>
        <span className={s.s12}>{t("empFix.to")}</span>
        <div id="fix-value"><FixValue c={c} field={field} value={v} onChange={setV} focus /></div>
        {shift != null && typedDate && <><span /><span className={s.ok}>{t("empFix.shift", { date: fmtDay(typedDate), days: Math.abs(shift), dir: shift < 0 ? "earlier" : "later" })}</span></>}
      </div></Surface>
      <div id="fix-why">
        <ChipChoice label={t("empFix.why")} options={FIX_REASONS.map((r) => ({ value: r, label: t(`empFix.reason.${r}`) }))} value={why} onChange={setWhy} />
        <p className={s.note}>{t("empFix.law")}</p>
      </div>
      <Surface look="outline">
        <b>{t("empFix.follows")}</b>
        <p className={s.note}>{t(field === "hire_date" ? "empFix.follows.hire" : "empFix.follows.none")}</p>
        {span?.[0] && span[1] && <p className={s.note}>{t("empFix.derived.tenure", { from: t("empCard.tenure", span[0]), to: t("empCard.tenure", span[1]) })}</p>}
      </Surface>
      <p className={s.note}>{t("empFix.evidence")}</p>
    </Composer>
  );
}
