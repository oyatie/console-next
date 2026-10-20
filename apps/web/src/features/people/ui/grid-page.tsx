import { useCallback, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Columns3, ClipboardPaste, X } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { label } from "../../../lib/labels";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { Button, IconButton, ToggleButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { Kbd } from "../../../ui/kbd/kbd";
import { StepLine } from "../../../ui/step-line/step-line";
import { Crumbs } from "../../../ui/page-head/crumbs";
import { PageHead } from "../../../ui/page-head/page-head";
import { commitBulkCorrection, previewBulkCorrection } from "../api";
import { DEFAULT_COLUMNS, GRID_FIELDS, TYPES, previewCounts, readCell, refusedCells, rowState, shownText, shownValue, type GridKey } from "../domain/grid";
import { GridColumns } from "./grid-columns";
import { GridDone } from "./grid-done";
import { GridPreview } from "./grid-preview";
import { GridTable, type GridRow } from "./grid-table";
import { useBulkSelection } from "./use-bulk-selection";
import { useGridData } from "./use-grid-data";
import s from "./grid-page.module.css";

type Preview = components["schemas"]["BulkEmployeeCorrectionPreview"];
type Result = components["schemas"]["BulkEmployeeCorrectionResult"];
type Filter = "all" | "changed" | "error" | "same";
const TYPE = { type: "employmentType", values: TYPES };

/**
 * Bulk edit (spec E6-grid, preview and done; MR-27): the picked people in a grid of the columns chosen, typed or pasted
 * into; the server then checks every row again and says what it will write (now, or after a second person), and one
 * commit bound to that check writes it. Dated changes for many people are not served: those columns are corrections.
 */
export function GridPage() {
  const nav = useNavigate();
  const picked = useBulkSelection();
  const [cols, setCols] = useState<GridKey[]>([...DEFAULT_COLUMNS]);
  const [pick, setPick] = useState(false);
  const closePick = useCallback(() => setPick(false), []);
  const [typed, setTyped] = useState<Record<string, Partial<Record<GridKey, string>>>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [activeCell, setActiveCell] = useState<{ r: number; c: number } | null>(null);
  const [step, setStep] = useState<"edit" | "check" | "done">("edit");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [memo, setMemo] = useState("");
  const [tried, setTried] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // Cells the server refused at the last check (BE-EMP-UI §6), marked once the user is back in the grid: errors until
  // typed again (marking them during the check would change what the commit re-checks).
  const [marks, setMarks] = useState<Record<string, Record<string, string>>>({});
  const fields = cols.map((k) => GRID_FIELDS.find((f) => f.key === k)!);
  const data = useGridData(picked, cols);
  const words = (k: GridKey): Record<string, string> =>
    k === "sex" ? { MALE: t("bulkGrid.sex.MALE"), FEMALE: t("bulkGrid.sex.FEMALE") } : k === "employment_type" ? Object.fromEntries(TYPES.map((v) => [v, label(TYPE, v)])) : {};
  const fieldLabel = (key: string) => t(`bulkGrid.field.${key as GridKey}`);

  const rows: GridRow[] = data.people.map((e, i) => {
    const current = fields.map((f) => shownValue(f, data.value(i, f.key), words(f.key)));
    const tp = fields.map((f) => typed[e.id]?.[f.key]);
    return { id: e.id, number: e.employee_number ?? "—", name: e.name, current, typed: tp, cells: fields.map((f, c) => {
      const refused = marks[e.id]?.[f.key];
      if (refused) return { bad: "server" as const, code: refused };
      return tp[c] === undefined || tp[c] === current[c] ? { keep: true as const } : readCell(f, tp[c]!, words(f.key));
    }) };
  });
  const states = rows.map((r) => rowState(r.cells, r.current, r.typed.map((x, c) => x ?? r.current[c]!)));
  const count = (k: Filter) => states.filter((x) => (k === "all" ? true : k === "error" ? x.errors > 0 : k === "changed" ? x.changed > 0 && !x.errors : !x.changed && !x.errors)).length;
  const shown = rows.filter((_, i) => filter === "all" || (filter === "error" ? states[i]!.errors > 0 : filter === "changed" ? states[i]!.changed > 0 && !states[i]!.errors : !states[i]!.changed && !states[i]!.errors));
  const cellsBy = (cls: "now" | "second") => rows.reduce((n, r) => n + r.cells.filter((c, i) => "send" in c && fields[i]!.cls === cls && r.typed[i] !== r.current[i]).length, 0);
  const errors = states.reduce((n, x) => n + x.errors, 0);
  const firstError = () => {
    const r = rows.findIndex((row) => row.cells.some((cell) => "bad" in cell));
    if (r < 0) return;
    setFilter("all");
    setActiveCell({ r, c: rows[r]!.cells.findIndex((cell) => "bad" in cell) });
  };

  const body = () => ({
    rows: rows.flatMap((r, i) => {
      const changes = Object.fromEntries(r.cells.flatMap((c, ci) => ("send" in c && r.typed[ci] !== r.current[ci] ? [[fields[ci]!.key, c.send]] : [])));
      return Object.keys(changes).length ? [{ employee_id: r.id, changes, expected_updated_at: data.updatedAt(i) }] : [];
    }),
    // The check runs before a reason is picked (it shows what would be written); the commit re-checks with it.
    reason_code: reason ?? "PREVIEW",
    note: memo.trim() || undefined,
  });
  const check = useCommand({ run: () => previewBulkCorrection(body()), onSuccess: (p) => (setPreview(p), setStep("check")) });
  // The digest binds the reason and memo too: the commit checks again with them, and writes only when that check says
  // the same as the one on screen (otherwise the new one is shown and nothing is written).
  const commit = useCommand({
    run: async (_: void, key: string) => {
      const again = await previewBulkCorrection(body());
      const [a, b] = [previewCounts(preview!), previewCounts(again)];
      if (a.cells !== b.cells || a.refused !== b.refused || a.people !== b.people) {
        setPreview(again);
        throw new Error(t("bulkGrid.changedMeanwhile"));
      }
      return commitBulkCorrection({ ...body(), preview_digest: again.preview_digest }, key);
    },
    invalidates: ["/api/v1/employees"],
    onSuccess: (r) => (setResult(r), setStep("done")),
  });
  // After applying, the grid keeps only what was not written: cells in error, and every cell of a refused row.
  const fixLeft = () => {
    const refused = new Set(result?.rows.filter((r) => r.outcome === "REFUSED").map((r) => r.employee_id));
    setTyped(Object.fromEntries(rows.map((r) => [r.id, Object.fromEntries(r.cells.flatMap((c, i) => (r.typed[i] !== undefined && ("bad" in c || refused.has(r.id)) ? [[fields[i]!.key, r.typed[i]]] : [])))])));
    if (preview) setMarks(refusedCells(preview));
    setPreview(null);
    setResult(null);
    setReason(null);
    setTried(false);
    setStep("edit");
  };

  // The scope reads as the one unit everyone is in, else "the picked people".
  const units = new Set(data.people.map((e) => e.org_unit ?? ""));
  const scope = units.size === 1 && [...units][0] ? [...units][0]! : t("bulkGrid.scopeAll");
  if (picked.size === 0)
    return <div className="page"><EmptyState title={t("bulk.page.empty.title")} reason={t("bulk.page.empty.reason")} actions={<Link className={buttonClass("primary")} to="/people" search={{}}>{t("bulk.page.empty.action")}</Link>} /></div>;
  const c = preview ? previewCounts(preview) : null;
  const steps = [
    { key: "people", label: t("bulkGrid.step.people"), state: "done" as const },
    { key: "edit", label: t("bulkGrid.step.edit"), state: step === "edit" ? ("current" as const) : ("done" as const) },
    { key: "check", label: t("bulkGrid.step.check"), state: step === "check" ? ("current" as const) : step === "done" ? ("done" as const) : ("waiting" as const) },
    { key: "apply", label: t("bulkGrid.step.apply"), state: step === "done" ? ("current" as const) : ("waiting" as const) },
  ];
  return (
    <div className={s.page}>
      <PageHead
        band
        crumbs={<Crumbs items={[<Link key="people" to="/people" search={{}}>{t("people.title")}</Link>]} current={t("bulkGrid.crumb")} />}
        title={t("bulkGrid.title", { scope })}
        tools={<><StepLine steps={steps} label={t("bulk.page.steps")} /><IconButton label={t("bulk.page.close")} onClick={() => void nav({ to: "/people", search: {} })}><X size={16} aria-hidden /></IconButton></>}
      />
      {step === "edit" && (
        <>
          <div className={s.toolbar}>
            {pick && <GridColumns value={cols} onChange={setCols} onClose={closePick} />}
            <span className={s.source}>{t("bulkGrid.source", { n: rows.length })}</span>
            <div role="group" aria-label={t("bulkGrid.filter")} className={s.filters}>
              {(["all", "changed", "error", "same"] as const).map((k) => <ToggleButton key={k} pressed={filter === k} onClick={() => setFilter(k)}>{t(`bulkGrid.filter.${k}`, { n: count(k) })}</ToggleButton>)}
            </div>
            <span className={s.grow} />
            <Button aria-expanded={pick} onClick={() => setPick((x) => !x)}><Columns3 size={16} aria-hidden />{t("bulkGrid.columns", { n: cols.length })}</Button>
            <Button onClick={() => setActiveCell({ r: 0, c: 0 })}><ClipboardPaste size={16} aria-hidden />{t("bulkGrid.paste")}<Kbd keys="⌘V" /></Button>
            <Button onClick={() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true, bubbles: true }))}>{t("bulkGrid.fill")}<Kbd keys="Ctrl+D" /></Button>
          </div>
          <div className={s.verbs}>
            <b>{t("bulkGrid.verbs")}</b>
            {fields.filter((f) => f.cls !== "now").length > 0 && <span className={s.note}>{t("bulkGrid.verb.secondHint")}</span>}
            <span className={s.verbChip}>{t("bulkGrid.verb.correct")}</span>
            <span className={s.verbOff} title={t("bulkGrid.verb.changeClosed")}>{t("bulkGrid.verb.change")}</span>
            <span className={s.note}>{t("bulkGrid.verb.changeClosed")}</span>
          </div>
          <div className={s.gridWrap}>
            <GridTable rows={shown} columns={fields} activeCell={activeCell} onActiveChange={setActiveCell} label={t("bulkGrid.title", { scope: t("bulkGrid.scopeAll") })} onCell={(id, ci, text) => (setTyped((x) => ({ ...x, [id]: { ...x[id], [fields[ci]!.key]: text } })), setMarks((m) => (m[id] ? { ...m, [id]: {} } : m)))} statusOf={(r) => {
              const st = states[rows.indexOf(r)]!;
              return st.errors ? { tone: "error", text: t("bulkGrid.status.error") } : st.changed ? { tone: "changed", text: t("bulkGrid.status.changed", { n: st.changed }) } : { tone: "same", text: t("bulkGrid.status.same") };
            }} fieldLabel={(f) => fieldLabel(f.key)} suggestionOf={(cell) => ("bad" in cell ? cell.suggest : undefined)} />
          </div>
        </>
      )}
      {step === "done" && result && c && <GridDone result={result} cells={c.cells} now={c.now} reason={reason ? t(`bulkGrid.reason.${reason}` as never) : ""} left={errors} refusedCells={preview ? Object.values(refusedCells(preview)).reduce((n, m) => n + Object.keys(m).length, 0) : 0} onFix={fixLeft} />}
      {step === "check" && preview && <GridPreview preview={preview} columns={fields} label={fieldLabel} show={(key, raw) => { const f = GRID_FIELDS.find((x) => x.key === key); return f ? shownText(f, raw, words(f.key)) : (raw ?? ""); }} who={(id) => rows.find((r) => r.id === id)} reason={reason} onReason={setReason} memo={memo} onMemo={setMemo} tried={tried} />}
      {step !== "done" && <footer className={s.bar}>
        <div className={s.barText}>
          {step === "check" && c ? <b>{t(c.refused ? "bulkGrid.preview.foot" : "bulkGrid.preview.footClean", { ...c, n: c.people })}</b>
          : <><b>{t("bulkGrid.foot", { n: rows.filter((_, i) => states[i]!.changed > 0).length, now: cellsBy("now"), second: cellsBy("second"), errors })}</b></>}
          <CommandError error={check.error ?? commit.error} own={(code) => (code === "rows_changed_since_preview" ? t("bulkGrid.changedMeanwhile") : undefined)} />
        </div>
        {step === "edit" && errors > 0 && <Button onClick={firstError}>{t("bulkGrid.firstError")}<Kbd keys="F8" /></Button>}
        {step === "edit" && <Button variant="primary" aria-disabled={check.isPending || body().rows.length === 0 || undefined} onClick={() => body().rows.length > 0 && check.mutate()}>{errors ? t("bulkGrid.toCheck", { n: errors }) : t("bulkGrid.toCheckClean")}<Kbd keys="⌘↵" /></Button>}
        {step === "check" && <Button variant="ghost" onClick={() => (preview && setMarks(refusedCells(preview)), setStep("edit"))}>{t("bulkGrid.back")}</Button>}
        {step === "check" && c && <Button variant="primary" aria-disabled={commit.isPending || undefined} onClick={() => (setTried(true), reason && commit.mutate())}>{t("bulkGrid.commit", { n: c.people, cells: c.cells })}<Kbd keys="⌘↵" /></Button>}
      </footer>}
    </div>
  );
}
