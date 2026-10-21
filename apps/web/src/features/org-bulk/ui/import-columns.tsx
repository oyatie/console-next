import { t } from "@console/i18n";
import { ArrowRight } from "lucide-react";
import { SelectInput } from "../../../ui/field/select-input";
import { Table } from "../../../ui/table";
import { ROLES, type ColumnMap, type Role } from "../domain/columns";
import type { Sheet } from "../../../lib/sheet-file";
import s from "./bulk.module.css";

const PREVIEW_ROWS = 8;

/**
 * S7 columns: the sheet's first rows with each column's role under its header, and one choice per column. A parent
 * department, a department code and a head employee number are kept (org-06); a column that is not an org unit (shift) stays out and
 * says why.
 */
export function ImportColumns({ sheets, sheet, onSheet, header, onHeader, cols, onCols }: {
  sheets: Sheet[];
  sheet: number;
  onSheet: (i: number) => void;
  header: number;
  onHeader: (i: number) => void;
  cols: ColumnMap[];
  onCols: (c: ColumnMap[]) => void;
}) {
  const rows = sheets[sheet]!.rows;
  const body = rows.slice(header + 1, header + 1 + PREVIEW_ROWS);
  const firstPath = cols.findIndex((c) => c.role === "path");
  const example = body.map((r) => cols.flatMap((c, j) => (c.role === "path" && r[j]?.trim() && r[j] !== "-" ? [r[j]!.trim()] : [])).join(" › ")).find((x) => x.includes(" › "));
  const set = (i: number, role: Role) => onCols(cols.map((c, j) => (j === i ? { ...c, role } : c)));
  return (
    <div className={`${s.body} ${s.cols2}`}>
      <section className={`card ${s.card}`} aria-labelledby="sheet-preview">
        <h2 id="sheet-preview" className={s.cardHead}>
          {t("orgBulk.import.sheetPreview")}
          <span className={s.legend}>{t("orgBulk.import.sheetPreviewMeta", { rows: body.length, header: header + 1 })}</span>
        </h2>
        <div className="row">
          {sheets.length > 1 && (
            <label className="row">
              {t("orgBulk.import.sheet")}
              <SelectInput value={sheet} onChange={(e) => onSheet(Number(e.target.value))}>
                {sheets.map((x, i) => <option key={i} value={i}>{x.name}</option>)}
              </SelectInput>
            </label>
          )}
          <label className="row">
            {t("orgBulk.import.headerRow")}
            <SelectInput value={header} onChange={(e) => onHeader(Number(e.target.value))}>
              {rows.slice(0, 5).map((_, i) => <option key={i} value={i}>{t("orgBulk.import.headerRowN", { n: i + 1 })}</option>)}
            </SelectInput>
          </label>
        </div>
        <div className={s.scrollX}>
          <Table
            label={t("orgBulk.import.sheetPreview")}
            rows={body.map((r, i) => ({ r, line: header + 2 + i }))}
            rowId={(x) => String(x.line)}
            columns={[
              { header: t("orgBulk.import.rowCol"), fit: true, cell: (x) => <span className="num muted">{x.line}</span> },
              ...cols.map((c, j) => ({
                header: (
                  <>
                    {c.header}
                    <span className={s.mapped} data-role={c.role}><ArrowRight size={12} aria-hidden /> {t(`orgBulk.import.role.${c.role}`)}</span>
                  </>
                ),
                cell: (x: { r: string[] }) => x.r[j] || "\u2014",
              })),
            ]}
          />
        </div>
      </section>
      <section className={`card ${s.card}`} aria-labelledby="col-map">
        <h2 id="col-map" className={s.cardHead}>
          {t("orgBulk.import.columns")}
        </h2>
        <ul className={s.mapList}>
          {cols.map((c, i) => (
            <li key={i} className={s.mapRow}>
              <strong>{c.header}</strong>
              <ArrowRight size={14} aria-hidden className="muted" />
              <SelectInput aria-label={t("orgBulk.import.roleFor", { header: c.header })} value={c.role} onChange={(e) => set(i, e.target.value as Role)}>
                {ROLES.map((r) => <option key={r} value={r}>{t(`orgBulk.import.role.${r}`)}</option>)}
              </SelectInput>
              {c.unsupported && <p className={s.note}>{t(`orgBulk.import.unsupported.${c.unsupported}`)}</p>}
              {c.role === "parent" && <p className={s.note}>{t("orgBulk.import.parentNote")}</p>}
              {c.role === "head" && <p className={s.note}>{t("orgBulk.import.headNote")}</p>}
              {i === firstPath && example && <p className={s.note}>{t("orgBulk.import.pathNote", { example })}</p>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
