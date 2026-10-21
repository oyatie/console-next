import { session } from "@console/api";
import { i18n, t } from "@console/i18n";
import { fmtDate, fmtDateTimeShort } from "@console/i18n/format";
import { dayFormat, domainText, periodText } from "../../reference/periods/present";
import { windowDays, type Window } from "./domain/period";
import type { PeriodLock } from "./api";

export { domainText, monthText, periodText } from "../../reference/periods/present";

/** A `YYYY-MM` month by its short name, e.g. "Sep" in English. */
export const monthShort = dayFormat({ month: "short" });
/** A `YYYY-MM-DD` date as month and day, e.g. "September 1" in English. */
export const dayText = dayFormat({ month: "long", day: "numeric" });

/** An instant as a long date and 24-hour time in Seoul, in the UI language (the Korean year, month and day words). */
export const instantText = (at: string) =>
  new Intl.DateTimeFormat(i18n.locale === "ko" ? "ko-KR" : "en-US", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));

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
  l.lockedBy && l.lockedBy === session.claims?.sub && session.claims.name ? t("periodLocks.by", { name: session.claims.name, at: fmtDateTimeShort(l.lockedAt) }) : fmtDateTimeShort(l.lockedAt);
