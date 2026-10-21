import type { koUiDate } from "../ko/ui-date";

export const enUiDate: Record<keyof typeof koUiDate, string> = {
  "uiDate.presets": "Quick picks for {label}",
  "uiDate.today": "Today",
  "uiDate.ahead": "In {days, plural, one {# day} other {# days}}",
  "uiDate.ago": "{days, plural, one {# day} other {# days}} ago",
  "uiDate.bounds": "Pick a date from {min} to {max}",
  "uiDate.bounds.from": "Pick a date from {min}",
  "uiDate.bounds.until": "Pick a date up to {max}",
  "uiDate.outOfRange": "This date is outside the range you can pick.",
  "uiDate.weekend": "That is a {day}. The first working day is {next}.",
  "uiDate.weekend.use": "Change to {next}",
  "uiDate.direct": "Type it",
  "uiDate.typedHint": "YYYY-MM-DD",
  "uiDate.empty": "YYYY.MM.DD or YYYYMMDD",
  "uiDate.bad.format": "Not a date · 2026.10.12 and 20261012 are read too",
  "uiDate.bad.month": "There is no month {month, number} · 2026.10.12 and 20261012 are read too",
  "uiDate.bad.day": "Month {month, number} has no day {day, number}",
  "uiDate.preset.today": "Today",
  "uiDate.preset.nextMonday": "Next Monday",
  "uiDate.preset.nextMonthFirst": "1st of next month",
};
