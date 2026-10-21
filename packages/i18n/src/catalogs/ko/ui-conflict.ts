// Korean source for `uiConflict.` ids (apps/web/src/ui/conflict): the 409 field_conflict / stale_facts
// view (design/concurrent-editing.md ME-2, ME-5, ME-7). The user's input is never dropped, and every
// field needs an explicit choice. `*.hidden` drops the actor (a covert-labelled actor is never named).
export const koUiConflict = {
  "uiConflict.field_conflict": "저장하는 동안 {count, plural, other {#개}} 항목이 바뀌었습니다. 작성한 내용은 그대로 남아 있습니다. 항목마다 쓸 값을 선택하면 저장할 수 있습니다.",
  "uiConflict.stale_facts": "확인한 뒤 {count, plural, other {#개}} 항목이 바뀌어 아무것도 반영하지 않았습니다. 바뀐 값을 보고 항목마다 쓸 값을 선택한 뒤 다시 실행하십시오.",
  "uiConflict.left": "선택할 항목 {count, plural, other {#개}} 남음",
  "uiConflict.done": "모든 항목을 골랐습니다",
  "uiConflict.mine": "내 값",
  "uiConflict.current": "현재 값",
  "uiConflict.base": "처음 불러온 값",
  "uiConflict.changedBy": "{actor}님이 {at}에 바꿈",
  "uiConflict.changedBy.hidden": "{at}에 바뀜",
  "uiConflict.choice": "{label}에 쓸 값",
  "uiConflict.useTheirs": "그 값 사용",
  "uiConflict.keepMine": "내 값 유지",
  "uiConflict.empty": "값 없음",
} as const;
