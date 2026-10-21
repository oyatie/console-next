import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, label } from "../../../lib/labels";
import type { AddressValue } from "../../../ui/address-field/address-field";
import { jobTitlesQuery, type CorrectionChanges } from "../api";
import { fullAddress } from "../domain/card";
import { CATALOG_FIELD, correctionField, normalizeDate, type FixField } from "../domain/fix";
import { tx } from "../present";
import type { Card } from "./use-card";

/** A typed new value: text or a date, a pick, or an address from the search. */
export type Draft = string | AddressValue | null;

/** A field's value now, raw (for the change) and as shown in the sheet (dates formatted, the address in full to its fixer). */
export function currentOf(c: Card, field: FixField): { raw: string | null; text: string } {
  const r = c.register.data;
  const date = (d: string | null | undefined) => ({ raw: d ?? null, text: d ? fmtDate(d) : t("empCard.missing") });
  switch (field) {
    case "grade": case "position": case "title": case "family": {
      const id = c.d.classification[CATALOG_FIELD[field]];
      return { raw: id ?? null, text: c.title(id) ?? (field === "position" ? c.e.position : null) ?? t("empCard.missing") };
    }
    case "name": return { raw: c.e.name, text: c.e.name };
    case "employee_number": return { raw: c.e.employee_number ?? null, text: c.e.employee_number ?? t("empCard.missing") };
    case "birth_date": return date(c.facts.data?.birth_date);
    case "hire_date": return date(c.e.hire_date);
    case "group_service_start_date": return date(c.personal.data?.group_service_start_date);
    case "probation_end_date": return date(c.facts.data?.employment?.probation_end_date);
    case "sex": return { raw: r?.sex ?? null, text: r?.sex ? t(`empCard.sex.${r.sex}`) : t("empCard.missing") };
    case "address": return { raw: r?.address ? fullAddress(r.address) : null, text: r?.address ? fullAddress(r.address) : t("empCard.missing") };
    case "employment_type": return { raw: c.d.employment?.employment_type ?? null, text: c.d.employment?.employment_type ? label(EMPLOYMENT_TYPE, c.d.employment.employment_type) : t("empCard.missing") };
    case "job": return { raw: c.e.job ?? null, text: c.e.job ?? t("empCard.missing") };
    default: return { raw: c.e.position ?? null, text: c.e.position ?? t("empCard.missing") };
  }
}

/** A typed value as the sheet says it back (the word for a code, the date formatted, the address in full). */
export function draftText(field: FixField, v: Draft, c: Card): string {
  if (v == null || v === "") return "";
  if (typeof v !== "string") return [v.road, v.detail].filter(Boolean).join(" ") || t("empFix.newAddress");
  if (field in CATALOG_FIELD) return c.title(v) ?? v;
  if (field === "sex") return tx(`empCard.sex.${v}`);
  if (field === "employment_type") return label(EMPLOYMENT_TYPE, v);
  if (field.endsWith("date")) return normalizeDate(v) ? fmtDate(normalizeDate(v)!) : v;
  return v;
}

/** The PATCH change for a typed value; null while nothing (or nothing different, or nothing valid) is typed. */
export function toChange(field: FixField, v: Draft, c: Card): CorrectionChanges | null {
  if (v == null || v === "") return null;
  if (field === "address") {
    if (typeof v === "string") return null;
    const [si = "", sgg = null] = v.road.split(" ");
    return { address: { source: v.verified ? "JUSO" : "MANUAL_UNVERIFIED", road_addr_part1: v.road, jibun_addr: v.jibun ?? null, zip_no: v.zip, detail: v.detail || null, si_nm: si, sgg_nm: sgg, bd_mgt_sn: v.key ?? null } };
  }
  if (typeof v !== "string" || v.trim() === currentOf(c, field).raw) return null;
  const x = field.endsWith("date") ? normalizeDate(v) : v.trim();
  if (!x || x === currentOf(c, field).raw) return null;
  return { [correctionField(field)]: x } as CorrectionChanges;
}

/**
 * Whether a sheet that draws a catalog picker still holds its body (Sheet `loading`) because the catalog is arriving.
 * Drawn before it lands, the picker's loading line turned into chips (or the empty notice) and pushed every field below
 * it down under the pointer (43 px onto the date field of the grade change, first-run-solo under host load).
 */
export function useCatalogPending(draws: boolean) {
  const catalog = useQuery({ ...jobTitlesQuery, enabled: draws });
  return draws && catalog.isPending;
}
