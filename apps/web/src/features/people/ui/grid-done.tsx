import { Link } from "@tanstack/react-router";
import { CalendarClock, Flag } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { Card } from "../../../ui/card/card";
import s from "./grid-page.module.css";

type Result = components["schemas"]["BulkEmployeeCorrectionResult"];

/**
 * Applied (spec E6-done): what was written at once, what waits for a second person, who was skipped because their
 * record changed meanwhile, and the cells left with errors to fix next. No batch undo: corrections are undone one
 * person at a time from the card (backend-followups EMP-UI 11).
 */
export function GridDone({ result, cells, now, reason, left, refusedCells = 0, onFix }: {
  result: Result;
  /** Cells written now and in all, from the check the commit was bound to. */
  cells: number;
  now: number;
  reason: string;
  /** Cells still in error in the grid (never sent). */
  left: number;
  /** Cells the server's check refused (BE-EMP-UI §6): left to fix too; their rows were not skipped for a change meanwhile. */
  refusedCells?: number;
  onFix: () => void;
}) {
  const k = result.counts;
  const refusedRows = result.rows.filter((r) => r.outcome === "REFUSED" && r.code !== "stale_record").length;
  const stats = [["now", now], ["pending", k.pending], ["skipped", k.refused - refusedRows], ["left", left + refusedCells]] as const;
  return (
    <div className={s.previewCols}>
      <Card titleId="gd-title" title={t("bulkGrid.done.title")} meta={<Chip tone="ok">{t("bulkGrid.done.chip")}</Chip>}>
        <p className={s.line}>{t("bulkGrid.done.line", { n: k.change + k.pending, cells, now, reason })}</p>
        <dl className={s.stats}>
          {stats.map(([key, n]) => <div key={key}><dt>{t(`bulkGrid.done.stat.${key}`)}</dt><dd className={key === "left" && n ? s.err : undefined}>{n}</dd></div>)}
        </dl>
        <div className={s.actions}>
          {left + refusedCells > 0 && <Button variant="primary" onClick={onFix}>{t("bulkGrid.done.fix", { n: left + refusedCells })}</Button>}
          {k.pending > 0 && <Link className={buttonClass()} to="/people/requests">{t("bulkGrid.done.pending", { n: k.pending })}</Link>}
          <Link className={buttonClass(left + refusedCells ? "ghost" : "primary")} to="/people" search={{}}>{t("bulkGrid.done.back")}</Link>
        </div>
        <p className={s.note}>{t("bulkGrid.side.undo")}</p>
      </Card>
      <Card titleId="gd-next" title={t("bulkGrid.done.next")}>
        <ul className={s.next}>
          {left + refusedCells > 0 && <li><Flag size={14} aria-hidden />{t("bulkGrid.done.nextLeft", { n: left + refusedCells })}</li>}
          {k.pending > 0 && <li><CalendarClock size={14} aria-hidden />{t("bulkGrid.done.nextPending", { n: k.pending })}</li>}
          {left === 0 && k.pending === 0 && <li>{t("bulkGrid.done.nextNone")}</li>}
        </ul>
      </Card>
    </div>
  );
}
