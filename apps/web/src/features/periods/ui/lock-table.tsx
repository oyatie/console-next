import { LockOpen } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { reasonLabel, type ReasonDomain } from "../../../lib/reason-codes";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Table, type Column } from "../../../ui/table";
import type { PeriodLock } from "../api";
import { requestState, shownRequest } from "../../../reference/periods/domain/request";
import { RelockButton } from "./relock-button";
import { RequestChip } from "./unlock-request";
import { domainText, lockedText, periodText, rangeText } from "../present";
import s from "./period-locks.module.css";

/** A lock's reason: its code in words, then the note (a lock from before reason codes has the note only). */
const reasonText = (domain: ReasonDomain, code: string | undefined, note: string | undefined) =>
  code ? [reasonLabel(domain, code), note && note !== code ? note : ""].filter(Boolean).join(" · ") : (note ?? "—");

/**
 * The latest request's state beside the lock's action: a waiting request is reviewed (its second person) or shown
 * (anyone else); a refused or expired one can be shown, and the lock offers its unlock again.
 */
function ActiveAction({ l, now, onUnlock, onRequest }: { l: PeriodLock; now: number; onUnlock: (l: PeriodLock) => void; onRequest: (l: PeriodLock) => void }) {
  const subject = { domain: domainText(l.domain), period: periodText(l) };
  const r = shownRequest(l, now);
  const state = r && requestState(r, now);
  const show = r && (
    <>
      <RequestChip state={state!} />{" "}
      <Button id={state === "PENDING" ? `pl-unlock-${l.id}` : undefined} variant={r.canDecide && state === "PENDING" ? "primary" : "ghost"} className={s.nowrap} onClick={() => onRequest(l)}>
        {t(r.canDecide && state === "PENDING" ? "periodLocks.request.review" : "periodLocks.request.open", subject)}
      </Button>
    </>
  );
  if (state === "PENDING") return show;
  return (
    <>
      {show}{" "}
      <Button id={`pl-unlock-${l.id}`} className={s.nowrap} onClick={() => onUnlock(l)}>
        <LockOpen size={16} aria-hidden /> {t("periodLocks.unlockOne", subject)}
      </Button>
    </>
  );
}

/**
 * Locks in force, each with its unlock action or its waiting request (one unlocked earlier and locked again on its
 * own says so; the latest request says whether it waits, was refused or ran out), or the locks open now with when,
 * why, until when, and whether a second person approved it or it awaits review. `now`: when the list was read.
 */
export function LockTable({ label, rows, view, now, onUnlock, onRequest, onRelocked }: { label: string; rows: PeriodLock[]; view: "active" | "unlocked"; now: number; onUnlock: (l: PeriodLock) => void; onRequest: (l: PeriodLock) => void; onRelocked: (l: PeriodLock) => void }) {
  const last: Column<PeriodLock> =
    view === "active"
      ? { header: t("periodLocks.col.actions"), fit: true, cell: (l) => <ActiveAction l={l} now={now} onUnlock={onUnlock} onRequest={onRequest} /> }
      : {
          header: t("periodLocks.col.unlock"),
          cell: (l) => (
            <>
              <span className={`num ${s.nowrap}`}>{fmtDateTime(l.unlockedAt)}</span>
              <p className={s.reason}>{reasonText("period_unlock", l.unlockReasonCode, l.unlockReason)}</p>
              {l.relockAt && <p className={s.reason}>{t("periodLocks.unlock.relocksAt", { at: fmtDateTime(l.relockAt) })}</p>}
              {l.unlockApprovedBy && <p className={s.reason}>{t("periodLocks.unlock.approved")}</p>}
              {l.unlockReviewRequired && <Chip tone="warn">{t("periodLocks.unlock.reviewChip")}</Chip>}
              {l.relockAt && <RelockButton lock={l} onLocked={onRelocked} />}
            </>
          ),
        };
  const columns: Column<PeriodLock>[] = [
    { header: t("periodLocks.col.domain"), cell: (l) => domainText(l.domain), fit: true },
    { header: t("periodLocks.col.period"), cell: (l) => <span className="num">{rangeText(l)}</span> },
    {
      header: t("periodLocks.col.reason"),
      cell: (l) => (
        <>
          {reasonText("period_lock", l.reasonCode, l.reason)}
          {l.unlockedAt && l.relockAt && <p className={s.reason}>{t("periodLocks.relocked", { at: fmtDateTime(l.relockAt) })}</p>}
        </>
      ),
      wide: true,
    },
    { header: t("periodLocks.col.lock"), cell: (l) => <span className={`num ${s.nowrap}`}>{lockedText(l)}</span>, fit: true, wide: true },
    last,
  ];
  return <Table label={label} rows={rows} rowId={(l) => l.id} columns={columns} />;
}
