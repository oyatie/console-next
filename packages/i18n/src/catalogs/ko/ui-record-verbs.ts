// Korean source for `uiRecordVerbs.` ids (ui/record-verbs). Rules: the header of ../ko.ts and GUIDE.md.
// After a record exists only these three verbs are used; an applied record is never 「되돌리기」.
export const koUiRecordVerbs = {
  "uiRecordVerbs.name": "변경 · 정정 · 철회",
  "uiRecordVerbs.label": "{object}에 쓸 수 있는 동작",
  "uiRecordVerbs.verb.amend": "변경",
  "uiRecordVerbs.verb.correct": "정정",
  "uiRecordVerbs.verb.withdraw": "철회",
  "uiRecordVerbs.desc.amend": "시행 전 예약 내용을 변경합니다. 같은 기록에 남습니다.",
  "uiRecordVerbs.desc.correct": "잘못 입력한 값을 바로잡습니다. 정정 기록이 남습니다.",
  "uiRecordVerbs.desc.withdraw": "예약이나 반영을 거둡니다. 함께 거둬지는 것을 먼저 보여 줍니다.",
  "uiRecordVerbs.why.amend": "시행된 기록은 변경하지 않습니다. 새로 기록합니다.",
  "uiRecordVerbs.why.correct": "시행된 뒤에 쓸 수 있습니다.",
  "uiRecordVerbs.why.withdraw": "지금은 철회할 수 없습니다.",
  "uiRecordVerbs.button.amend": "{object} 변경",
  "uiRecordVerbs.button.correct": "{object} 정정",
  "uiRecordVerbs.button.withdraw": "{object} 철회",
  "uiRecordVerbs.cascade": "함께 거둬지는 것",
  "uiRecordVerbs.cascade.none": "함께 거둬지는 것이 없습니다.",
} as const;
