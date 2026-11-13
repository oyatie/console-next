// SPDX-License-Identifier: LicenseRef-Proprietary
import type { enAccountLinkRefusals } from "../en/account_link";
export const koAccountLinkRefusals: Record<keyof typeof enAccountLinkRefusals, string> = {
  "account_link.refuse.solo_ineligible": "다른 연결 권한자가 없고 내 계정이 아직 연결되지 않은 경우에만 직접 연결할 수 있습니다. 다른 계정 관리자에게 연결을 요청하십시오.",
  "account_link.refuse.employee_taken": "이미 다른 계정에 연결된 직원입니다. 다른 직원을 선택하십시오.",
  "account_link.refuse.identity_unbound": "요청자 또는 결정자의 본인 정보를 확인할 수 없어 거부했습니다. 계정 관리 권한이 있는 담당자에게 계정을 인사카드에 연결하거나 동일인 확인을 완료해 달라고 요청하십시오.",
};
