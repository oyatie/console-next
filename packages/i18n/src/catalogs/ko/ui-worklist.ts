// SPDX-License-Identifier: LicenseRef-Proprietary
import type { enUiWorklist } from "../en/ui-worklist";

export const koUiWorklist: Record<keyof typeof enUiWorklist, string> = {
  "uiWorklist.undated": "기한 없음",
  "uiWorklist.today": "오늘",
  "uiWorklist.upcoming": "앞으로",
  "uiWorklist.overdue": "기한 지남",
  "uiWorklist.schedule": "기한 일정",
  "uiWorklist.statutoryLane": "법정 기한",
  "uiWorklist.operationalLane": "그 밖의 기한",
  "uiWorklist.changes": "변경 내용",
  "uiWorklist.opinionOptional": "의견 (선택)",
  "uiWorklist.opinionRequired": "반려 또는 보완 요청 시 의견을 입력하십시오.",
  "uiWorklist.approve": "승인",
  "uiWorklist.reject": "반려",
  "uiWorklist.return": "보완 요청",
};
