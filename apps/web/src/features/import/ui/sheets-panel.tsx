import { useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import type { ImportPreview, ImportSheet } from "../domain/contract";
import { sheetMapping, type Draft, type Mapping } from "../domain/mapping";
import { fieldLabel, SHEET_TONE, sheetStatusLabel, sourceLabel } from "../present";
import { SheetEditor } from "./sheet-editor";
import css from "./import.module.css";

/**
 * Every sheet of the workbook as the server read it: its status, header row and what each column became (and whether
 * the built-in labels, the tenant's memory or the operator said so). A sheet whose header it could not find is
 * opened for mapping at once; any sheet can be remapped or skipped. Saving reads the same file again.
 */
export function SheetsPanel({ preview, mapping, busy, onRemap }: { preview: ImportPreview; mapping: Mapping; busy: boolean; onRemap: (m: Mapping) => void }) {
  const [open, setOpen] = useState<string | null>(() => preview.sheets.find((s) => s.status === "needs_mapping")?.name ?? null);
  const save = (name: string, d: Draft) => onRemap({ ...mapping, [name]: sheetMapping(d) });
  // r3:hire-18: a sheet skipped because an earlier import skipped it is read this time, in place.
  const unskip = (name: string) => onRemap({ ...mapping, [name]: { skip: false } });
  return (
    <section className="card" aria-labelledby="import-sheets">
      <div className="section-head">
        <h2 id="import-sheets" className="toolbar__title" tabIndex={-1}>{t("importSheet.title", { count: preview.sheets.length })}</h2>
      </div>
      {preview.sheets_needing_mapping > 0 && <p className={`muted ${css.inset}`}>{t("importSheet.needs", { count: preview.sheets_needing_mapping })}</p>}
      {preview.sheets.map((s) => (
        <SheetRow key={s.name} s={s} open={open === s.name} busy={busy} targets={preview.available_targets} onOpen={() => setOpen(open === s.name ? null : s.name)} onSave={(d) => save(s.name, d)} onUnskip={() => unskip(s.name)} />
      ))}
    </section>
  );
}

function SheetRow({ s: sh, open, busy, targets, onOpen, onSave, onUnskip }: {
  s: ImportSheet;
  open: boolean;
  busy: boolean;
  targets: readonly string[];
  onOpen: () => void;
  onSave: (d: Draft) => void;
  onUnskip: () => void;
}) {
  const remembered = sh.status === "skipped" && sh.source === "remembered";
  const mapped = (sh.columns ?? []).filter((c) => c.target);
  const title = t("importSheet.sheet", { name: sh.name });
  return (
    <section className={css.sheet} aria-label={title}>
      <div className="toolbar">
        <h3 className="toolbar__title">{title}</h3>
        <Chip tone={SHEET_TONE[sh.status]}>{remembered ? t("importSheet.status.remembered") : sheetStatusLabel(sh.status)}</Chip>
        <span className="muted num">{t("importSheet.rows", { count: sh.rows })}</span>
        {sh.header_row != null && <span className="muted num">{t("importSheet.headerRow", { row: sh.header_row })}</span>}
        {remembered && <Button variant="primary" disabled={busy} onClick={onUnskip}>{t("importSheet.unskip", { name: sh.name })}</Button>}
        <Button aria-expanded={open} onClick={onOpen}>{t(sh.status === "needs_mapping" ? "importSheet.map" : "importSheet.remap", { name: sh.name })}</Button>
      </div>
      {!open && mapped.length > 0 && (
        <Table
          label={t("importSheet.columns", { name: sh.name })}
          rows={mapped}
          rowId={(c) => c.column}
          columns={[
            { header: t("importSheet.col.column"), cell: (c) => <span className="code">{c.column}</span>, fit: true },
            { header: t("importSheet.col.label"), cell: (c) => c.label },
            { header: t("importSheet.col.target"), cell: (c) => fieldLabel(c.target!) },
            { header: t("importSheet.col.source"), cell: (c) => <Chip tone={c.source === "catalog" ? "neutral" : "info"}>{sourceLabel(c.source)}</Chip>, fit: true },
          ]}
        />
      )}
      {!open && sh.status === "empty" && <p className={`muted ${css.inset}`}>{t("importSheet.empty")}</p>}
      {open && <div className={css.edge}><SheetEditor sheet={sh} targets={targets} busy={busy} onSave={onSave} /></div>}
    </section>
  );
}
