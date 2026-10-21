import { useState, type KeyboardEvent } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { PERIOD_LOCK_DOMAIN } from "../../../lib/labels";
import type { Domain, PeriodLock } from "../api";
import { daysLeft, monthStrip, step, type MonthCell } from "../domain/strip";
import { closedText, domainText, monthShort, monthText } from "../present";
import { Button } from "../../../ui/button/button";
import { RelockButton } from "./relock-button";
import s from "./month-strip.module.css";

type Cell = MonthCell<PeriodLock>;
const focusCell = (row: number, col: number) => document.getElementById(`pl-m-${row}-${col}`)?.focus();
const relockButton = (id: string) => document.getElementById(`pl-open-${id}`)?.querySelector("button")?.focus();

/**
 * Each domain's last twelve months at a glance (governance-39): locked, open until it locks again on its own (with the
 * countdown and the one-click early re-lock below), or open. Arrows move across months and domains; Enter on a locked
 * month shows its lock, on an open one starts a lock of that month, as L does.
 */
export function MonthStrip({ locks, onShowLock, onLockMonth, onRelocked }: { locks: readonly PeriodLock[]; onShowLock: (id: string) => void; onLockMonth: (domain: Domain, month: string) => void; onRelocked: (l: PeriodLock) => void }) {
  const today = todayKst();
  const domains = PERIOD_LOCK_DOMAIN.values as readonly Domain[];
  const rows = domains.map((d) => monthStrip(locks, d, today));
  const [at, setAt] = useState({ row: 0, col: 11 });
  const [now] = useState(Date.now);
  const open = rows.flat().filter((c): c is Extract<Cell, { state: "unlocked" }> => c.state === "unlocked");
  const reopened = [...new Map(open.map((c) => [c.lock.id, c])).values()];

  const label = (d: Domain, c: Cell) => {
    const name = `${domainText(d)} ${monthText(c.month)}`;
    if (c.state === "locked") return t("periodLocks.strip.locked", { name, lock: closedText(c.lock) });
    if (c.state === "unlocked") return t("periodLocks.strip.unlocked", { name, at: fmtDateTime(c.relockAt), days: daysLeft(c.relockAt, now) });
    return t("periodLocks.strip.open", { name });
  };
  const act = (d: Domain, c: Cell) => (c.state === "locked" ? onShowLock(c.lock.id) : c.state === "unlocked" ? relockButton(c.lock.id) : onLockMonth(d, c.month));
  const onKey = (e: KeyboardEvent, row: number, col: number) => {
    const c = rows[row]![col]!;
    if ((e.key === "l" || e.key === "L") && c.state === "open") return (e.preventDefault(), onLockMonth(domains[row]!, c.month));
    const next = step(e.key, { row, col }, rows.length, 12);
    if (!next) return;
    e.preventDefault();
    setAt(next);
    focusCell(next.row, next.col);
  };

  return (
    <section className="card card__body" aria-labelledby="pl-strip">
      <div className="toolbar">
        <h2 id="pl-strip" className="toolbar__title">{t("periodLocks.strip.title")}</h2>
      </div>
      <div role="grid" aria-labelledby="pl-strip" className={s.grid}>
        {rows.map((cells, row) => (
          <div role="row" key={domains[row]} className={s.row}>
            <div role="rowheader" className={s.head}>{domainText(domains[row]!)}</div>
            {cells.map((c, col) => (
              <div role="gridcell" key={c.month}>
                <Button
                  id={`pl-m-${row}-${col}`}
                  variant="ghost"
                  className={s.cell}
                  data-state={c.state}
                  tabIndex={at.row === row && at.col === col ? 0 : -1}
                  aria-label={label(domains[row]!, c)}
                  onFocus={() => setAt({ row, col })}
                  onKeyDown={(e) => onKey(e, row, col)}
                  onClick={() => act(domains[row]!, c)}
                >
                  <span className={s.month}>{monthShort(c.month)}</span>
                  <span className={s.state}>{t(`periodLocks.strip.state.${c.state}`, c.state === "unlocked" ? { days: daysLeft(c.relockAt, now) } : {})}</span>
                </Button>
              </div>
            ))}
          </div>
        ))}
      </div>
      {reopened.length > 0 && (
        <ul className={s.open} aria-label={t("periodLocks.strip.reopened")}>
          {reopened.map((c) => (
            <li key={c.lock.id} id={`pl-open-${c.lock.id}`}>
              <span>{t("periodLocks.strip.relocks", { lock: closedText(c.lock), at: fmtDateTime(c.relockAt), days: daysLeft(c.relockAt, now) })}</span>
              <RelockButton lock={c.lock} onLocked={onRelocked} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
