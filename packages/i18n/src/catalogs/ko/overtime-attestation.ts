// SPDX-License-Identifier: LicenseRef-Proprietary
import type { enOvertimeAttestation } from "../en/overtime-attestation";

export const koOvertimeAttestation = {
  "settingsHub.attestation.title": "확인 기록",
  "settingsHub.attestation.confirmedOn": "확인일",
  "settingsHub.attestation.empty": "등록된 취업규칙 확인 기록이 없습니다.",
  "settingsHub.attestation.effect": "이 설정에는 취업규칙을 기록합니다. 근태는 기록된 근로시간으로, 급여는 가져온 금액으로 계산합니다.",
  "settingsHub.attestation.ruleReference": "취업규칙 조항",
  "settingsHub.attestation.noticeMethod": "근로자 고지 방법",
  "settingsHub.attestation.recordAction": "확인 기록 등록",
  "settingsHub.attestation.saved": "연장근로 인정 기준 확인 기록을 등록했습니다.",
} as const satisfies Record<keyof typeof enOvertimeAttestation, string>;
