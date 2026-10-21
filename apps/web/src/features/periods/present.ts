import { session } from "@console/api";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime, fmtMonth } from "@console/i18n/format";
import { domainText, periodText } from "../../reference/periods/present";
import { windowDays, type Window } from "./domain/period";
import type { PeriodLock } from "./api";

export { domainText, monthText, periodText } from "../../reference/periods/present";

/** A month label with its year. */
export const monthShort = (d: string) => fmtMonth(d, "short");
/** A full business date. */
export const dayText = (d: string) => fmtDate(d);

/** An instant as a long date and 24-hour time in Seoul, in the UI language (the Korean year, month and day words). */
export const instantText = (at: string) => fmtDateTime(at);

/** Who locked: the account's name; a lock with no locker is the automatic re-lock, one with no name a removed account. */
const lockerText = (l: PeriodLock) => l.lockedByName ?? t(l.lockedBy ? "periodLocks.closed.removed" : "periodLocks.closed.system");

/** A lock the way people say it: domain, month, closed, then who locked it and when (present.test.ts shows the words). */
export const closedText = (l: PeriodLock) => t("periodLocks.closed", { domain: domainText(l.domain), period: periodText(l), by: lockerText(l), at: instantText(l.lockedAt) });

/**
 * A dated write refused (or about to be) by `lock`: what happened, and the one path there is. The close authority
 * (`canUnlock`) unlocks with a passkey on the period-lock page; anyone else asks one. An exception request does not exist yet
 * (next round, GOVERNANCE): the copy says so and nothing offers it.
 */
export const lockRefusal = (lock: PeriodLock, date: string, canUnlock: boolean) => ({
  title: t("periodLocks.refused.title"),
  reason: t("periodLocks.refused.reason", { date: dayText(date), lock: closedText(lock) }),
  remedy: t(canUnlock ? "periodLocks.refused.unlock" : "periodLocks.refused.ask"),
  exception: t("periodLocks.refused.exception"),
});

/** The signed-in user's name for receipts, or the account label when the token carries none. */
export const actorName = () => session.claims?.name ?? t("shell.account");

/** Whether `userId` is the signed-in user (their own request is never theirs to decide). */
export const mine = (userId: string | undefined) => userId !== undefined && userId === session.claims?.sub;



/** The range with its length, for tables and the derived value. */
export const rangeText = (w: Window) => t("periodLocks.derived", { from: fmtDate(w.periodStart), to: fmtDate(w.periodEnd), days: windowDays(w) });

/**
 * Who locked and when. The by-id user read needs user_manage, which a close authority may lack, so
 * only the viewer's own name is known.
 * names for other holders once the lock list carries `locked_by_name` (BW-15).
 */
export const lockedText = (l: PeriodLock) =>
  l.lockedBy && l.lockedBy === session.claims?.sub && session.claims.name ? t("periodLocks.by", { name: session.claims.name, at: fmtDateTime(l.lockedAt) }) : fmtDateTime(l.lockedAt);
