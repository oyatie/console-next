// Korean source for `uiDate.` ids (apps/web/src/ui/date): presets, the relative echo, the server
// bounds line and the weekend suggestion. `{date}`, `{min}`, `{max}` and `{next}` come preformatted.
export const koUiDate = {
  "uiDate.presets": "{label} 빠른 선택",
  "uiDate.placeholder": "YYYY. MM. DD.",
  "uiDate.calendar.open": "달력 열기",
  "uiDate.calendar.label": "날짜 선택",
  "uiDate.calendar.failed": "달력을 불러오지 못했습니다. 날짜를 직접 입력하십시오.",
  "uiDate.calendar.previous": "이전 달",
  "uiDate.calendar.next": "다음 달",
  "uiDate.disabled": "선택할 수 없는 날짜입니다.",
  "uiDate.today": "오늘",
  "uiDate.ahead": "D-{days, number}",
  "uiDate.ago": "{days, number}일 전",
  "uiDate.outOfRange": "선택할 수 있는 범위 밖의 날짜입니다.",
  "uiDate.weekend": "{day}입니다. 첫 근무일은 {next}입니다.",
  "uiDate.weekend.use": "{next}로 변경",
  "uiDate.bad.format": "날짜 형식은 YYYY. MM. DD.입니다.",
  "uiDate.bad.month": "{month, number}월은 올바르지 않습니다.",
  "uiDate.bad.day": "{month, number}월 {day, number}일은 올바르지 않습니다.",
  "uiDate.preset.today": "오늘",
  "uiDate.preset.nextMonday": "다음 주 월요일",
  "uiDate.preset.nextMonthFirst": "다음 달 1일",
} as const;
