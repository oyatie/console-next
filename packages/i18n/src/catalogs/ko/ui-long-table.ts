// Korean source for `uiLongTable.` ids (ui/long-table). Rules: the header of ../ko.ts and GUIDE.md.
// Domain-free: counts use 건, or 명 when the table lists people (`unit` = "person", LongTable `countUnit`).
export const koUiLongTable = {
  "uiLongTable.name": "긴 목록 표",
  "uiLongTable.loading": "불러오는 중",
  "uiLongTable.loadingMore": "더 불러오는 중",
  "uiLongTable.selection.ids": "{unit, select, person {{count, plural, other {#명}}} other {{count, plural, other {#건}}}} 선택됨",
  "uiLongTable.selection.all": "필터와 일치하는 {unit, select, person {{count, plural, other {#명}} 선택됨{excluded, plural, =0 {} other { · 제외 #명}}} other {{count, plural, other {#건}} 선택됨{excluded, plural, =0 {} other { · 제외 #건}}}}",
  "uiLongTable.selection.selectAll": "필터와 일치하는 {unit, select, person {{total, plural, other {#명}}} other {{total, plural, other {#건}}}} 모두 선택",
  "uiLongTable.selection.clear": "선택 해제",
  "uiLongTable.selection.tooMany": "필터와 일치하는 {total, plural, other {#건}}은 한 번에 처리할 수 없어 모두 선택할 수 없습니다 (최대 {max, number}건)",
} as const;
