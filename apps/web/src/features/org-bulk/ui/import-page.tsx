import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { identityProblems } from "../../../reference/entity/domain/names";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileSpreadsheet } from "lucide-react";
import type { OrgStructureNodeServed as Node } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { GateRail } from "../../../ui/gate-rail";
import { Receipt } from "../../../ui/receipt/receipt";
import { entitiesRef as entitiesQuery } from "../../../reference/entity/api";
import { BATCH_READS, commitBatches, headsQuery, structureQuery, type Committed } from "../api";
import { columnsReady, guessColumns, headerRow, readRows, type ColumnMap } from "../domain/columns";
import { entityPrefix, importPlan } from "../domain/import-plan";
import { entityOps, openQuestions, orgOps, ready, emptyAnswers, wpRef, type SiteAnswers } from "../domain/ops";
import { planCounts } from "../domain/plan";
import { entityValues, openPicks, rowEntity, workplaceValues, type Pick } from "../domain/values";
import { readDelimited, readXlsx, type Sheet } from "../../../lib/sheet-file";
import { BulkHead } from "./bulk-head";
import { CommittedReceipt } from "./committed";
import { ImportColumns } from "./import-columns";
import { ImportPreview } from "./import-preview";
import { ImportValues } from "./import-values";
import s from "./bulk.module.css";

const STEPS = ["file", "columns", "values", "preview", "apply"] as const;
type Step = (typeof STEPS)[number];
const FILES = [
  { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "XLSX" },
  { mime: "text/csv", ext: "CSV" },
  { mime: "application/vnd.ms-excel", ext: "CSV" },
  { mime: "text/tab-separated-values", ext: "TSV" },
  { mime: "text/plain", ext: "TXT" },
] as const;
// a 10 MB ceiling for a sheet read in the browser; an org sheet is a few hundred rows.
const MAX_BYTES = 10 * 1048576;

async function readFile(f: File): Promise<Sheet[]> {
  if (/\.xlsx$/i.test(f.name)) return (await readXlsx(await f.arrayBuffer())).filter((x) => x.rows.length > 0);
  return [{ name: f.name, rows: readDelimited(await f.text()) }];
}

/** S7 org sheet import: file → columns → values (exact names only) → preview → apply, one undo for the whole import. */
export function ImportPage() {
  return <AccessGate domain="org" level="edit"><ImportWorkspace /></AccessGate>;
}

function ImportWorkspace() {
  const tree = useQuery(structureQuery);
  return <div className={s.frame}>
    <BulkHead title={t("orgBulk.import.title")} crumb={t("orgBulk.import.crumb")} />
    <QueryState q={tree} layout="form">{(d) => <ImportWizard ents={d.entities.filter((e) => e.kind === "LEGAL_ENTITY")} operating={d.phase === "OPERATING"} />}</QueryState>
  </div>;
}

