// SPDX-License-Identifier: LicenseRef-Proprietary
import type { enGovernanceRefusals } from "../en/governance";
export const koGovernanceRefusals: Record<keyof typeof enGovernanceRefusals, string> = {
  "governance.refuse.identity_unbound": "요청자 또는 결정자의 본인 정보를 확인할 수 없어 거부했습니다. 계정 관리 권한이 있는 담당자에게 계정을 인사카드에 연결하거나 동일인 확인을 완료해 달라고 요청하십시오.",
  "governance.refuse.same_person": "요청자와 같은 사람은 결정할 수 없습니다. 해당 업무의 결정 권한이 있는 다른 사람에게 요청하십시오.",
};