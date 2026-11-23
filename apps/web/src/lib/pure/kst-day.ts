// SPDX-License-Identifier: LicenseRef-Proprietary
import { todayKst } from "./today";

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

function isValidCalendarDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Normalizes an ISO date or timestamp into a KST calendar day (`YYYY-MM-DD`). */
export function kstDayIso(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const prefix = ISO_PREFIX_RE.exec(iso);
  if (prefix) {
    const valid = isValidCalendarDay(Number(prefix[1]), Number(prefix[2]), Number(prefix[3]));
    if (!valid) return null;
    if (ISO_DAY_RE.test(iso)) return iso;
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return todayKst(new Date(parsed));
}

/** Extracts `MM-DD` in KST from an ISO date or timestamp. */
export function shortMonthDay(iso: string | undefined | null): string | null {
  const day = kstDayIso(iso);
  return day ? day.slice(5) : null;
}
