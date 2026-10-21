import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { EntitySetupResult } from "@console/api/pending";
import { t } from "@console/i18n";
import { BIZ_KIND, REPRESENTATION, label } from "../../../lib/labels";
import { readDelimited, readXlsx, type Sheet } from "../../../lib/sheet-file";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { TextArea } from "../../../ui/field/text-area";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { StatRow } from "../../../ui/key-value/key-value";
import { buttonClass } from "../../../ui/button/button-class";
import { PageHead } from "../../../ui/page-head/page-head";
import { checklistRef as checklistQuery } from "../../../reference/entity/api";
import { BATCH_READS, entityBatch, type Committed } from "../../../reference/org/api/setup-batch";
import { CommittedReceipt } from "../../../reference/org/ui/batch-receipt";
import { BULK_FIELDS, BULK_OPERATIONS, bulkGaps, entityRowOp, entityRows, guessEntityColumns, type BulkColumns, type BulkOp, type EntityRow } from "../domain/bulk";
import { entityBody } from "../domain/create";
import { BulkEntityRow } from "./bulk-entity-row";

const FILES = [{ mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" }, { mime: "text/csv", ext: ".csv" }, { mime: "text/tab-separated-values", ext: ".tsv" }] as const;

/** Routes compose the entity editor with onboarding permissions and the shared batch receipt.
 * Legal entities use the same dry-run, digest-bound batch and undo as workplace import. */
export function EntityBulkPage({ paste }: { paste: boolean }) {
  const checklist = useQuery(checklistQuery);
  return <QueryState q={checklist}>{(c) => <EntityBulkEditor paste={paste} canAct={c.steps.some((s) => s.key === "entity" && s.can_act)} />}</QueryState>;
}

function EntityBulkEditor({ paste, canAct }: { paste: boolean; canAct: boolean }) {
  const [text, setText] = useState("");
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheet, setSheet] = useState(0);
  const [header, setHeader] = useState(0);
  const [columns, setColumns] = useState<BulkColumns | null>(null);
  const [rows, setRows] = useState<EntityRow[] | null>(null);
  const [dry, setDry] = useState<EntitySetupResult | null>(null);
  const [done, setDone] = useState<Committed | null>(null);
  const words = Object.fromEntries(BULK_FIELDS.map((k) => [k, t(`setup.entityBulk.field.${k}`)])) as Record<typeof BULK_FIELDS[number], string>;
  const grid = sheets[sheet]?.rows ?? [];
  const load = (data: Sheet[]) => {
    setSheets(data); setSheet(0); setHeader(0); setRows(null); setDry(null); setDone(null);
    setColumns(guessEntityColumns(data[0]?.rows[0] ?? [], words));
  };
  const read = useCommand({ run: async (file: File) => /\.xlsx$/i.test(file.name) ? readXlsx(await file.arrayBuffer()) : [{ name: file.name, rows: readDelimited(await file.text()) }], onSuccess: load, forget: true });
  const ops = useMemo(() => (rows ?? []).map(entityRowOp), [rows]);
  const preview = useCommand({ run: () => entityBatch({ dry_run: true, ops }), onSuccess: setDry });
  const apply = useCommand({ run: (_: undefined, key: string) => entityBatch({ dry_run: false, preview_digest: dry!.preview_digest, ops }, key), invalidates: BATCH_READS,
    onSuccess: (r) => { setDry(r); if (r.batch_id) setDone({ orgBatchId: null, entityBatchId: r.batch_id, workplaceIds: {} }); } });
  const resetProof = () => { setDry(null); preview.reset(); apply.reset(); };
  const map = () => {
    const kinds = Object.fromEntries(BIZ_KIND.values.map((k) => [k, label(BIZ_KIND, k)])) as Record<typeof BIZ_KIND.values[number], string>;
    const modes = Object.fromEntries(REPRESENTATION.values.map((k) => [k, label(REPRESENTATION, k)])) as Record<typeof REPRESENTATION.values[number], string>;
    const opsMap = Object.fromEntries(BULK_OPERATIONS.map((o) => [o, t(`setup.entityBulk.op.${o}`)])) as Record<BulkOp, string>;
    setRows(entityRows(grid, header, columns!, kinds, modes, opsMap)); resetProof();
  };
  const missing = rows?.reduce((n, r) => n + bulkGaps(r).length, 0) ?? 0;
  const refused = dry?.items.filter((i) => i.outcome === "ERROR") ?? [];
  const busy = read.isPending || preview.isPending || apply.isPending;
  const mapped = columns && ["name", "kind", "representatives"].every((k) => columns[k as keyof BulkColumns] >= 0);
  const hold = !canAct ? t("setup.permissionNeeded", { permission: t("setup.permission.org::edit") }) : missing ? t("setup.entityBulk.missing", { count: missing }) : !rows?.length ? t("setup.entityBulk.empty") : null;
  const changeSource = () => { setRows(null); resetProof(); };
  return <div className="page form">
    <PageHead title={t(paste ? "setup.entityBulk.paste" : "setup.entityBulk.import")} tools={<Link to="/org/entities" className={buttonClass()}>{t("entityQuick.cancel")}</Link>} />
    {!canAct && <output>{hold}</output>}
    {done ? <CommittedReceipt committed={done} message={t("setup.entityBulk.done", { count: dry?.items.filter((i) => i.outcome !== "ERROR").length ?? 0 })} again={() => { load([]); setText(""); }} /> : <>
      {!rows && <>
        {paste ? <Field label={t("setup.entityBulk.input")} required>
          {(f) => <TextArea {...f} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />}
        </Field> : <FileDrop label={t("setup.entityBulk.file")} accept={FILES} maxBytes={10 * 1048576} onFiles={([f]) => f && !busy && read.mutate(f)} busy={read.isPending ? t("common.loading") : undefined} error={read.isError ? t("orgBulk.import.unreadable") : undefined} />}
        {paste && <Button disabled={!text.trim()} onClick={() => load([{ name: t("setup.entityBulk.input"), rows: readDelimited(text) }])}>{t("setup.entityBulk.columns")}</Button>}
        {columns && <fieldset className="form__group form"><legend>{t("setup.entityBulk.columns")}</legend>
          {sheets.length > 1 && <Field label={t("orgBulk.import.sheet")} required>{(f) => <SelectInput {...f} value={sheet} onChange={(e) => { const i = Number(e.target.value); setSheet(i); setHeader(0); setColumns(guessEntityColumns(sheets[i]?.rows[0] ?? [], words)); }}>
            {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
          </SelectInput>}</Field>}
          <Field label={t("orgBulk.import.headerRow")} required>{(f) => <SelectInput {...f} value={header} onChange={(e) => { const i = Number(e.target.value); setHeader(i); setColumns(guessEntityColumns(grid[i] ?? [], words)); }}>
            {grid.slice(0, 5).map((_, i) => <option key={i} value={i}>{t("orgBulk.import.headerRowN", { n: i + 1 })}</option>)}
          </SelectInput>}</Field>
          {BULK_FIELDS.map((k) => <Field key={k} label={words[k]} required={["name", "kind", "representatives"].includes(k)}>{(f) => <SelectInput {...f} value={columns[k]} onChange={(e) => setColumns({ ...columns, [k]: Number(e.target.value) })}>
            <option value={-1}>{t("setup.entityBulk.unmapped")}</option>
            {(grid[header] ?? []).map((h, i) => <option key={i} value={i}>{h || t("setup.entityBulk.column", { n: i + 1 })}</option>)}
          </SelectInput>}</Field>)}
          <Button disabled={!mapped} onClick={map}>{t("setup.entityBulk.review")}</Button>
        </fieldset>}
      </>}
      {rows && <>
        <StatRow items={[{ key: "entities", label: t("setup.golive.details.legal_entity"), value: rows.length }]} />
        {rows.map((r, i) => (
          <BulkEntityRow
            key={r.line}
            row={r}
            busy={busy}
            error={refused.find((x) => x.ref === String(r.line))?.error?.message}
            set={(draft) => {
              if (busy) return;
              setRows(rows.map((x, j) => (j === i ? { ...x, draft } : x)));
              resetProof();
            }}
            setRow={(updated) => {
              if (busy) return;
              setRows(rows.map((x, j) => (j === i ? updated : x)));
              resetProof();
            }}
          />
        ))}
        {refused.length > 0 && <output role="alert">{t("setup.entityBulk.refused", { count: refused.length })}</output>}
        <CommandError error={preview.error ?? apply.error} />
        <output id="entity-bulk-hold">{hold ?? t("setup.entityBulk.consequence")}</output>
        <div className="form__actions">
          <Button disabled={busy} onClick={changeSource}>{t("setup.entityBulk.back")}</Button>
          <Button aria-disabled={Boolean(hold) || busy} aria-describedby="entity-bulk-hold" onClick={() => !hold && !busy && preview.mutate(undefined)}>{t("setup.entityBulk.preview")}</Button>
          {dry && !refused.length && <Button variant="primary" aria-disabled={Boolean(hold) || busy} aria-describedby="entity-bulk-hold" onClick={() => !hold && !busy && apply.mutate(undefined)}>{t("setup.entityBulk.apply", { count: rows.length })}</Button>}
        </div>
      </>}
    </>}
  </div>;
}
