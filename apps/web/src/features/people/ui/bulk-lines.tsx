import { bulkProblemText as problemText } from "../present";
import { useId, type ReactNode } from "react";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { EMPLOYEE_STATUS, labeled } from "../../../lib/labels";
import { UnitPicker } from "../../../reference/org/ui/unit-picker";
import { errorsFirst, type Kind, type Row, type UnitRef } from "../domain/bulk";
import type { Refusal } from "./use-bulk-command";
import s from "./bulk.module.css";

type Unit = components["schemas"]["OrgUnitHead"];
type Outcome = { tone: "ok" | "warn" | "danger"; tag: string; text?: string };

const refusalText = (r: Refusal) => (isMessageId(`bulk.refusal.${r.code}`) ? t(`bulk.refusal.${r.code}` as never) : r.message);

/** What happens to a line: refused by the server, an error that stops the commit, a warning the server may refuse, or ready. */
function outcome(r: Row, kind: Kind | null, refused?: Refusal): Outcome {
  if (refused) return { tone: "danger", tag: t("bulk.result.refused"), text: refusalText(refused) };
  if (r.problem) return { tone: "danger", tag: t("bulk.result.problem"), text: problemText(r, kind) };
  if (r.hint) return { tone: "warn", tag: t("bulk.result.hint"), text: t(`bulk.hint.${r.hint}`) };
  return { tone: "ok", tag: t("bulk.result.ok"), text: r.merged.length ? t("bulk.line.merged", { lines: [r.line, ...r.merged].join(", ") }) : undefined };
}

const refOf = (r: Row) => (r.line ? t("bulk.line.ref", { line: r.line, number: r.number ?? "" }) : (r.employee?.name ?? r.pastedName ?? r.key));

type LinesProps = {
  rows: Row[];
  kind: Kind | null;
  refused: ReadonlyMap<string, Refusal>;
  units: Unit[];
  unitRefs: UnitRef[];
  onPick: (key: string, unitId: string) => void;
  onDrop: (key: string) => void;
  paste: boolean;
  locked: boolean;
};

/** Refused lines first, then errors, then the rest; and a line's refusal, if the server gave one. */
function sortLines(rows: Row[], refused: ReadonlyMap<string, Refusal>) {
  const refusedOf = (r: Row) => (r.employee ? refused.get(r.employee.id) : undefined);
  const sorted = errorsFirst(rows).sort((a, b) => Number(!refusedOf(a)) - Number(!refusedOf(b)));
  return { sorted, refusedOf };
}

/**
 * The batch, line by line, in a long table, errors first. Keyed by employee number for a paste, never by row order.
 * What to fix is BulkIssues, just above it.
 */
export function BulkLines({ rows, kind, refused, unitRefs, paste }: LinesProps) {
  const { sorted, refusedOf } = sortLines(rows, refused);
  const errors = rows.filter((r) => r.problem || refusedOf(r)).length;
  const hints = rows.filter((r) => !r.problem && !refusedOf(r) && r.hint).length;
  const columns: LongColumn<Row>[] = [
    ...(paste ? [{ id: "line", header: t("bulk.col.line"), cell: (r: Row) => <span className="num">{r.line}</span>, width: 56 }] : []),
    { id: "number", header: t("bulk.col.number"), cell: (r) => <span className="code">{r.number ?? r.employee?.employee_number ?? "—"}</span>, width: 120 },
    { id: "name", header: t("bulk.col.name"), cell: (r) => r.employee?.name ?? r.pastedName ?? "—", rowHeader: true },
    { id: "unit", header: t("bulk.col.unit"), cell: (r) => r.employee?.org_unit ?? "—" },
    { id: "status", header: t("bulk.col.status"), cell: (r) => (r.employee ? <Status status={r.employee.status ?? "UNKNOWN"} /> : "—"), width: 88 },
    ...(paste && kind ? [{ id: "target", header: t(`bulk.col.target.${kind}`), cell: (r: Row) => <Target u={unitRefs.find((x) => x.id === r.unitId)} text={r.target} /> }] : []),
    { id: "result", header: t("bulk.col.result"), cell: (r) => <Result o={outcome(r, kind, refusedOf(r))} />, width: "2fr" },
  ];
  return (
    <LongTable
      label={t("bulk.lines")}
      caption={t("bulk.counts", { errors, hints, ok: rows.length - errors - hints })}
      columns={columns}
      rows={sorted}
      rowId={(r) => r.key}
      hasMore={false}
      onLoadMore={() => undefined}
      empty={t("bulk.paste.missing")}
    />
  );
}

/** What to fix before the commit (refusals, errors, then what the server may refuse), each with its remedy right there. */
export function BulkIssues({ rows, kind, refused, units, unitRefs, onPick, onDrop, locked }: LinesProps) {
  const { sorted, refusedOf } = sortLines(rows, refused);
  const issues = sorted.filter((r) => r.problem || r.hint || refusedOf(r));
  if (!issues.length) return null;
  return (
    <ul className={s.issues} aria-label={t("bulk.issues")}>
      {issues.map((r) => {
        const o = outcome(r, kind, refusedOf(r));
        const ref = refOf(r);
        const repick = r.problem === "unitAmbiguous" || r.problem === "unitNotFound";
        return (
          <li key={r.key} className={s.issue} data-tone={o.tone}>
            <span className={s.issueText}>
              <Chip tone={o.tone}>{o.tag}</Chip> <span className="code">{ref}</span>
              {r.employee && r.line ? <> · {r.employee.name}</> : null} · {o.text}
            </span>
            {repick && kind === "TRANSFER" && !locked && (
              <UnitPicker
                units={units}
                options={units.filter((u) => (r.candidates ?? unitRefs).some((c) => c.id === u.id))}
                value=""
                onChange={(id) => id && onPick(r.key, id)}
                labelText={t("bulk.line.repick", { ref })}
              />
            )}
            <Button variant="ghost" disabled={locked} aria-label={t("bulk.line.dropFor", { ref })} onClick={() => onDrop(r.key)}>{t("bulk.line.drop")}</Button>
          </li>
        );
      })}
    </ul>
  );
}

const Result = ({ o }: { o: Outcome }) => (
  <span className={s.result} title={o.text}>
    <Chip tone={o.tone}>{o.tag}</Chip>
    {o.text && <span className={s.resultText}>{o.text}</span>}
  </span>
);

/** The unit by its own name, which fits the column; its full path is the hover title. */
const Target = ({ u, text }: { u?: UnitRef; text?: string }) => (u ? <span title={u.path}>{u.name}</span> : <>{text || "—"}</>);

const Status = ({ status }: { status: string }) => {
  const l = labeled(EMPLOYEE_STATUS, status);
  return <Chip tone={l.tone}>{l.label}</Chip>;
};

/** One titled section of the bulk sheet. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={s.section} aria-labelledby={id}>
      <h3 id={id} className={s.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}
