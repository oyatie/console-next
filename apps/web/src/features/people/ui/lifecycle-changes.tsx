import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Table } from "../../../ui/table";
import type { Verb } from "../domain/lifecycle";
import { fmtDayShort } from "../present";
import s from "./lifecycle.module.css";
import { Muted } from "../../../ui/muted/muted";

type Employee = components["schemas"]["Employee"];
type Unit = components["schemas"]["OrgUnitHead"];
type Row = { k: string; label: string; from: string; to: string };

const siteOf = (units: readonly Unit[], id: string | null | undefined) => {
  const byId = new Map(units.map((u) => [u.id, u]));
  let u = id ? byId.get(id) : undefined;
  while (u && u.kind !== "SITE") u = u.parentId ? byId.get(u.parentId) : undefined;
  return u?.name ?? "";
};

/**
 * What changes (spec E5): before and after, row by row, for the values the request sends — the unit and both units'
 * headcounts, whether the workplace (and so the register) changes, the title, the status and what a leave blocks,
 * the contract end.
 * Rows appear once their value is picked; nothing is guessed.
 */
export function LifecycleChanges({ kind, e, units, v, words }: {
  kind: Verb;
  e: Employee;
  units: readonly Unit[];
  v: { unit: string; position: string; date: string; returnDate: string; endDate: string; contractEnd?: string | null; roleId: string; gradeId: string; toType: string | null };
  /** The role and type before and after, in words (the sheet resolves them from the catalogs). */
  words: { fromGrade: string; toGrade: string; fromRole: string; toRole: string; fromType: string; toType: string };
}) {
  const rows: Row[] = [];
  const to = units.find((u) => u.id === v.unit);
  const from = units.find((u) => u.id === e.org_unit_id);
  if (kind === "TRANSFER" && to) {
    rows.push({ k: "unit", label: t("lifecycle.changes.unit"), from: e.org_unit ?? "—", to: to.name });
    if (from) rows.push({ k: "count", label: t("lifecycle.changes.count"), from: `${from.name} ${from.headcount} → ${from.headcount - 1}`, to: `${to.name} ${to.headcount} → ${to.headcount + 1}` });
    const a = siteOf(units, e.org_unit_id), b = siteOf(units, to.id);
    rows.push({ k: "site", label: t("lifecycle.changes.site"), from: a || "—", to: a === b ? t("lifecycle.changes.siteSame", { site: a }) : t("lifecycle.changes.siteMove", { from: a || "—", to: b }) });
  }
  if (kind === "PROMOTE" && v.gradeId) rows.push({ k: "grade", label: t("empFix.field.grade"), from: words.fromGrade, to: words.toGrade });
  if (kind === "PROMOTE" && v.position.trim()) rows.push({ k: "position", label: t("lifecycle.changes.position"), from: e.position ?? "—", to: v.position.trim() });
  if (kind === "APPOINT" && v.roleId) rows.push({ k: "role", label: t("lifecycle.changes.role"), from: words.fromRole, to: words.toRole });
  if (kind === "EMPLOYMENT_TYPE_CHANGE" && v.toType) {
    rows.push({ k: "type", label: t("lifecycle.changes.type"), from: words.fromType, to: words.toType });
    if (v.toType === "CONTRACT" && v.endDate) rows.push({ k: "contract", label: t("lifecycle.changes.contract"), from: "—", to: fmtDayShort(v.endDate) });
  }
  if (kind === "LEAVE_OF_ABSENCE" && v.date) {
    rows.push({ k: "status", label: t("lifecycle.changes.status"), from: "", to: t("lifecycle.changes.statusLeave", { date: fmtDayShort(v.date) }) });
    rows.push({ k: "blocked", label: t("lifecycle.changes.blocked"), from: "", to: t("lifecycle.changes.blockedLeave") });
    if (v.returnDate) rows.push({ k: "return", label: t("lifecycle.changes.return"), from: "", to: fmtDayShort(v.returnDate) });
  }
  if (kind === "RETURN_FROM_LEAVE" && v.date) rows.push({ k: "status", label: t("lifecycle.changes.status"), from: "", to: t("lifecycle.changes.statusBack", { date: fmtDayShort(v.date) }) });
  if (kind === "CONTRACT_RENEWAL" && v.endDate) rows.push({ k: "contract", label: t("lifecycle.changes.contract"), from: v.contractEnd ? fmtDayShort(v.contractEnd) : "—", to: fmtDayShort(v.endDate) });
  if (rows.length === 0) return null;
  return (
    <section className={s.changes} aria-label={t("lifecycle.changes")}>
      <span className={s.flabel}>{t("lifecycle.changes")}</span>
      <Table
        label={t("lifecycle.changes")}
        rows={rows}
        rowId={(r) => r.k}
        columns={[
          { header: <span className="sr-only">{t("lifecycle.changes")}</span>, cell: (r) => <Muted>{r.label}</Muted>, fit: true },
          { header: <span className="sr-only">{t("lifecycle.now", { where: "" })}</span>, cell: (r) => r.from },
          { header: <span className="sr-only">{t("lifecycle.changes")}</span>, cell: (r) => <b>{r.from ? `→ ${r.to}` : r.to}</b> },
        ]}
      />
    </section>
  );
}
