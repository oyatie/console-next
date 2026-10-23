import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Table } from "../../../ui/table";
import { Card } from "../../../ui/card/card";
import { dryRun, rowLimitOf, runExpired } from "../api";
import type { ImportColumn, ImportDryRun, ImportPreview } from "../domain/contract";
import { sheetsToMap, type Mapping } from "../domain/mapping";
import { type Picks } from "../domain/steps";
import { CLASS_TONE, classLabel, fieldLabel, importError, sourceLabel } from "../present";
import { SheetsPanel } from "./sheets-panel";
import { useExpiry } from "./use-expiry";
import s from "./import.module.css";

type Sample = ImportPreview["sample_rows"][number];
/** A sample cell as text: the server sends JSON values (numbers and dates included), masked where it must. */
const cell = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/**
 * How the server read the workbook: each sheet's header row and columns (set them where it could not tell), what
 * each column becomes, and sample rows; then the dry run. A sheet still to map keeps the dry run closed, with why.
 */
export function PreviewStep({ preview, picks, mapping, rereading, onRemap, onDryRun, onExpired, onRestart }: {
  preview: ImportPreview;
  picks: Picks;
  mapping: Mapping;
  rereading: boolean;
  onRemap: (m: Mapping) => void;
  onDryRun: (d: ImportDryRun) => void;
  onExpired: () => void;
  onRestart: () => void;
}) {
  const dry = useCommand({
    run: () => dryRun(preview.run_id, picks),
    onSuccess: onDryRun,
  });
  const shown = preview.columns.filter((c) => c.preview_allowed);
  const toMap = sheetsToMap(preview.sheets).length;
  const reason =
    toMap > 0 ? t("import.block.sheets", { count: toMap })
    // r3:hire-18: rows held by a skipped sheet are not "no named rows"; the sheet is named with its way back.
    : preview.candidate_rows === 0 && preview.sheets.some((x) => x.status === "skipped") ? t("import.block.skipped", { names: preview.sheets.filter((x) => x.status === "skipped").map((x) => x.name).join(", ") })
    : preview.candidate_rows === 0 ? t("import.block.empty")
    : null;
  useExpiry(dry.error, onExpired);
  // Each column's letter and how it was matched, from the sheet that read it (the first sheet that has it).
  const read = (c: ImportColumn) => preview.sheets.flatMap((x) => x.columns ?? []).find((x) => x.label === c.source_header);
  return (
    <>
      <section className="card">
        <div className="stats">
          <div className="stat"><span className="stat__label">{t("import.stat.preserved")}</span><span className="stat__value num">{fmtNumber(preview.preserved_rows)}</span></div>
          <div className="stat"><span className="stat__label">{t("import.stat.sealed")}</span><span className="stat__value num">{fmtNumber(preview.sealed_identities)}</span></div>
        </div>
      </section>
      {/* The workspace (spec E7-columns): the file as read on the left, the column links on the right. */}
      <div className={s.workspace}>
        <div className={s.pane}>
          {preview.sample_rows.length > 0 && (
            <Card titleId="import-samples" title={t("import.samples")}>
              {/* A wide sheet's cells wrap inside the pane: nothing scrolls sideways out of the keyboard's reach. */}
              <div className={s.wrapCells}>
                <Table
                  label={t("import.samples")}
                  rows={preview.sample_rows}
                  rowId={(r) => `${r.source_sheet}:${r.source_row}`}
                  columns={[
                    { header: t("import.col.sheetRow"), cell: (r) => <span className="num">{r.source_sheet} · {r.source_row}</span>, fit: true },
                    ...shown.map((c) => ({ header: [read(c)?.column, c.source_header].filter(Boolean).join(" "), cell: (r: Sample) => cell(r.values[c.source_header]) })),
                  ]}
                />
              </div>
            </Card>
          )}
          <Card titleId="import-order" title={t("import.order.title")}>
            <ol className={s.order}>
              {(["number", "rrn", "name"] as const).map((k, i) => <li key={k}><Chip>{i + 1}</Chip> <b>{t(`import.order.${k}`)}</b></li>)}
            </ol>
          </Card>
          <SheetsPanel key={preview.run_id} preview={preview} mapping={mapping} busy={rereading} onRemap={onRemap} />
        </div>
        <Card titleId="import-cols" title={t("import.columnsCount", { count: preview.columns.length })}>
          <Table
            label={t("import.columns")}
            rows={preview.columns}
            rowId={(c) => c.source_header}
            columns={[
              { header: t("import.col.letter"), cell: (c) => <span className="code">{read(c)?.column ?? ""}</span>, fit: true },
              { header: t("import.col.source"), cell: (c) => c.source_header },
              { header: t("import.col.target"), cell: (c) => <>{c.target ? <b>{fieldLabel(c.target)}</b> : t("import.col.notImported")}{(c as ImportColumn).notice && <> <Chip tone="warn">{t("import.site.chip")}</Chip></>}</> },
              { header: t("import.col.how"), cell: (c) => (read(c)?.source ? <Chip tone="neutral">{sourceLabel(read(c)!.source)}</Chip> : null), fit: true },
              { header: t("import.col.classification"), cell: (c) => <Chip tone={CLASS_TONE[c.classification]}>{c.classification === "restricted" && c.target ? t("import.class.restrictedKept") : classLabel(c.classification)}</Chip>, fit: true },
            ]}
          />
        </Card>
      </div>
      {!runExpired(dry.error) && (
        <CommandError error={dry.error} own={(code) => (rowLimitOf(dry.error) ? t("import.error.rowLimit", rowLimitOf(dry.error)!) : importError(code))} />
      )}
      <div className="form__actions">
        <Button onClick={onRestart}>{t("import.otherFile")}</Button>
        {reason ? (
          <DisabledReason control={(p) => <Button {...p} variant="primary">{t("import.dryRun")}</Button>} reason={reason} />
        ) : (
          <Button variant="primary" disabled={dry.isPending || rereading} onClick={() => dry.mutate(undefined)}>{t("import.dryRun")}</Button>
        )}
      </div>
    </>
  );
}
