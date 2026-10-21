// Korean source for `uiField.` ids (apps/web/src/ui/field): the 필수/선택 사항 marker every form label carries,
// the example prefix and the 자동 tag on server-computed values. Rules: the header of ../ko.ts.
export const koUiField = {
  "uiField.required": "필수",
  "uiField.optional": "선택 사항",
  "uiField.example": "예: {example}",
  "uiField.derived": "자동",
  "uiField.overridden": "직접 수정",
  "uiField.override": "수정",
  "uiField.override.label": "{label} 직접 수정",
  "uiField.revert": "자동 값으로 다시 계산",
} as const;