function ImportWizard({ ents: allEntities, operating }: { ents: Node[]; operating: boolean }) {
  const [file, setFile] = useState<{ name: string; sheets: Sheet[] } | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [sheet, setSheet] = useState(0);
  const [header, setHeader] = useState(0);
  const [cols, setCols] = useState<ColumnMap[]>([]);
  const [step, setStep] = useState<Step>("file");
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [answers, setAnswers] = useState<Record<string, SiteAnswers>>({});
  const [done, setDone] = useState<{ c: Committed; sites: number; depts: number } | null>(null);
  const memo = useRef<{ entity?: Committed }>({});
  const records = useQuery(entitiesQuery);
  const ents = allEntities.filter((n) => records.data?.items.some((e) => e.id === n.id && !e.needs_confirmation && identityProblems(e).length === 0));
  const corp = (id: string) => records.data?.items.find((e) => e.id === id)?.biz_kind === "CORPORATION";

  const grid = useMemo(() => file?.sheets[sheet]?.rows ?? [], [file, sheet]);
  const rows = useMemo(() => readRows(grid, header, cols), [grid, header, cols]);
  const eItems = useMemo(() => entityValues(rows, ents, records.data?.items), [rows, ents, records.data?.items]);
  const wItems = useMemo(() => workplaceValues(rows, ents, (r) => rowEntity(r, ents, picks, eItems)), [rows, ents, picks, eItems]);
  const items = useMemo(() => [...eItems, ...wItems], [eItems, wItems]);
  // org-06: each head employee number the sheet names, resolved in one read (null: nobody still employed has it).
  const numbers = useMemo(() => [...new Set(rows.map((r) => r.head).filter(Boolean))].slice(0, 500), [rows]);
  const found = useQuery(headsQuery(numbers));
  const heads = useMemo(() => {
    const byNumber = new Map((found.data?.items ?? []).map((e) => [e.employee_number ?? "", e.id] as const));
    return new Map(found.isSuccess ? numbers.map((n) => [n, byNumber.get(n) ?? null] as const) : []);
  }, [found.data, found.isSuccess, numbers]);
  const plan = useMemo(() => importPlan(rows, ents, items, picks, heads), [rows, ents, items, picks, heads]);
  const sum = plan.byEntity.map((b) => planCounts(b.rows)).reduce((a, c) => ({ sites: a.sites + c.workplaces, depts: a.depts + c.depts, links: a.links + c.links }), { sites: 0, depts: 0, links: 0 });
  const questions = plan.byEntity.reduce((n, b, i) => n + b.rows.filter((r) => r.level === "workplace" && r.status === "create").reduce((m, r) => m + openQuestions(answers[wpRef(r.at, entityPrefix(i))] ?? emptyAnswers()), 0), 0);

  const pickSheet = (sheets: Sheet[], i: number) => {
    const g = sheets[i]!.rows;
    const h = headerRow(g);
    setSheet(i);
    setHeader(h);
    setCols(guessColumns(g[h] ?? []));
    setPicks({});
  };
  const load = async (f: File) => {
    try {
      const sheets = await readFile(f);
      if (!sheets.length) throw new Error("empty");
      setUnreadable(false);
      setFile({ name: f.name, sheets });
      pickSheet(sheets, 0);
      setStep("columns");
    } catch {
      setUnreadable(true);
    }
  };
  const commit = useCommand({
    run: (_: undefined, key: string) =>
      commitBatches(
        key,
        plan.byEntity.flatMap((b, i) => entityOps({ kind: "entity", node: b.entity }, b.rows, answers, corp(b.entity.id), entityPrefix(i))),
        (ids) => plan.byEntity.flatMap((b, i) => orgOps({ kind: "entity", node: b.entity }, b.rows, ids, entityPrefix(i), heads)),
        memo.current,
      ),
    invalidates: BATCH_READS,
    announce: () => t("orgBulk.import.done", { sites: sum.sites, depts: sum.depts }),
    onSuccess: (c) => {
      setDone({ c, sites: sum.sites, depts: sum.depts });
      setStep("apply");
    },
  });
  const restart = () => {
    setFile(null); setStep("file"); setPicks({}); setAnswers({}); setDone(null); memo.current = {};
  };

  const picksOpen = openPicks(items, picks);
  const canApply = !operating && records.isSuccess && plan.byEntity.every((b, i) => ready(b.rows, answers, entityPrefix(i)) || b.rows.every((r) => r.status === "link")) && sum.sites + sum.depts > 0 && !commit.isPending;
  const used = cols.filter((c) => c.role !== "skip").length;
  const levels = cols.filter((c) => c.role === "path").length;
  const foot =
    step === "file" ? t("orgBulk.import.private")
    : step === "columns" ? (columnsReady(cols) ? t("orgBulk.import.columnsFoot", { total: cols.length, used, levels }) : t("orgBulk.import.columnsNeed"))
    : step === "values" ? (picksOpen ? t("orgBulk.import.valuesFoot", { count: picksOpen }) : t("orgBulk.import.valuesReady"))
    : operating ? t("orgBulk.operating")
    : questions ? t("orgBulk.import.previewFoot.questions", { count: questions })
    : sum.sites + sum.depts === 0 ? t("orgBulk.import.previewFoot.nothing")
    : plan.errors.length ? t("orgBulk.import.previewFoot.errors", { count: plan.errors.length })
    : t("orgBulk.import.previewFoot.ready", { sites: sum.sites, depts: sum.depts, links: sum.links });
  const blocked = (step === "columns" && !columnsReady(cols)) || (step === "values" && picksOpen > 0) || (step === "preview" && !canApply);
  const next = (to: Step) => () => !blocked && setStep(to);

  return (
    <>
      <div className={s.head}>
        <GateRail steps={STEPS.map((k) => ({ key: k, label: t(`orgBulk.import.step.${k}`) }))} current={step} />
        {file && <span className={s.note}><FileSpreadsheet size={14} aria-hidden /> {t("orgBulk.import.fileChip", { file: file.name, sheet: file.sheets[sheet]!.name, rows: rows.length })}</span>}
      </div>
      {step === "file" && (
        <div className={s.body}>
          <FileDrop label={t("orgBulk.import.drop")} hint={t("orgBulk.import.dropHint")} accept={FILES} maxBytes={MAX_BYTES} onFiles={([f]) => f && void load(f)} error={unreadable ? t("orgBulk.import.unreadable") : undefined} />
        </div>
      )}
      {step === "columns" && file && (
        <ImportColumns sheets={file.sheets} sheet={sheet} onSheet={(i) => pickSheet(file.sheets, i)} header={header} onHeader={(h) => {
            setHeader(h);
            setCols(guessColumns(grid[h] ?? []));
          }} cols={cols} onCols={setCols} />
      )}
      {step === "values" && <ImportValues items={items} picks={picks} onPick={(k, p) => setPicks((x) => ({ ...x, [k]: p }))} ents={ents} rowCount={rows.length} />}
      {step === "preview" && <ImportPreview plan={plan} answers={answers} onAnswer={(ref, a) => setAnswers((x) => ({ ...x, [ref]: a }))} />}
      {step === "apply" && done && (
        <div className={s.body}>
          <CommittedReceipt committed={done.c} message={t("orgBulk.import.done", { sites: done.sites, depts: done.depts })} again={restart} againLabel={t("orgBulk.import.again")} />
        </div>
      )}
      {step !== "apply" && (
        <footer className={s.foot}>
          <p className={s.footText} id="import-foot" data-tone={blocked ? "warn" : undefined}>{foot}</p>
          {commit.isPending && <Receipt state="sending" message={t("orgBulk.sending")} />}
          {commit.error != null && <CommandError error={commit.error} />}
          {step !== "file" && <Button onClick={() => setStep(STEPS[STEPS.indexOf(step) - 1]!)}>{t("orgBulk.import.prev")}</Button>}
          {step === "columns" && <Button variant="primary" aria-disabled={blocked || undefined} aria-describedby="import-foot" onClick={next("values")}>{t("orgBulk.import.next.values")}</Button>}
          {step === "values" && <Button variant="primary" aria-disabled={blocked || undefined} aria-describedby="import-foot" onClick={next("preview")}>{t("orgBulk.import.next.preview")}</Button>}
          {step === "preview" && plan.errors.length > 0 && (
            <Button aria-disabled={blocked || undefined} aria-describedby="import-foot" onClick={() => !blocked && commit.mutate(undefined)}>{t("orgBulk.import.applyExcluding", { count: plan.lines.apply })}</Button>
          )}
          {step === "preview" && (
            <Button variant="primary" aria-disabled={blocked || plan.errors.length > 0 || undefined} aria-describedby="import-foot" onClick={() => !blocked && !plan.errors.length && commit.mutate(undefined)}>
              {t("orgBulk.import.apply", { count: sum.sites + sum.depts })}
            </Button>
          )}
        </footer>
      )}
    </>
  );
}
