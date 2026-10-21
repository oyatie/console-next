import { Check, CircleAlert, Info } from "lucide-react";
import { t } from "@console/i18n";
import { ItemList, type Item } from "../../../ui/item-list/item-list";
import { duration, nightMinutes } from "../domain/minutes";
import { cycleDays, weeklyMinutes, type PatternDraft, type RuleCode } from "../domain/pattern";
import { refusalText } from "../present";

/**
 * The legal checks of a pattern as the person types it (A2-types side checks): breaks and 8 hours a day, 40 hours a week (a
 * rotation's average week), weekly rest, and the night note. A check that fails says what to change; the server re-checks.
 */
// The server checks a day in this order (domain schedule/pattern.rs), so the screen names the same first problem.
const DAY_ORDER: readonly RuleCode[] = ["shift_window_invalid", "break_below_minimum", "daily_hours_over_8"];

export function PatternChecks({ draft, problems }: { draft: PatternDraft; problems: readonly RuleCode[] }) {
  const has = (c: RuleCode) => problems.includes(c);
  const line = (key: string, bad: boolean, okText: string, code?: RuleCode): Item => ({
    key,
    tone: bad ? "danger" : "ok",
    mark: bad ? <CircleAlert size={14} aria-hidden /> : <Check size={14} aria-hidden />,
    text: bad && code ? refusalText(code) ?? okText : okText,
  });
  const days = draft.kind === "ROTATION" ? draft.slots.map((s) => s.day) : draft.days;
  const night = days.some((d) => d.shift && nightMinutes(d.shift) > 0);
  const items: Item[] = [
    line("day", has("break_below_minimum") || has("daily_hours_over_8") || has("shift_window_invalid"), t("attendancePatterns.checks.day"), DAY_ORDER.find(has)),
    line("week", has("weekly_hours_over_40"), t("attendancePatterns.checks.week", { week: duration(weeklyMinutes(draft)), cycle: cycleDays(draft) }), "weekly_hours_over_40"),
    line("rest", has("weekly_holiday_missing"), t("attendancePatterns.checks.rest"), "weekly_holiday_missing"),
  ];
  if (draft.kind === "STAGGERED") items.push(line("starts", has("start_choice_invalid"), t("attendancePatterns.checks.starts"), "start_choice_invalid"));
  if (night) items.push({ key: "night", mark: <Info size={14} aria-hidden />, text: t("attendancePatterns.checks.night") });
  return <ItemList label={t("attendancePatterns.checks.title")} items={items} />;
}
