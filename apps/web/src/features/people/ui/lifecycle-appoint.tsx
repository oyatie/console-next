import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { label } from "../../../lib/labels";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { jobTitlesQuery } from "../api";
import { EMPLOYMENT_TYPES } from "../domain/register";
import { activeTitles, type JobTitle } from "../domain/titles";
import { TitleAdd } from "./title-add";
import { VACATE } from "./use-lifecycle-command";
import type { Draft } from "./use-lifecycle-draft";
import s from "./lifecycle.module.css";

const TYPE = { type: "employmentType", values: EMPLOYMENT_TYPES };
const KEEP = "";
/** Up to this many catalog entries show as chips; more are a list. */
const CHIPS = 15;

const pick = (items: readonly JobTitle[], kind: JobTitle["kind"]) => activeTitles(items, kind).slice(0, CHIPS);

/**
 * An appointment edits either the role or the job and job family from the tenant's catalog.
 */
export function AppointFields({ v, set, missing, mode = "role" }: { v: Draft; set: (patch: Partial<Draft>) => void; missing: boolean; mode?: "role" | "job" | "all" }) {
  const catalog = useQuery(jobTitlesQuery).data;
  const items = catalog?.items ?? [];
  // Who keeps the lists is the server's (Cedar job_title_manage): only they get an add chip at the end of each.
  const can = catalog?.can_manage === true;
  const roles = pick(items, "POSITION");
  const jobs = pick(items, "JOB");
  const families = pick(items, "JOB_FAMILY");
  const keep = { value: KEEP, label: t("lifecycle.appoint.keep") };
  if (!can && (mode === "role" ? !roles.length : mode === "job" ? !jobs.length && !families.length : !roles.length && !jobs.length && !families.length)) return null;
  const add = (kind: "POSITION" | "JOB" | "JOB_FAMILY", what: string, key: "roleId" | "jobId" | "familyId") =>
    can ? <TitleAdd kind={kind} what={what} onAdded={(id) => set({ [key]: id })} /> : undefined;
  return (
    <>
      {mode !== "job" && (
        <ChoiceField
          label={t("lifecycle.appoint.role")}
          required={false}
          look="chips"
          options={[...roles.map((r) => ({ value: r.id, label: r.label })), { value: VACATE, label: t("lifecycle.appoint.vacate") }]}
          value={v.roleId || null}
          onChange={(roleId) => set({ roleId })}
          error={missing ? t("lifecycle.appoint.missing") : undefined}
          add={add("POSITION", t("lifecycle.appoint.role"), "roleId")}
        />
      )}
      {mode !== "role" && (jobs.length > 0 || can) && (
        <ChoiceField label={t("lifecycle.appoint.job")} required={false} look="chips" options={[keep, ...jobs.map((r) => ({ value: r.id, label: r.label }))]} value={v.jobId} onChange={(jobId) => set({ jobId })} add={add("JOB", t("lifecycle.appoint.job"), "jobId")} />
      )}
      {mode !== "role" && (families.length > 0 || can) && (
        <ChoiceField label={t("lifecycle.appoint.family")} required={false} look="chips" options={[keep, ...families.map((r) => ({ value: r.id, label: r.label }))]} value={v.familyId} onChange={(familyId) => set({ familyId })} add={add("JOB_FAMILY", t("lifecycle.appoint.family"), "familyId")} />
      )}
    </>
  );
}

/**
 * An employment-type conversion (spec E5-convert, MR-24): the type after (not the current one), no default; a change
 * to a fixed-term contract also takes the new contract's end. Probation is not asked here (the server does not take it with the act).
 */
export function ConvertFields({ current, v, set, today, typeError, endError, locked = false }: {
  current: string | null | undefined;
  v: Draft;
  set: (patch: Partial<Draft>) => void;
  today: string;
  typeError?: string;
  endError?: string;
  locked?: boolean;
}) {
  return (
    <>
      <ChoiceField
        label={t("lifecycle.convert.to")}
        required
        note={t("lifecycle.convert.note", { type: current ? label(TYPE, current) : "—" })}
        look="chips"
        options={EMPLOYMENT_TYPES.map((x) => ({ value: x, label: label(TYPE, x), disabled: locked && (x === "CONTRACT") !== Boolean(v.endDate) ? t("lifecycle.convert.dateLocked") : !locked && x === current ? t("lifecycle.convert.current") : undefined }))}
        value={v.toType}
        onChange={(toType) => set({ toType })}
        error={typeError}
      />
      {v.toType === "CONTRACT" && (
        locked ? <p className={s.fact}>{t("lifecycle.convert.endLocked", { date: v.endDate || "—" })}</p>
        : <DateField label={t("lifecycle.changes.contract")} required today={today} min={v.date || undefined} value={v.endDate} onChange={(endDate) => set({ endDate })} error={endError} />
      )}
    </>
  );
}
