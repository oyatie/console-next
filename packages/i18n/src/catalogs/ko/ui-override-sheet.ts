// Korean source for `uiOverrideSheet.` ids (ui/override-sheet). Rules: the header of ../ko.ts and GUIDE.md.
// 「예외 처리」 is the only purple mark; the step-up commit always reads 「패스키로 확인하고 …」.
export const koUiOverrideSheet = {
  "uiOverrideSheet.name": "예외 처리 시트",
  "uiOverrideSheet.risk.low": "위험 낮음",
  "uiOverrideSheet.risk.mid": "위험 중간",
  "uiOverrideSheet.risk.high": "위험 높음",
  "uiOverrideSheet.route": "진행 경로",
  "uiOverrideSheet.auto": "자동",
  "uiOverrideSheet.sole.passkey": "패스키로 본인 확인",
  "uiOverrideSheet.sole.passkey.meta": "이 요청에 묶임",
  "uiOverrideSheet.sole.notify": "임원·최고 관리자 {count, plural, other {#명}}에게 알림",
  "uiOverrideSheet.sole.review": "검토 대상으로 표시",
  "uiOverrideSheet.sole.review.meta": "월간 예외 검토",
  "uiOverrideSheet.stepUp": "패스키로 확인하고 {action}",
  "uiOverrideSheet.stepUp.owed": "패스키로 확인합니다",
  "uiOverrideSheet.stepUp.done": "패스키 확인됨 · {at}",
  "uiOverrideSheet.binding": "{action} · 요청 해시 {hash}",
  "uiOverrideSheet.back": "돌아가기",
  "uiOverrideSheet.reasonMissing": "예외 사유를 선택하면 누를 수 있습니다",
  "uiOverrideSheet.mark": "예외 처리",
} as const;
