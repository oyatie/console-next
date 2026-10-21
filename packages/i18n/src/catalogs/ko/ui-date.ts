// Korean source for `uiDate.` ids (apps/web/src/ui/date): presets, the relative echo, the server
// bounds line and the weekend suggestion. `{date}`, `{min}`, `{max}` and `{next}` come preformatted.
export const koUiDate = {
  "uiDate.presets": "{label} 빠른 선택",
  "uiDate.today": "오늘",
  "uiDate.ahead": "D-{days, number}",
  "uiDate.ago": "{days, number}일 전",
  "uiDate.bounds": "선택할 수 있는 날짜 {min} ~ {max}",
  "uiDate.bounds.from": "선택할 수 있는 날짜 {min}부터",
  "uiDate.bounds.until": "선택할 수 있는 날짜 {max}까지",
  "uiDate.outOfRange": "선택할 수 있는 범위 밖의 날짜입니다.",
  "uiDate.weekend": "{day}입니다. 첫 근무일은 {next}입니다.",
  "uiDate.weekend.use": "{next}로 변경",
  "uiDate.direct": "직접",
  "uiDate.typedHint": "YYYY-MM-DD",
  "uiDate.empty": "YYYY.MM.DD 또는 YYYYMMDD",
  "uiDate.bad.format": "날짜로 읽을 수 없습니다 · 2026.10.12, 20261012 모두 받습니다",
  "uiDate.bad.month": "{month, number}월은 없습니다 · 2026.10.12, 20261012 모두 받습니다",
  "uiDate.bad.day": "{month, number}월 {day, number}일은 없습니다",
  "uiDate.preset.today": "오늘",
  "uiDate.preset.nextMonday": "다음 주 월요일",
  "uiDate.preset.nextMonthFirst": "다음 달 1일",
} as const;
