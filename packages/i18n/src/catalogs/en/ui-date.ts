import type { koUiDate } from "../ko/ui-date";

export const enUiDate: Record<keyof typeof koUiDate, string> = {
  "uiDate.presets": "Quick picks for {label}",
  "uiDate.placeholder": "MM/DD/YYYY",
  "uiDate.calendar.open": "Open calendar",
  "uiDate.calendar.label": "Choose date",
  "uiDate.calendar.previous": "Previous month",
  "uiDate.calendar.next": "Next month",
  "uiDate.disabled": "This date is unavailable.",
  "uiDate.today": "Today",
  "uiDate.ahead": "In {days, plural, one {# day} other {# days}}",
  "uiDate.ago": "{days, plural, one {# day} other {# days}} ago",
  "uiDate.outOfRange": "This date is outside the range you can pick.",
  "uiDate.weekend": "That is a {day}. The first working day is {next}.",
  "uiDate.weekend.use": "Change to {next}",
  "uiDate.bad.format": "Enter a date as MM/DD/YYYY.",
  "uiDate.bad.month": "Check the month, {month, number}.",
  "uiDate.bad.day": "Check the day, {day, number}.",
  "uiDate.preset.today": "Today",
  "uiDate.preset.nextMonday": "Next Monday",
  "uiDate.preset.nextMonthFirst": "1st of next month",
};
