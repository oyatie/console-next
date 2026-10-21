// Korean source for `uiReceipt.` ids (apps/web/src/ui/receipt): feedback after an action. Undo exists
// only for a local draft; an audited decision shows sending, then the server's record (no optimistic
// done), and a lost response is looked up again with the same request key.
export const koUiReceipt = {
  "uiReceipt.draft": "초안",
  "uiReceipt.undoApplied": "되돌리기",
  "uiReceipt.dismiss": "알림 닫기",
  "uiReceipt.undo": "실행 취소",
  "uiReceipt.sending": "서버 기록을 기다립니다 · 창을 닫아도 같은 요청 키로 이어집니다",
  "uiReceipt.recorded": "기록됨",
  "uiReceipt.checking.title": "응답을 받지 못했습니다",
  "uiReceipt.checking": "이전 요청이 이미 처리되었을 수 있습니다. 같은 요청 키로 기록된 상태를 다시 조회하는 중입니다. 다시 실행하지 마십시오.",
} as const;
