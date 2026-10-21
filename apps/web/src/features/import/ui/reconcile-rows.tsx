import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Field, TextInput } from "../../../ui/field/field";
import { Table } from "../../../ui/table";
import { SectionHead } from "../../../ui/card/section-head";
import { buttonClass } from "../../../ui/button/button-class";
import { checkRow, reconcileRowsQuery, staleRow } from "../api";
import { importError, outcomeLabel } from "../present";
import type { ImportReconcileRow } from "../domain/contract";
import { CompanyConfirmation } from "./company-confirmation";
import s from "./import.module.css";

const TONE = { UNCHECKED: "neutral", CONFIRMED: "ok", NEEDS_CHECK: "warn" } as const;

/**
 * Each applied row checked (spec E7-row): name and employee no. against the record it became, plus unresolved company source
 * evidence, marked as matching or differing with what differs. J/K move, Y/N mark. A row
 * someone marked meanwhile is refused (409 stale_revision) and read again; after the sign-off every row is frozen.
 */
export function ReconcileRows({ runId, frozen }: { runId: string; frozen: boolean }) {
  const q = useQuery(reconcileRowsQuery(runId));
  const rows = (q.data?.items ?? []) as ImportReconcileRow[];
  const [sel, setSel] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const current = rows.find((r) => r.source_key === sel) ?? rows.find((r) => r.state === "UNCHECKED") ?? rows[0];
  const mark = useCommand({
    run: ({ state }: { state: "CONFIRMED" | "NEEDS_CHECK" }) => checkRow(runId, current!.source_key, { state, note: state === "NEEDS_CHECK" ? note.trim() || null : null, expected_version: current!.version }),
    invalidates: ["/api/v1/employees/import"],
    onSuccess: () => {
      setNote("");
      const next = rows.find((r) => r.state === "UNCHECKED" && r.source_key !== current!.source_key);
      if (next) setSel(next.source_key);
    },
  });
  // Someone marked the row first: the command re-read the rows (409); the row shows what it is now.
  const stale = staleRow(mark.error);
  // J/K move and Enter picks a row (the table's own keys); Y/N mark the picked one, while focus is in this block.
  const box = useRef<HTMLDivElement>(null);
  const yn = useRef<(state: "CONFIRMED" | "NEEDS_CHECK") => void>(() => undefined);
  useEffect(() => void (yn.current = (state) => !frozen && current && mark.mutate({ state })));
  useEffect(() => {
    const el = box.current;
    const keys = (e: KeyboardEvent) => {
      if ((e.target instanceof HTMLElement && e.target.closest("input, textarea")) || (e.key !== "y" && e.key !== "n")) return;
      yn.current(e.key === "y" ? "CONFIRMED" : "NEEDS_CHECK");
    };
    el?.addEventListener("keydown", keys);
    return () => el?.removeEventListener("keydown", keys);
  }, [box]);
  if (!q.data) return <QueryState q={q}>{() => null}</QueryState>;
  const title = t("importReconcile.rows.title", { n: rows.length });
  return (
    <div ref={box} role="group" aria-label={title}>
      <SectionHead>{title}</SectionHead>
      <Table
        label={title}
        rows={rows}
        rowId={(r) => r.source_key}
        selected={current?.source_key}
        onSelect={setSel}
        columns={[
          { header: t("importReconcile.rows.col.at"), cell: (r) => <span className="num">{r.sheet} · {r.row}</span>, fit: true },
          { header: t("importReconcile.rows.col.name"), cell: (r) => r.name ?? "—" },
          { header: t("importReconcile.rows.col.number"), cell: (r) => <span className="code">{r.employee_number ?? "—"}</span>, fit: true },
          { header: t("importReconcile.rows.col.outcome"), cell: (r) => outcomeLabel(r.outcome), fit: true },
          { header: t("importReconcile.rows.col.state"), cell: (r) => <Chip tone={TONE[r.state]}>{t(`importReconcile.state.${r.state}`)}</Chip>, fit: true },
        ]}
      />
      {current && (
        <section className={`${s.resolve} ${s.resolveCard}`} aria-label={t("importReconcile.row.title", { sheet: current.sheet, row: current.row, name: current.name ?? "—" })}>
          <SectionHead level={4}>{t("importReconcile.row.title", { sheet: current.sheet, row: current.row, name: current.name ?? "—" })}</SectionHead>
          {current.company_confirmation && current.state !== "CONFIRMED" && <CompanyConfirmation evidence={current.company_confirmation} />}
          {stale && <p role="status" className="muted">{t("importReconcile.row.stale")}</p>}
          {frozen ? (
            <p className="muted">{t("importReconcile.row.frozen")}</p>
          ) : (
            <>
              <Field label={t("importReconcile.row.note")} required={false}>
                {(p) => <TextInput {...p} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
              </Field>
              <div className={s.choices}>
                <Button variant="primary" aria-disabled={mark.isPending || undefined} onClick={() => mark.mutate({ state: "CONFIRMED" })}>{t("importReconcile.row.ok")}</Button>
                <Button aria-disabled={mark.isPending || undefined} onClick={() => mark.mutate({ state: "NEEDS_CHECK" })}>{t("importReconcile.row.bad")}</Button>
                {current.employee_id && <Link className={buttonClass("ghost")} to="/people/$id" params={{ id: current.employee_id }} search={{}}>{t("importReconcile.row.card")}</Link>}
              </div>
            </>
          )}
          {!stale && <CommandError error={mark.error} own={importError} />}
        </section>
      )}
    </div>
  );
}
