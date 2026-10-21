import { t } from "@console/i18n";
import type { components } from "@console/api/schema";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { Field, TextInput } from "../../../ui/field/field";
import { Table } from "../../../ui/table";
import { Card } from "../../../ui/card/card";
import { previewCounts, type GridField } from "../domain/grid";
import { refusedText } from "../present";
import s from "./grid-page.module.css";

type Preview = components["schemas"]["BulkEmployeeCorrectionPreview"];
type PRow = Preview["rows"][number];
const REASONS = ["SOURCE_MISMATCH", "TYPO", "IMPORT_WRONG", "OTHER"] as const;
const ARROW = "→";
const TOTAL = "__total";
type ColCount = { key: string; changed: number; now: number; second: number; refused: number };
/** The column counts and their total row (spec E6-preview). */
const withTotal = (rows: ColCount[]): ColCount[] => [
  ...rows,
  rows.reduce((a, r) => ({ ...a, changed: a.changed + r.changed, now: a.now + r.now, second: a.second + r.second, refused: a.refused + r.refused }), { key: TOTAL, changed: 0, now: 0, second: 0, refused: 0 }),
];
const DASH = "—";

/**
 * Check (spec E6-preview): what the server will write after checking every row again — by column (changed, now, to a
 * second person, refused) and by row (before → after, how each is recorded) — and the reason and memo every record
 * keeps. Nothing is written until the commit.
 */
export function GridPreview({ preview, columns, label, show, who, reason, onReason, memo, onMemo, tried }: {
  preview: Preview;
  columns: readonly GridField[];
  label: (key: string) => string;
  /** How a field's value from the check reads. */
  show: (key: string, raw: string | null | undefined) => string;
  /** The grid's employee number and name for a person (a refused row carries neither). */
  who: (id: string) => { number: string; name: string } | undefined;
  reason: string | null;
  onReason: (r: string) => void;
  memo: string;
  onMemo: (m: string) => void;
  tried: boolean;
}) {
  const c = previewCounts(preview);
  const by = (key: string) => {
    const fs = preview.rows.flatMap((r) => r.fields.filter((f) => f.field === key).map((f) => ({ f, refused: r.outcome === "REFUSED" })));
    return { changed: fs.length, now: fs.filter((x) => !x.refused && x.f.path !== "SECOND_PERSON").length, second: fs.filter((x) => !x.refused && x.f.path === "SECOND_PERSON").length, refused: fs.filter((x) => x.refused).length };
  };
  const rows = preview.rows.filter((r) => r.outcome !== "UNCHANGED");
  return (
    <div className={s.previewCols}>
      <div className={s.previewMain}>
        <Card titleId="pv-cols" title={t("bulkGrid.preview.cols")} meta={t("bulkGrid.preview.colsSub")}>
          <Table
            label={t("bulkGrid.preview.cols")}
            rows={withTotal(columns.map((f) => ({ key: f.key, ...by(f.key) })))}
            rowId={(r) => r.key}
            columns={[
              { header: t("bulkGrid.preview.col.field"), cell: (r) => <b>{r.key === TOTAL ? t("bulkGrid.preview.total") : label(r.key)}</b> },
              { header: t("bulkGrid.preview.col.changed"), cell: (r) => r.changed, fit: true },
              { header: t("bulkGrid.preview.col.now"), cell: (r) => <b>{r.now}</b>, fit: true },
              { header: t("bulkGrid.preview.col.second"), cell: (r) => r.second, fit: true },
              { header: t("bulkGrid.preview.col.refused"), cell: (r) => <span className={r.refused ? s.err : undefined}>{r.refused}</span>, fit: true },
            ]}
          />
        </Card>
        <Card titleId="pv-rows" title={t("bulkGrid.preview.rows")} meta={<><Chip tone="info">{t("bulkGrid.preview.rowsFilter.change", { n: c.people })}</Chip><Chip tone={c.refused ? "danger" : "neutral"}>{t("bulkGrid.preview.rowsFilter.refused", { n: c.refused })}</Chip></>}>
          <Table<PRow>
            label={t("bulkGrid.preview.rows")}
            rows={rows}
            rowId={(r) => r.employee_id}
            columns={[
              { header: t("bulkGrid.col.number"), cell: (r) => <span className="num">{r.employee_number ?? who(r.employee_id)?.number ?? DASH}</span>, fit: true },
              { header: t("bulkGrid.col.name"), cell: (r) => r.name ?? who(r.employee_id)?.name ?? DASH, fit: true },
              { header: t("bulkGrid.preview.col.cells"), cell: (r) => r.fields.map((f) => label(f.field)).join(" · "), fit: true },
              { header: t("bulkGrid.preview.col.diff"), cell: (r) => r.code ? <span className={s.err}>{(r.refusals?.length ? r.refusals : [{ field: null, code: r.code }]).map((x) => `${x.field ? label(x.field) : t("bulkGrid.wholeRow")} · ${refusedText(x.code)}`).join(" / ")}</span> : r.fields.map((f) => <span key={f.field} className={s.diff}><s>{show(f.field, f.before) || t("bulkGrid.blank")}</s>{ARROW}<b>{show(f.field, f.after) || DASH}</b></span>) },
              { header: t("bulkGrid.preview.col.record"), cell: (r) => [...new Set(r.fields.map((f) => f.path))].map((p) => <Chip key={p} tone={p === "SECOND_PERSON" ? "info" : "warn"}>{t(`bulkGrid.path.${p}`)}</Chip>), fit: true },
            ]}
          />
        </Card>
      </div>
      <Card titleId="pv-side" title={t("bulkGrid.side.title")}>
        <dl className={s.stats}>
          {([["people", c.people], ["cells", c.cells], ["now", c.now], ["second", c.second]] as const).map(([k, n]) => <div key={k}><dt>{t(`bulkGrid.side.${k}`)}</dt><dd>{n}</dd></div>)}
        </dl>
        <p className={s.note}>{t("bulkGrid.side.atomic")}</p>
        {preview.step_up_required && <p className={s.note}>{t("bulkGrid.stepUp")}</p>}
        <ChoiceField label={t("bulkGrid.side.reason")} required look="chips" options={REASONS.map((r) => ({ value: r, label: t(`bulkGrid.reason.${r}`) }))} value={reason} onChange={onReason} error={tried && !reason ? t("reason.field.missing") : undefined} />
        <Field label={t("bulkGrid.side.memo")} required={false}>{(p) => <TextInput {...p} value={memo} maxLength={1000} onChange={(e) => onMemo(e.target.value)} />}</Field>
        <p className={s.box}>{t("bulkGrid.side.undo")}</p>
      </Card>
    </div>
  );
}
