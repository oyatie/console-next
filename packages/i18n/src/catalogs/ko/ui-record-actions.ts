// Korean source for `uiRecordActions.` ids (ui/record-actions: docs/design/record-actions.md). One verb per action.
export const koUiRecordActions = {
  "uiRecordActions.edit": "수정",
  "uiRecordActions.add": "추가",
  "uiRecordActions.of": "{field} {verb}",
  "uiRecordActions.addOf": "{object} 추가",
  "uiRecordActions.more": "{field} 더보기",
  "uiRecordActions.history": "이력",
  "uiRecordActions.end.delete": "삭제",
  "uiRecordActions.end.void": "무효화",
  "uiRecordActions.end.clear": "비움",
  "uiRecordActions.path.setup": "바로 반영 (설정 단계) · 감사 기록에 남습니다",
  "uiRecordActions.path.revision": "바로 반영 · 이력으로 남습니다",
  "uiRecordActions.path.correction": "바로 반영 · 정정 기록으로 남습니다",
  "uiRecordActions.path.approval": "결재 후 반영 · 이력으로 남습니다",
  "uiRecordActions.path.second": "다른 담당자가 확인한 뒤 반영 · 정정 기록으로 남습니다",
  "uiRecordActions.path.stepUp": "패스키 확인 뒤 반영 · 정정 기록으로 남습니다",
} as const;
