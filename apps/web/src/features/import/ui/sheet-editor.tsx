import { useState } from "react";
import { t } from "@console/i18n";
import { Button, Check } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { SelectInput } from "../../../ui/field/select-input";
import { Table } from "../../../ui/table";
import type { ImportSheet } from "../domain/contract";
import { draftOf, draftProblem, rereadsSkipped, withHeaderRow, withTarget, type Draft, type DraftColumn } from "../domain/mapping";
import { fieldLabel } from "../present";

/** The select's value for "not imported" (a column the operator leaves out), sent as null. */
const SKIP_COLUMN = "";
/** How many of a header row's labels its choice shows before "…". */
const PREVIEW_LABELS = 4;

/**
 * One sheet's header row and columns, set by the operator: the row that holds the headers (the server offers its
 * likeliest rows), then what each column is, or the whole sheet left out. Nothing is guessed from a near-match label.
 */
export function SheetEditor({ sheet, targets, busy, onSave }: { sheet: ImportSheet; targets: readonly string[]; busy: boolean; onSave: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(() => draftOf(sheet));
  const rows = [...new Set([...(sheet.header_row != null ? [sheet.header_row] : []), ...(sheet.header_candidates ?? []).map((c) => c.row)])];
  const labelsAt = (row: number) => {
    const cells = row === sheet.header_row ? (sheet.columns ?? []) : (sheet.header_candidates?.find((c) => c.row === row)?.cells ?? []);
    const shown = cells.slice(0, PREVIEW_LABELS).map((c) => c.label).join(", ");
    return cells.length > PREVIEW_LABELS ? `${shown}, …` : shown;
  };
  const reread = rereadsSkipped(sheet, d);
  const problem = reread ? null : draftProblem(d);
  const save = t("importSheet.map.save", { name: sheet.name });
  return (
    <div className="form">
      <Check checked={d.skip} onChange={(skip) => setD({ ...d, skip })}>{t("importSheet.map.skip", { name: sheet.name })}</Check>
      {!d.skip && (
        <>
          {reread ? (
            <p className="muted">{t("importSheet.map.reread", { name: sheet.name })}</p>
          ) : rows.length > 0 ? (
            <ChoiceField
              label={t("importSheet.map.headerRow", { name: sheet.name })}
              required
              options={rows.map((r) => ({ value: String(r), label: t("importSheet.map.row", { row: r }), description: labelsAt(r) }))}
              value={d.header_row != null ? String(d.header_row) : null}
              onChange={(v) => setD(withHeaderRow(sheet, d, Number(v)))}
            />
          ) : (
            <p className="muted">{t("importSheet.map.noRows")}</p>
          )}
          {d.columns.length > 0 && (
            <Table
              label={t("importSheet.map.columns", { name: sheet.name })}
              rows={d.columns}
              rowId={(c) => c.column}
              columns={[
                { header: t("importSheet.col.column"), cell: (c) => <span className="code">{c.column}</span>, fit: true },
                { header: t("importSheet.col.label"), cell: (c) => c.label },
                { header: t("importSheet.col.target"), cell: (c) => <Target c={c} sheet={sheet.name} targets={targets} onChange={(v) => setD(withTarget(d, c.column, v))} /> },
              ]}
            />
          )}
        </>
      )}
      <div className="form__actions">
        {problem ? (
          <DisabledReason control={(p) => <Button {...p} variant="primary">{save}</Button>} reason={t(`importSheet.map.problem.${problem}`)} />
        ) : (
          <Button variant="primary" disabled={busy} onClick={() => onSave(d)}>{save}</Button>
        )}
      </div>
    </div>
  );
}

function Target({ c, sheet, targets, onChange }: { c: DraftColumn; sheet: string; targets: readonly string[]; onChange: (v: string | null) => void }) {
  return (
    <SelectInput
      aria-label={t("importSheet.map.target", { sheet, column: c.column, label: c.label })}
      value={c.target ?? SKIP_COLUMN}
      onChange={(e) => onChange(e.target.value === SKIP_COLUMN ? null : e.target.value)}
    >
      <option value={SKIP_COLUMN}>{t("importSheet.map.notImported")}</option>
      {targets.map((x) => <option key={x} value={x}>{fieldLabel(x)}</option>)}
    </SelectInput>
  );
}
