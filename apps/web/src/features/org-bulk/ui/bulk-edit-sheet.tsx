import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { label as enumLabel, INSURANCE_STATUS } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Sheet } from "../../../ui/sheet/sheet";
import { Table } from "../../../ui/table";
import { stepKey } from "../../../reference/entity/api";
import { BATCH_READS, reviseInsurance } from "../api";
import { editLines, type EditLine, type EditRow, type InsuranceState } from "../domain/bulk-edit";
import s from "./bulk.module.css";

const TARGET_LABEL = { LATER: "ESTABLISHED_NUMBER_PENDING", NONE: "NOT_ESTABLISHED" } as const;

const revise = (key: string, l: EditLine, from: string, state: InsuranceState) =>
  reviseInsurance(key, l.id, { expected_version: l.expectedVersion, effective_from: from, reason_code: state === "LATER" ? "INSURANCE_ESTABLISHED" : "ENTRY_CORRECTION", insurers: l.insurers });

/**
 * S7 workplace bulk edit: what changes (the type needs the server's type list, so only the insurance state is offered), the
 * state with nothing preselected, from when, and a per-row before and after that includes the rows that stay. The
 * primary names the real count.
 * one request per workplace, in order, not one transaction; a refused row is named and the rest stand.
 */
export function BulkEditSheet({ rows, entities, onClose }: { rows: EditRow[]; entities: number; onClose: () => void }) {
  const [what, setWhat] = useState<string | null>(null);
  const [state, setState] = useState<InsuranceState | null>(null);
  const [from, setFrom] = useState("");
  const [failed, setFailed] = useState<string[]>([]);
  const lines = state ? editLines(rows, state) : [];
  const changed = lines.filter((l) => l.change);
  const run = useCommand({
    run: async (_: undefined, key: string) => {
      const out: string[] = [];
      let last: unknown;
      for (const [i, l] of changed.entries())
        await revise(stepKey(key, i + 1), l, from, state!).catch((e: unknown) => {
          out.push(l.name);
          last = e;
        });
      if (out.length === changed.length) throw last;
      return out;
    },
    invalidates: BATCH_READS,
    announce: (out) => t("orgBulk.edit.done", { count: changed.length - out.length }),
    onSuccess: (out) => {
      setFailed(out);
      if (!out.length) onClose();
    },
  });
  const ok = what === "insurance" && state !== null && from !== "" && changed.length > 0;
  return (
    <Sheet
      open
      size="lg"
      title={t("orgBulk.edit.title", { count: rows.length })}
      subtitle={t("orgBulk.edit.kicker", { count: rows.length, entities })}
      onClose={onClose}
      pending={run.isPending}
      notice={
        <>
          {failed.length > 0 && <p className={s.danger} role="alert">{t("orgBulk.edit.failed", { count: failed.length, names: failed.join(", ") })}</p>}
          {run.error != null && <CommandError error={run.error} />}
        </>
      }
      consequence={
        state ? (
          <>
            <strong>{t("orgBulk.edit.summary", { changed: changed.length, same: lines.length - changed.length })}</strong>
            {state === "LATER" && changed.length > 0 && <> {t("orgBulk.edit.todo", { count: changed.length })}</>}
            <p className={s.note}>{t("orgBulk.edit.numbers")}</p>
          </>
        ) : (
          t("orgBulk.edit.need")
        )
      }
      actions={
        <>
          <Button onClick={onClose}>{t("orgBulk.cancel")}</Button>
          <Button variant="primary" aria-disabled={!ok || undefined} onClick={() => ok && run.mutate(undefined)}>{t("orgBulk.edit.submit", { count: changed.length })}</Button>
        </>
      }
    >
      <ChoiceField label={t("orgBulk.edit.what")} required options={[{ value: "insurance", label: t("orgBulk.edit.what.insurance") }]} value={what} onChange={setWhat}  />
      <DisabledReason layout="inline" reason={t("orgBulk.edit.kindLater")} control={(p) => <Button {...p}>{t("orgBulk.edit.what.kind")}</Button>} />
      {what === "insurance" && (
        <>
          <ChoiceField
            label={t("orgBulk.site.insurance")}
            required
            options={(["LATER", "NONE"] as const).map((v) => ({ value: v, label: t(`orgBulk.site.insurance.${v}`) }))}
            value={state}
            onChange={(v) => setState(v as InsuranceState)}
          />
          <DisabledReason layout="inline" reason={t("orgBulk.edit.mainLater")} control={(p) => <Button {...p}>{t("orgBulk.site.insurance.MAIN")}</Button>} />
          <DisabledReason layout="inline" reason={t("orgBulk.site.insurance.perLater")} control={(p) => <Button {...p}>{t("orgBulk.site.insurance.PER")}</Button>} />
          <DateField label={t("orgBulk.edit.from")} required value={from} onChange={setFrom} today={todayKst()} />
        </>
      )}
      <Table
        label={t("orgBulk.edit.rows")}
        rows={state ? lines : rows.map((r) => ({ ...r, change: false, before: "EMPTY" as const, insurers: [], expectedVersion: 0 }))}
        rowId={(r) => r.id}
        columns={[
          { header: t("orgBulk.edit.col.site"), cell: (r) => <span><strong>{r.name}</strong> <span className="muted">{r.entity}</span></span> },
          { header: t("orgBulk.edit.col.now"), cell: (r) => (state ? (r.before === "MIXED" || r.before === "EMPTY" ? t(`orgBulk.edit.before.${r.before}`) : enumLabel(INSURANCE_STATUS, r.before)) : "") },
          {
            header: t("orgBulk.edit.col.after"),
            cell: (r) =>
              !state ? <span className="muted">{t("orgBulk.edit.after.pending")}</span>
              : r.change ? <strong>{t("orgBulk.edit.after.to", { status: enumLabel(INSURANCE_STATUS, TARGET_LABEL[state]), date: from ? fmtDate(from) : "" })}</strong>
              : <span className="muted">{t(r.before === "MIXED" ? "orgBulk.edit.after.same" : "orgBulk.edit.after.sameNone")}</span>,
          },
        ]}
      />
    </Sheet>
  );
}
